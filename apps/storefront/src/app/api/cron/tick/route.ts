import { timingSafeEqual } from 'node:crypto';
import { dbAdmin } from '@voltix/db';
import { runOnce, scheduleRecurring } from '@voltix/commerce';
import { buildTransportRegistry, dispatchNotifications } from '@voltix/notifications';

/**
 * THE BACKGROUND WORKER, AS A CRON-INVOKED ENDPOINT
 *
 * `npm run worker` is a long-running process, and a serverless platform has
 * nowhere to run one. Without this route the deployed store enqueues work that
 * nothing ever picks up — and the failure is silent in the worst way: checkout
 * succeeds, the order is correct, and the customer simply never receives a
 * confirmation while the stock they did not buy stays reserved until someone
 * notices the catalogue has gone out of stock.
 *
 * So the same three steps the worker loop performs are exposed as one HTTP
 * call, and a scheduler invokes it. The logic is not duplicated: this route
 * calls exactly the functions `scripts/worker.ts` calls, so the two cannot
 * drift.
 *
 * WHY THIS LIVES ON THE STOREFRONT
 * The admin sits behind an auth proxy that redirects unauthenticated requests
 * to /login — a cron request would be bounced to a login page and the job queue
 * would silently never run. The storefront has no such redirect, so there is
 * one fewer way for this to be quietly broken.
 */

export const dynamic = 'force-dynamic';

/**
 * Vercel's ceiling is 60s on Hobby. The batch limits below are sized so a pass
 * finishes well inside it: exceeding the limit kills the function mid-flight,
 * which leaves rows locked as `running` until the five-minute stale-claim sweep
 * reclaims them. Correct, but it wastes a cycle — better to do less per pass
 * and run more often.
 */
export const maxDuration = 60;

const JOB_BATCH = 25;
const NOTIFICATION_BATCH = 25;

/** Constant-time compare, so the secret cannot be recovered from response timing. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Authorises the caller.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically. The
 * same header lets an external scheduler drive this endpoint, which matters
 * because Vercel's Hobby plan only fires cron once a day — far too slow for
 * order confirmations.
 *
 * With no CRON_SECRET configured this refuses every request rather than
 * running open. An unauthenticated job runner is a free denial-of-service: it
 * hits the database on demand, from anywhere, as fast as anyone cares to ask.
 */
function authorise(request: Request): { ok: true } | { ok: false; status: number; error: string } {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return { ok: false, status: 503, error: 'CRON_SECRET is not configured — refusing to run open' };
  }

  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !secretMatches(token, expected)) {
    return { ok: false, status: 401, error: 'Unauthorised' };
  }
  return { ok: true };
}

// Built once per warm instance. SMTP pools a connection, and rebuilding the
// registry per request would reopen a socket on every tick.
const transports = buildTransportRegistry();

async function tick() {
  const started = Date.now();

  // Re-arm the recurring jobs. Dedupe keys make this idempotent, so overlapping
  // invocations cannot produce duplicates.
  await dbAdmin().transaction((tx) => scheduleRecurring(tx));

  const jobs = await runOnce(dbAdmin(), `cron-${process.env.VERCEL_REGION ?? 'local'}`, {
    limit: JOB_BATCH,
  });

  // Dispatch is deliberately after, and outside any transaction: the jobs above
  // wrote outbox rows inside theirs, and sending is a network call that must
  // never hold a database lock.
  const notifications = await dispatchNotifications(dbAdmin(), transports, {
    limit: NOTIFICATION_BATCH,
  });

  return { jobs, notifications, durationMs: Date.now() - started };
}

export async function GET(request: Request): Promise<Response> {
  const auth = authorise(request);
  if (!auth.ok) {
    return Response.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  try {
    const result = await tick();
    return Response.json({ ok: true, ...result });
  } catch (error) {
    // A failed tick must return 500 so the scheduler's own alerting sees it.
    // Swallowing it would make a permanently broken queue look healthy.
    console.error('[cron] tick failed:', error);
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'tick failed' },
      { status: 500 },
    );
  }
}

/**
 * POST behaves identically.
 *
 * Vercel Cron issues GET; most external schedulers default to POST. Accepting
 * both removes a configuration mistake that would otherwise present as a 405
 * nobody is watching for.
 */
export const POST = GET;
