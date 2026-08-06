/**
 * Background worker.
 *
 * Runs the recurring jobs the store cannot function without: releasing expired
 * stock holds, detecting abandoned carts, and flagging payments that never
 * reached a terminal state.
 *
 *   npm run worker --workspace=@voltix/commerce
 *
 * Runs as the **owner** role deliberately. Its work spans tenants — sweeping
 * every expired reservation regardless of who holds it — which is exactly the
 * narrow case `dbAdmin()` exists for. Per-tenant handlers set their own tenant
 * context inside their transaction.
 *
 * Horizontally scalable with no coordination: `FOR UPDATE SKIP LOCKED` means a
 * second worker simply picks up different rows. Run one per host and let the
 * queue balance itself.
 */
// Must be first: populates process.env from the repo-root .env before
// any module below reads a connection string at import time.
import '@voltix/config/load-env';
import { hostname } from 'node:os';
import { closeConnections, dbAdmin } from '@voltix/db';
import { buildTransportRegistry, dispatchNotifications } from '@voltix/notifications';
import { runOnce, scheduleRecurring } from '../src/jobs';

const WORKER_ID = `${hostname()}-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_MS ?? 5_000);

let running = true;
let inFlight: Promise<unknown> = Promise.resolve();

/**
 * Graceful shutdown.
 *
 * A worker killed mid-job leaves the row locked as `running`. The claim query
 * re-claims anything locked for more than five minutes, so nothing is lost —
 * but finishing the current batch first means no customer-visible work is
 * delayed by a deploy.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (!running) return;
    console.log(`\n${signal} received — finishing the current batch…`);
    running = false;
  });
}

// Built once. SMTP pools a connection; rebuilding it per tick would defeat the
// pool and reopen a socket every few seconds.
const transports = buildTransportRegistry();

async function main(): Promise<void> {
  console.log(`worker ${WORKER_ID} started (polling every ${POLL_INTERVAL_MS}ms)`);
  console.log(`  notification transports: ${transports.channels.join(', ')}`);

  while (running) {
    try {
      // Re-arm the recurring jobs. Dedupe keys make this idempotent, so every
      // worker can do it without producing duplicates.
      await dbAdmin().transaction((tx) => scheduleRecurring(tx));

      inFlight = runOnce(dbAdmin(), WORKER_ID, { limit: 20 });
      const { processed, failed } = (await inFlight) as { processed: number; failed: number };
      if (processed || failed) {
        console.log(`  processed ${processed}, failed ${failed}`);
      }

      // Sending is separate from job processing on purpose: the jobs above
      // *wrote* outbox rows inside their transactions; this sends them outside
      // any transaction, so no SMTP round trip ever holds a database lock.
      const dispatching = dispatchNotifications(dbAdmin(), transports, { limit: 20 });
      inFlight = dispatching;
      const { sent, failed: sendFailed, suppressed } = await dispatching;
      if (sent || sendFailed || suppressed) {
        console.log(`  notifications: ${sent} sent, ${sendFailed} failed, ${suppressed} suppressed`);
      }
    } catch (error) {
      // A poll failure — the database restarting, say — must not kill the
      // worker. Log, back off, keep going.
      console.error('  poll failed:', (error as Error).message);
      await sleep(POLL_INTERVAL_MS * 2);
      continue;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  await inFlight;
  await closeConnections();
  console.log('worker stopped cleanly');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Do not hold the event loop open during shutdown.
    timer.unref?.();
    if (!running) resolve();
  });
}

main().catch((error) => {
  console.error('worker crashed:', error);
  process.exitCode = 1;
});
