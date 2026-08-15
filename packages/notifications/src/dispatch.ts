import { sql } from 'drizzle-orm';
import { uuidv7, type Database } from '@voltix/db';
import type { NotificationChannel, TransportRegistry } from './port';
import type { RenderedNotification } from './templates';

/**
 * THE OUTBOX, DISPATCHED
 *
 * Two operations, deliberately kept apart:
 *
 *   insertNotification()   — writes a row. Called inside the triggering
 *                            transaction (the checkout, the cancellation), so
 *                            the message exists if and only if the event did.
 *
 *   dispatchNotifications() — sends pending rows. Runs on its own, outside any
 *                            business transaction, because sending is a network
 *                            call and a network call inside a database
 *                            transaction holds a connection hostage across the
 *                            internet.
 *
 * The split is the whole design. It is what lets "the order committed" and "the
 * confirmation went out" both be true without either depending on the other's
 * timing, and it is why a crash between them loses nothing: the row is durable,
 * and the next dispatch pass picks it up.
 */

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface EnqueueInput {
  readonly tenantId: string | null;
  readonly channel: NotificationChannel;
  readonly recipient: string;
  readonly locale: string;
  readonly template: string;
  readonly rendered: RenderedNotification;
  readonly referenceType?: string;
  readonly referenceId?: string;
  /** Unique per intended message. A retried job with the same key never double-sends. */
  readonly dedupeKey?: string;
  /**
   * 'pending' — a transactional message, dispatched automatically.
   * 'draft'   — a marketing message, held until a human approves it.
   */
  readonly status?: 'pending' | 'draft';
  readonly maxAttempts?: number;
}

/**
 * Writes one outbox row. Idempotent on `dedupeKey`.
 *
 * `ON CONFLICT DO NOTHING` rather than an upsert: once a confirmation for an
 * order is queued, a second attempt to queue it is a no-op, not an overwrite —
 * the customer gets exactly one. Rows with no dedupe key never collide, because
 * Postgres treats each NULL as distinct in a unique index.
 */
export async function insertNotification(tx: Tx, input: EnqueueInput): Promise<void> {
  if (!input.recipient) return; // Nothing to send to — the caller resolved no address.

  await tx.execute(sql`
    INSERT INTO notifications
      (id, tenant_id, channel, recipient, locale, template, subject, body_text, body_html,
       status, max_attempts, reference_type, reference_id, dedupe_key, created_at, updated_at)
    VALUES (
      ${uuidv7()}, ${input.tenantId}, ${input.channel}, ${input.recipient}, ${input.locale},
      ${input.template}, ${input.rendered.subject}, ${input.rendered.text}, ${input.rendered.html},
      ${input.status ?? 'pending'}, ${input.maxAttempts ?? 3},
      ${input.referenceType ?? null}, ${input.referenceId ?? null}, ${input.dedupeKey ?? null},
      now(), now()
    )
    ON CONFLICT (dedupe_key) DO NOTHING
  `);
}

export interface DispatchResult {
  readonly sent: number;
  readonly failed: number;
  /** Rows with no transport for their channel — recorded, not lost. */
  readonly suppressed: number;
  /** Rows a dead worker left claimed on their final attempt, swept to 'failed'. */
  readonly abandoned: number;
}

/**
 * Exponential backoff between attempts, in seconds — the same curve the job
 * runner uses (`2^attempts * 15`, capped at an hour), for the same reason: a
 * provider that just rate-limited us is not ready again on the next tick, and
 * hammering it turns a transient 429 into a reputation problem.
 *
 * Expressed in SQL rather than TypeScript because the decision belongs in the
 * claim query — a row still inside its backoff window must not be selected at
 * all, or it is claimed, attempted, and burns an attempt for nothing.
 *
 * `attempts` is already incremented when a row is claimed, so a first failure
 * waits 30s, a second 60s, a third 120s.
 */
const BACKOFF = sql`(least(3600, 15 * power(2, attempts))::int * interval '1 second')`;

/**
 * Marks rows a worker claimed and never reported on.
 *
 * The stale-claim branch of the dispatcher reclaims a row locked as 'sending'
 * for over five minutes — but only while it has attempts left. A worker that
 * dies mid-send on the *final* attempt therefore leaves a row stuck in
 * 'sending' forever: never retried, never failed, and invisible on the admin
 * Messages screen, which surfaces 'draft' and 'failed'. That is the worst
 * outcome available — a customer who was never told, and nobody who knows.
 */
async function sweepAbandoned(db: Database): Promise<number> {
  const swept = await db.execute(sql`
    UPDATE notifications
    SET status = 'failed',
        last_error = coalesce(last_error, 'dispatcher stopped responding mid-send'),
        updated_at = now()
    WHERE status = 'sending'
      AND attempts >= max_attempts
      AND locked_at < now() - interval '5 minutes'
    RETURNING id
  `);
  return swept.rows.length;
}

/**
 * Sends one batch of pending notifications.
 *
 * The claim is one transaction (flip to 'sending', bump attempts, lock);
 * each send happens outside it; each result is recorded in its own short
 * transaction. That is the same claim / act / record shape as the job runner,
 * for the same reason — a worker that dies mid-send leaves a row locked as
 * 'sending', and the next pass reclaims anything locked longer than five
 * minutes rather than stranding it.
 */
export async function dispatchNotifications(
  db: Database,
  registry: TransportRegistry,
  options: { limit?: number } = {},
): Promise<DispatchResult> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

  const abandoned = await sweepAbandoned(db);

  const claimed = await db.transaction((tx) =>
    tx.execute<{
      id: string;
      channel: NotificationChannel;
      recipient: string;
      locale: string;
      subject: string | null;
      body_text: string;
      body_html: string | null;
      attempts: number;
      max_attempts: number;
    }>(sql`
      UPDATE notifications SET
        status = 'sending', locked_at = now(), attempts = attempts + 1, updated_at = now()
      WHERE id IN (
        SELECT id FROM notifications
        WHERE attempts < max_attempts
          AND (
            -- Never attempted, or the backoff since the last attempt has
            -- elapsed. locked_at doubles as "when we last touched this row":
            -- it is set on every claim and on every failure, so it is the
            -- honest measure of when the last attempt happened without a
            -- second column recording the same instant.
            (status = 'pending' AND (locked_at IS NULL OR locked_at < now() - ${BACKOFF}))
            OR (status = 'sending' AND locked_at < now() - interval '5 minutes')
          )
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, channel, recipient, locale, subject, body_text, body_html, attempts, max_attempts
    `),
  );

  let sent = 0;
  let failed = 0;
  let suppressed = 0;

  for (const row of claimed.rows) {
    const transport = registry.for(row.channel);

    if (!transport) {
      // No transport registered for this channel. Suppress rather than retry
      // forever — retrying cannot conjure a transport that was never configured.
      await db.execute(sql`
        UPDATE notifications
        SET status = 'suppressed', last_error = ${'no transport for channel ' + row.channel}, updated_at = now()
        WHERE id = ${row.id}
      `);
      suppressed += 1;
      continue;
    }

    const result = await transport.send({
      channel: row.channel,
      recipient: row.recipient,
      locale: row.locale,
      subject: row.subject,
      text: row.body_text,
      html: row.body_html,
    });

    if (result.ok) {
      await db.execute(sql`
        UPDATE notifications
        SET status = 'sent', sent_at = now(), provider = ${result.provider},
            provider_message_id = ${result.providerMessageId ?? null}, last_error = NULL, updated_at = now()
        WHERE id = ${row.id}
      `);
      sent += 1;
      continue;
    }

    // A permanent failure, or one that has exhausted its attempts, is done —
    // mark it failed so a human can look. A transient failure with attempts
    // left goes back to 'pending' for the next pass to retry, and `locked_at`
    // moves to now so the backoff window is measured from this failure rather
    // than from whenever the row was first claimed.
    const exhausted = result.permanent || row.attempts >= row.max_attempts;
    await db.execute(sql`
      UPDATE notifications
      SET status = ${exhausted ? 'failed' : 'pending'}, provider = ${result.provider},
          last_error = ${result.error ?? 'send failed'}, locked_at = now(), updated_at = now()
      WHERE id = ${row.id}
    `);
    failed += 1;
  }

  return { sent, failed, suppressed, abandoned };
}
