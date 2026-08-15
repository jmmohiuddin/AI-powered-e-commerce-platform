import {
  bigint,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { tenantId, timestamps } from './_shared';

/**
 * OPERATIONAL TABLES
 *
 * The plumbing the money path needs: gap-free human-facing numbers, an
 * idempotency ledger, and a durable job queue. None of these are domain
 * concepts, which is why they live apart from the commerce schema — but all
 * three are load-bearing, and getting any of them wrong shows up as duplicate
 * charges or duplicate invoice numbers.
 */

/**
 * Per-tenant, per-kind counters for human-facing references.
 *
 * Why not a Postgres sequence: sequences are explicitly *not* transactional —
 * `nextval` does not roll back. A rolled-back checkout would burn order number
 * #10428 forever, leaving a gap. Tax authorities in several jurisdictions
 * require invoice numbering to be gapless and explicable, and "the transaction
 * failed" is not an explanation an auditor accepts on a missing number.
 *
 * A counter row locked with `SELECT … FOR UPDATE` inside the same transaction
 * that creates the order is gapless by construction: if the order rolls back,
 * so does the increment. The cost is serialising order creation per tenant,
 * which at any realistic order rate is not a bottleneck — and correctness here
 * is worth more than the throughput.
 */
export const counters = pgTable(
  'counters',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    /** 'order' | 'return' | 'purchase_order' | 'invoice' */
    kind: varchar('kind', { length: 32 }).notNull(),
    /** Resets per year for kinds that are numbered per year. */
    period: varchar('period', { length: 8 }).notNull().default(''),
    value: bigint('value', { mode: 'number' }).notNull().default(0),
    ...timestamps(),
  },
  (t) => [uniqueIndex('counters_key').on(t.tenantId, t.kind, t.period)],
);

/**
 * Idempotency ledger.
 *
 * A double-tapped Pay button on a flaky mobile connection must not create two
 * orders and two charges. The key is claimed *before* any work happens, in its
 * own transaction, so a concurrent duplicate hits the unique constraint and
 * loses rather than racing through in parallel.
 *
 * The stored response is what makes a retry safe rather than merely blocked:
 * the second request gets the first one's answer, which is what the client
 * needed anyway.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    key: varchar('key', { length: 128 }).notNull(),
    /** Scope, so the same key on a different operation is not a false hit. */
    operation: varchar('operation', { length: 64 }).notNull(),
    /** Hash of the request body. A key reused with different inputs is a bug. */
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    /** 'in_progress' | 'succeeded' | 'failed' */
    status: varchar('status', { length: 16 }).notNull().default('in_progress'),
    responseBody: jsonb('response_body'),
    responseStatus: smallint('response_status'),
    /** Swept after 24h — long enough for any legitimate client retry. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('idempotency_keys_key').on(t.tenantId, t.operation, t.key),
    index('idempotency_keys_sweep_idx').on(t.expiresAt),
  ],
);

/**
 * Durable job queue.
 *
 * Postgres rather than Redis or SQS, for now, and the reasoning is the same as
 * ADR-0002: one stateful system. `FOR UPDATE SKIP LOCKED` gives correct
 * multi-worker claiming without a broker, and a job that must be transactional
 * with a domain write — release these reservations *and* mark the cart
 * abandoned — can share the transaction, which is impossible across a network
 * queue.
 *
 * The ceiling is real: past a few thousand jobs a minute this becomes the
 * hottest table in the database. That is the trigger to move to SQS, and the
 * interface here is deliberately narrow enough that the swap is one file.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey(),
    /** Null for platform-wide jobs like the nightly forecast. */
    tenantId: uuid('tenant_id'),
    kind: varchar('kind', { length: 64 }).notNull(),
    payload: jsonb('payload').notNull().default({}),

    /** 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' */
    status: varchar('status', { length: 16 }).notNull().default('queued'),
    /** Claimed only when now() >= runAt. Drives both scheduling and backoff. */
    runAt: timestamp('run_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    attempts: smallint('attempts').notNull().default(0),
    maxAttempts: smallint('max_attempts').notNull().default(5),

    /**
     * Set for jobs that must not be enqueued twice — "sweep reservations" only
     * needs one pending instance however many times it is scheduled.
     */
    dedupeKey: varchar('dedupe_key', { length: 128 }),

    lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'date' }),
    lockedBy: varchar('locked_by', { length: 64 }),
    lastError: text('last_error'),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    // The claim query: queued, due, oldest first.
    index('jobs_claim_idx').on(t.status, t.runAt),
    uniqueIndex('jobs_dedupe_key').on(t.dedupeKey),
    index('jobs_tenant_idx').on(t.tenantId, t.kind),
    // Finds jobs abandoned by a worker that died mid-run.
    index('jobs_stuck_idx').on(t.status, t.lockedAt),
  ],
);

/**
 * Notification outbox.
 *
 * A row here is a message the store intends to send. It is written inside the
 * same transaction as the event that triggers it — an order is placed and its
 * confirmation is enqueued atomically — so a committed order can never fail to
 * schedule its confirmation, and a rolled-back order never sends a phantom one.
 * That is the transactional-outbox pattern, and it is the only way to make
 * "send exactly when the order really happened" true rather than usually-true.
 *
 * Sending is a *separate* step run outside any transaction, because SMTP and the
 * WhatsApp API are network calls: holding a database transaction open across a
 * two-second SMTP round trip is how a busy store runs out of connections, and
 * committing the send inside the same transaction that marks it sent means a
 * rollback after a successful send silently double-sends on retry.
 *
 * The rendered subject and body are stored, not just a template reference. A
 * message is a record of what the customer was actually told, and re-rendering
 * a template months later — after the template has been edited — would
 * reconstruct something the customer never saw. For a dispute or a compliance
 * request, the frozen copy is the point.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey(),
    /** Null for platform-level operational alerts with no owning tenant. */
    tenantId: uuid('tenant_id'),
    /** 'email' | 'whatsapp' | 'sms' */
    channel: varchar('channel', { length: 16 }).notNull(),
    /** Email address or E.164 phone, depending on channel. */
    recipient: text('recipient').notNull(),
    locale: varchar('locale', { length: 8 }).notNull().default('en-AE'),
    /** e.g. 'order.confirmation' — for analytics and re-send, not for rendering. */
    template: varchar('template', { length: 48 }).notNull(),

    /** The frozen, already-rendered copy. What the customer was actually sent. */
    subject: text('subject'),
    bodyText: text('body_text').notNull(),
    bodyHtml: text('body_html'),

    /**
     * 'pending'  — ready to send, the dispatcher will pick it up.
     * 'sending'  — claimed by a dispatcher, in flight.
     * 'sent'     — delivered to the transport.
     * 'failed'   — exhausted its attempts; a human should look.
     * 'draft'    — a marketing message awaiting human approval; never auto-sent.
     * 'suppressed' — deliberately not sent (opt-out, missing recipient).
     */
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    attempts: smallint('attempts').notNull().default(0),
    maxAttempts: smallint('max_attempts').notNull().default(3),

    provider: varchar('provider', { length: 32 }),
    providerMessageId: text('provider_message_id'),
    lastError: text('last_error'),

    /** What this message is about, for the admin timeline and dedupe. */
    referenceType: varchar('reference_type', { length: 24 }),
    referenceId: uuid('reference_id'),
    /** Unique per intended message, so a retried job never sends twice. */
    dedupeKey: varchar('dedupe_key', { length: 160 }),

    lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'date' }),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    // The dispatcher's claim query: pending, oldest first.
    index('notifications_dispatch_idx').on(t.status, t.createdAt),
    uniqueIndex('notifications_dedupe_key').on(t.dedupeKey),
    index('notifications_reference_idx').on(t.referenceType, t.referenceId),
    index('notifications_tenant_idx').on(t.tenantId, t.status),
    /**
     * The delivery-webhook lookup: find the message a bounce is about.
     *
     * `provider_message_id` is the only handle an asynchronous delivery event
     * has on the row it concerns — the provider knows its own id and nothing
     * else about us — so the bounce worker resolves every event through it (see
     * packages/commerce/src/email-events.ts). Without this index that is a
     * sequential scan of the entire outbox per bounce, on a table that only
     * ever grows.
     *
     * COLUMN ORDER IS THE WHOLE POINT, and it is the opposite of the way this
     * index reads. `provider_message_id` leads. The worker's lookup filters on
     * the message id and the tenant and never on `provider` — it has no reason
     * to, the id is already near-unique — and a btree can only be used from its
     * leading column inward. Indexed as `(provider, provider_message_id)` the
     * planner cannot use it for that query at all and falls back to a
     * sequential scan, which is the exact cost this index exists to remove.
     * Verified with EXPLAIN rather than assumed: leading with `provider` gives
     * `Seq Scan`, leading with `provider_message_id` gives `Index Scan`.
     *
     * `provider` is kept as the trailing column because two transports can mint
     * the same id string, so the pair is what is genuinely unique — but it
     * earns its place only after the selective column, not before it.
     *
     * Not a unique index: a row that was never sent has NULL here, and a
     * provider is entitled to reuse an id once its own retention has passed.
     */
    index('notifications_provider_message_idx').on(t.providerMessageId, t.provider),
  ],
);
