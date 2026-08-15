import { sql } from 'drizzle-orm';
import { uuidv7, type Database } from '@voltix/db';
import { sweepExpiredReservations } from './reservations';
import { handleNotificationJob } from './notifications';
import { applyEmailProviderEvent } from './email-events';
import { classifyInventoryHealth, refreshForecasts } from './analytics-jobs';
import { settlePaymentWebhookEvent } from './webhooks';
import type { Tx } from './types';

/**
 * DURABLE JOB QUEUE
 *
 * Postgres-backed, claimed with `FOR UPDATE SKIP LOCKED`. Two workers can run
 * the same query and never collide: whichever grabs a row first, the other
 * skips past it rather than blocking. That is the whole concurrency story, and
 * it needs no broker.
 *
 * The reason to use the database rather than Redis or SQS at this stage is
 * transactional composition. "Release these reservations *and* mark the cart
 * abandoned" must be atomic, and it cannot be across a network queue — the
 * queue acknowledges, the database write fails, and the work silently
 * disappears. Here they share one transaction.
 *
 * The ceiling is real. Past a few thousand jobs a minute this becomes the
 * hottest table in the system and the answer is SQS. `enqueue`/`claim`/`finish`
 * are deliberately narrow so that swap is one file.
 */

export type JobKind =
  | 'reservations.sweep'
  | 'payments.webhook'
  | 'payments.reconcile'
  | 'carts.detect_abandoned'
  | 'forecast.refresh'
  | 'inventory.classify'
  | 'notifications.send'
  | 'notifications.email_event';

export interface Job {
  readonly id: string;
  readonly tenantId: string | null;
  readonly kind: JobKind;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export interface EnqueueInput {
  kind: JobKind;
  tenantId?: string | null;
  payload?: Record<string, unknown>;
  runAt?: Date;
  maxAttempts?: number;
  /** Present ⇒ at most one job ever exists with this key. */
  dedupeKey?: string;
}

export async function enqueue(tx: Tx, job: EnqueueInput): Promise<string> {
  return (await enqueueOnce(tx, job)).id;
}

/**
 * Enqueues, and says whether the dedupe key had already claimed a job.
 *
 * The same INSERT as `enqueue`, with the one fact `enqueue` throws away: the
 * unique index on `dedupe_key` makes this an idempotency check as well as a
 * scheduling primitive, and a webhook ingress needs the answer — "I have seen
 * this delivery before" is what lets it return 200 to a redelivery without
 * doing the work a second time.
 *
 * `created` is false for a redelivery, which is ordinary provider traffic
 * rather than an error. The id is only meaningful when `created` is true; on a
 * conflict no row was written and the caller has nothing to point at.
 */
export async function enqueueOnce(
  tx: Tx,
  job: EnqueueInput,
): Promise<{ id: string; created: boolean }> {
  const id = uuidv7();
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO jobs (id, tenant_id, kind, payload, status, run_at, max_attempts,
                      dedupe_key, created_at, updated_at)
    VALUES (${id}, ${job.tenantId ?? null}, ${job.kind},
            ${JSON.stringify(job.payload ?? {})}::jsonb, 'queued',
            ${(job.runAt ?? new Date()).toISOString()}, ${job.maxAttempts ?? 5},
            ${job.dedupeKey ?? null}, now(), now())
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id
  `);
  return { id, created: inserted.rows.length > 0 };
}

/**
 * Claims up to `limit` due jobs for this worker.
 *
 * `SKIP LOCKED` is what makes horizontal scaling free. Also re-claims jobs
 * whose worker died mid-run — a row locked for more than five minutes is an
 * orphan, and without this it would sit `running` forever and the work would
 * never happen.
 */
export async function claimJobs(tx: Tx, workerId: string, limit = 10): Promise<Job[]> {
  const rows = await tx.execute<{
    id: string;
    tenant_id: string | null;
    kind: JobKind;
    payload: Record<string, unknown>;
    attempts: number;
    max_attempts: number;
  }>(sql`
    UPDATE jobs SET
      status = 'running',
      locked_at = now(),
      locked_by = ${workerId},
      attempts = attempts + 1,
      updated_at = now()
    WHERE id IN (
      SELECT id FROM jobs
      WHERE (status = 'queued' AND run_at <= now())
         OR (status = 'running' AND locked_at < now() - interval '5 minutes')
      ORDER BY run_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, tenant_id, kind, payload, attempts, max_attempts
  `);

  return rows.rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    kind: r.kind,
    payload: r.payload ?? {},
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
  }));
}

export async function completeJob(tx: Tx, jobId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE jobs SET status = 'succeeded', completed_at = now(), locked_by = NULL, updated_at = now()
    WHERE id = ${jobId}
  `);
}

/**
 * Records a failure and schedules the retry.
 *
 * Exponential backoff, and a hard stop at `maxAttempts` into a `dead` state
 * rather than retrying forever. A job that has failed five times is not going
 * to succeed on the sixth; it needs a human, and the dead-letter count is an
 * alert rather than a queue that quietly grows.
 */
export async function failJob(
  tx: Tx,
  job: Job,
  error: unknown,
  options: { retryable?: boolean } = {},
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.maxAttempts || options.retryable === false;

  if (exhausted) {
    await tx.execute(sql`
      UPDATE jobs SET status = 'dead', last_error = ${message}, locked_by = NULL, updated_at = now()
      WHERE id = ${job.id}
    `);
    return;
  }

  const backoffSeconds = Math.min(3600, 2 ** job.attempts * 15);
  await tx.execute(sql`
    UPDATE jobs
    SET status = 'queued',
        run_at = now() + (${backoffSeconds} * interval '1 second'),
        last_error = ${message},
        locked_by = NULL,
        updated_at = now()
    WHERE id = ${job.id}
  `);
}

/* ────────────────────────────- Handlers ─────────────────────────────── */

export type JobHandler = (tx: Tx, job: Job) => Promise<void>;

/**
 * The sweep that keeps the store sellable.
 *
 * Without it, one abandoned tab freezes a unit permanently and the catalogue
 * slowly stops being able to sell its own stock. Least glamorous job in the
 * system, most visible absence.
 */
const sweepReservations: JobHandler = async (tx) => {
  const released = await sweepExpiredReservations(tx, 500);
  if (released > 0) console.log(`  released ${released} expired reservation(s)`);
};

/**
 * Marks carts abandoned and queues a recovery draft.
 *
 * Two hours is chosen deliberately: long enough that someone comparing prices
 * in another tab is not chased, short enough that the message lands while the
 * intent is still live. The message itself is a *draft* — nothing is sent to a
 * customer without a human approving it.
 */
const detectAbandonedCarts: JobHandler = async (tx) => {
  const rows = await tx.execute<{ id: string; tenant_id: string }>(sql`
    UPDATE carts SET status = 'abandoned', abandoned_at = now(), updated_at = now()
    WHERE id IN (
      SELECT id FROM carts
      WHERE status = 'active'
        AND updated_at < now() - interval '2 hours'
        AND total > 0
      LIMIT 200
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, tenant_id
  `);

  for (const cart of rows.rows) {
    // Release the hold first. A cart nobody has touched in two hours must not
    // keep holding stock from a customer who is ready to buy now.
    await tx.execute(sql`
      UPDATE stock_reservations SET status = 'released', released_at = now(), updated_at = now()
      WHERE cart_id = ${cart.id} AND status = 'held'
    `);
    await enqueue(tx, {
      kind: 'notifications.send',
      tenantId: cart.tenant_id,
      payload: { template: 'cart.recovery', cartId: cart.id, requiresApproval: true },
      dedupeKey: `cart-recovery:${cart.id}`,
    });
  }

  if (rows.rows.length > 0) console.log(`  marked ${rows.rows.length} cart(s) abandoned`);
};

/**
 * Turns a received payment webhook into money and stock.
 *
 * The whole of the request handler's job was to write the event down and queue
 * this — so this is where a card or BNPL order actually becomes paid, stock
 * leaves the shelf, and the confirmation goes out. It runs one event per
 * transaction and throws on anything it cannot explain, which hands the retry
 * decision to the backoff above rather than inventing a local one.
 */
const applyPaymentWebhook: JobHandler = async (tx, job) => {
  const eventId = String(job.payload.eventId ?? '');
  if (!eventId) throw new Error('payments.webhook job carries no eventId');
  await settlePaymentWebhookEvent(tx, eventId, job.attempts);
};

/**
 * Finds payment intents that never reached a terminal state.
 *
 * Webhooks get missed — the question is only whether the system notices. An
 * intent stuck in `requires_action` for an hour is a shopper who may well have
 * paid, and without this job that order sits unfulfilled while the money sits
 * in the merchant's account.
 */
const reconcilePayments: JobHandler = async (tx) => {
  const stuck = await tx.execute<{ id: string; order_id: string; provider: string }>(sql`
    SELECT id, order_id, provider FROM payment_intents
    WHERE status IN ('created', 'requires_action', 'processing')
      AND created_at < now() - interval '1 hour'
      AND created_at > now() - interval '7 days'
    ORDER BY created_at
    LIMIT 100
  `);

  for (const intent of stuck.rows) {
    // The gateway call itself belongs to the caller, which owns the adapter
    // registry — this job flags the work rather than reaching for the network
    // from inside a database transaction.
    await enqueue(tx, {
      kind: 'notifications.send',
      payload: { template: 'ops.payment_unreconciled', intentId: intent.id, provider: intent.provider },
      dedupeKey: `reconcile:${intent.id}`,
    });
  }

  if (stuck.rows.length > 0) console.log(`  flagged ${stuck.rows.length} unreconciled payment(s)`);
};

/**
 * Applies a delivery outcome the email provider reported after the fact.
 *
 * Same division of labour as the payment webhook: the route wrote the event
 * down and returned 200, and this is where a bounce actually becomes a failed
 * message on the admin's screen or a complaint becomes withdrawn marketing
 * consent. See ./email-events.
 */
const applyEmailEvent: JobHandler = async (tx, job) => {
  await applyEmailProviderEvent(tx, job.tenantId, {
    eventType: String(job.payload.eventType ?? ''),
    providerMessageId: String(job.payload.providerMessageId ?? ''),
    ...(typeof job.payload.bounceType === 'string' ? { bounceType: job.payload.bounceType } : {}),
    ...(typeof job.payload.bounceSubType === 'string'
      ? { bounceSubType: job.payload.bounceSubType }
      : {}),
    ...(typeof job.payload.bounceMessage === 'string'
      ? { bounceMessage: job.payload.bounceMessage }
      : {}),
  });
};

export const HANDLERS: Record<JobKind, JobHandler> = {
  'reservations.sweep': sweepReservations,
  'carts.detect_abandoned': detectAbandonedCarts,
  // Enqueued by the webhook route (see ./webhooks), one job per verified event.
  'payments.webhook': applyPaymentWebhook,
  'payments.reconcile': reconcilePayments,
  // Renders the message and writes the outbox row (see ./notifications). The
  // actual send is a separate step run by the worker outside any transaction.
  'notifications.send': handleNotificationJob,
  // Enqueued by the email provider's webhook route, one job per delivery.
  'notifications.email_event': applyEmailEvent,
  // The nightly analytics pipeline. `inventory.classify` reads the same
  // forecast `forecast.refresh` writes, so it is scheduled after it.
  'forecast.refresh': (tx) => refreshForecasts(tx),
  'inventory.classify': (tx) => classifyInventoryHealth(tx),
};

/**
 * Runs one pass over the queue.
 *
 * Each job gets its own transaction, so one poisoned job cannot roll back its
 * neighbours' work. Handlers that must be atomic with a domain write simply do
 * that write inside the same `tx` they are handed.
 */
export async function runOnce(
  db: Database,
  workerId: string,
  options: { limit?: number; handlers?: Partial<Record<JobKind, JobHandler>> } = {},
): Promise<{ processed: number; failed: number }> {
  const handlers = { ...HANDLERS, ...options.handlers };
  const claimed = await db.transaction((tx) => claimJobs(tx, workerId, options.limit ?? 10));

  let processed = 0;
  let failed = 0;

  for (const job of claimed) {
    try {
      await db.transaction(async (tx) => {
        const handler = handlers[job.kind];
        if (!handler) throw new Error(`No handler registered for job kind '${job.kind}'`);
        await handler(tx, job);
        await completeJob(tx, job.id);
      });
      processed += 1;
    } catch (error) {
      failed += 1;
      // The failure is recorded in its own transaction — the one that threw is
      // already rolled back, and recording the error inside it would be lost.
      await db.transaction((tx) => failJob(tx, job, error));
      console.error(`  job ${job.kind} (${job.id}) failed:`, (error as Error).message);
    }
  }

  return { processed, failed };
}

/** Re-arms the recurring jobs. Dedupe keys keep this from piling up duplicates. */
export async function scheduleRecurring(tx: Tx): Promise<void> {
  const minute = Math.floor(Date.now() / 60_000);
  await enqueue(tx, {
    kind: 'reservations.sweep',
    dedupeKey: `sweep:${minute}`,
  });
  await enqueue(tx, {
    kind: 'carts.detect_abandoned',
    dedupeKey: `abandon:${Math.floor(minute / 15)}`,
  });
  await enqueue(tx, {
    kind: 'payments.reconcile',
    dedupeKey: `reconcile-scan:${Math.floor(minute / 15)}`,
  });

  // The analytics pair, once a day.
  //
  // Keyed on the day rather than the minute, so however often the worker ticks
  // exactly one of each is enqueued per day and the dedupe index drops the
  // rest. They scan 90 days of order history for every variant of every
  // tenant — cheap nightly, wasteful every five minutes, and nothing they
  // compute changes meaningfully within a day.
  //
  // `classify` is enqueued a minute behind `forecast` so it reads a fresh
  // forecast rather than yesterday's on the first run of a new variant.
  const day = Math.floor(minute / 1440);
  await enqueue(tx, {
    kind: 'forecast.refresh',
    dedupeKey: `forecast:${day}`,
  });
  await enqueue(tx, {
    kind: 'inventory.classify',
    dedupeKey: `classify:${day}`,
    runAt: new Date(Date.now() + 60_000),
  });
}
