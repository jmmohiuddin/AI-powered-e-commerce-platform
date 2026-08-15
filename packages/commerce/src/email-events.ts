import { sql } from 'drizzle-orm';
import { isHardBounce, type EmailProviderEvent } from '@voltix/notifications';
import { enqueueOnce } from './jobs';
import type { TenantContext, Tx } from './types';

/**
 * ASYNCHRONOUS DELIVERY OUTCOMES.
 *
 * The outbox marks a row 'sent' when the transport accepts the message, which
 * is the last thing the store can observe on its own. Everything after that —
 * the recipient's server rejecting it, the recipient marking it spam — arrives
 * minutes later on a webhook or not at all. Without this path a customer who
 * never got their order confirmation is indistinguishable, on every admin
 * screen, from one who read it twice.
 *
 * THE SHAPE IS THE PAYMENT WEBHOOK'S, ON PURPOSE.
 *
 *   ingress  — verify the signature on the raw bytes, write the delivery down
 *              idempotently, return 200. Nothing else.
 *   worker   — apply it to the notification row, one event per transaction.
 *
 * That split is not an optimisation. Providers abandon a slow webhook in
 * seconds and redeliver, so work done inline is work that gets interrupted and
 * repeated under exactly the load that made it slow.
 *
 * WHY THE JOB ROW IS THE IDEMPOTENCY RECORD, AND NOT A NEW TABLE.
 *
 * The payment path has `payment_webhook_events` because it needs somewhere to
 * keep *unverified* events as evidence that someone is forging payment
 * notifications, and because its `provider` column is a payment-gateway enum
 * that has no room for an email provider. Neither applies here: a forged bounce
 * buys an attacker nothing but a wrongly-flagged message, and `jobs.dedupe_key`
 * is already a unique index — an insert-on-conflict against it gives exactly the
 * "seen this delivery before" guarantee at the cost of no migration at all. The
 * key is Svix's message id, which is covered by the signature, so a redelivery
 * and a replay both land on the same row.
 */

export const EMAIL_EVENT_JOB_KIND = 'notifications.email_event' as const;

/**
 * Records a verified event and queues the work.
 *
 * Returns `duplicate` for a redelivery so the route can answer 200 without
 * pretending it did something. The payload deliberately carries no email
 * address — see `EmailProviderEvent`; the worker resolves the recipient from
 * the notification row it is about to update.
 */
export async function recordEmailProviderEvent(
  tx: Tx,
  ctx: TenantContext,
  provider: string,
  deliveryId: string,
  event: EmailProviderEvent,
): Promise<{ duplicate: boolean }> {
  const { created } = await enqueueOnce(tx, {
    kind: EMAIL_EVENT_JOB_KIND,
    tenantId: ctx.tenantId,
    payload: {
      provider,
      eventType: event.type,
      providerMessageId: event.providerMessageId,
      ...(event.bounceType ? { bounceType: event.bounceType } : {}),
      ...(event.bounceSubType ? { bounceSubType: event.bounceSubType } : {}),
      ...(event.bounceMessage ? { bounceMessage: event.bounceMessage } : {}),
    },
    dedupeKey: `email-webhook:${provider}:${deliveryId}`,
  });

  return { duplicate: !created };
}

/**
 * Applies one delivery outcome. Called by the job handler, inside its
 * transaction.
 *
 * Every branch is idempotent, because a provider that has already been answered
 * 200 can still redeliver, and a job that fails after a partial write is
 * retried from the top.
 */
export async function applyEmailProviderEvent(
  tx: Tx,
  tenantId: string | null,
  event: {
    eventType: string;
    providerMessageId: string;
    bounceType?: string;
    bounceSubType?: string;
    bounceMessage?: string;
  },
): Promise<void> {
  if (!event.providerMessageId) {
    throw new Error('email event job carries no provider message id');
  }

  const rows = await tx.execute<{ id: string; recipient: string; status: string }>(sql`
    SELECT id, recipient, status FROM notifications
    WHERE provider_message_id = ${event.providerMessageId}
      ${tenantId ? sql`AND tenant_id = ${tenantId}` : sql``}
    LIMIT 1
  `);

  const notification = rows.rows[0];

  /**
   * Not an error, and specifically not a throw.
   *
   * A provider can send events for mail this store did not put in its outbox —
   * a test from the dashboard, a message sent before this path existed, or one
   * whose row has since been pruned. Throwing would retry it five times and
   * then dead-letter it, which turns somebody else's housekeeping into an alert
   * a human has to dismiss.
   */
  if (!notification) {
    console.warn(
      `[email-webhook] ${event.eventType} for unknown provider message ${event.providerMessageId}`,
    );
    return;
  }

  switch (event.eventType) {
    case 'email.bounced': {
      if (!isHardBounce(event.bounceType)) {
        /**
         * A deferral, not a rejection. The provider may still deliver it, so
         * the status is left alone — but the reason is recorded, because a row
         * that says 'sent' with no note is how a soft bounce that later becomes
         * a hard one arrives as a surprise.
         */
        await tx.execute(sql`
          UPDATE notifications
          SET last_error = ${describeBounce(event, 'deferred')}, updated_at = now()
          WHERE id = ${notification.id}
        `);
        return;
      }

      /**
       * A hard bounce. `failed` is the status the admin Messages screen surfaces
       * alongside drafts, which is the whole point of writing it: the customer
       * did not get their confirmation, and this is the only place anybody
       * finds out.
       *
       * `attempts` is left alone. The message was not attempted again; it was
       * delivered to a mailbox that refused it, and inflating the attempt count
       * would make the dispatcher's own retry history unreadable.
       */
      await tx.execute(sql`
        UPDATE notifications
        SET status = 'failed', last_error = ${describeBounce(event, 'bounced')}, updated_at = now()
        WHERE id = ${notification.id}
      `);
      return;
    }

    case 'email.complained': {
      /**
       * A spam complaint. The message WAS delivered — the recipient read enough
       * of it to press a button — so the row keeps its 'sent' status. What
       * changes is consent.
       *
       * SUPPRESS MARKETING, NEVER TRANSACTIONAL. This flips
       * `accepts_marketing_email`, which is the flag `cart.recovery` already
       * consults, and touches nothing on the transactional path. A shop that
       * stopped confirming orders because someone once hit "spam" would have
       * turned a marketing complaint into a customer with no receipt and no
       * tracking link — worse for the customer than the thing they complained
       * about, and in the UAE a consumer-protection problem of its own.
       *
       * Matched case-insensitively because mailbox names are compared that way
       * in practice and the address on the row is whatever the customer typed.
       */
      if (!tenantId) {
        // Consent belongs to a customer, and a customer belongs to a tenant.
        // Withdrawing it unscoped would reach across every store on the
        // platform, so a tenantless job records the complaint and stops.
        console.warn('[email-webhook] complaint on a tenantless message — consent not changed');
        return;
      }

      const suppressed = await tx.execute<{ id: string }>(sql`
        UPDATE customers
        SET accepts_marketing_email = false, updated_at = now()
        WHERE tenant_id = ${tenantId}
          AND lower(email) = lower(${notification.recipient})
          AND accepts_marketing_email
        RETURNING id
      `);

      if (suppressed.rows.length === 0) {
        // Either there is no customer record behind this address, or marketing
        // was already off. Both are fine; neither is worth an alert.
        console.info('[email-webhook] complaint recorded, no marketing consent to withdraw');
      }
      return;
    }

    default:
      // Unreachable from the route, which only enqueues what it recognises.
      // Reached only if a new event type is enqueued without a branch here, and
      // a throw routes that through the dead-letter path where it is visible.
      throw new Error(`Unhandled email provider event: ${event.eventType}`);
  }
}

/**
 * The sentence an operator reads on the Messages screen.
 *
 * Built from the provider's classification first and its prose second: the
 * classification is stable and greppable, the prose is whatever the receiving
 * mail server felt like saying. Both are worth having — "Permanent/Suppressed"
 * says what to do, the message says why.
 */
function describeBounce(
  event: { bounceType?: string; bounceSubType?: string; bounceMessage?: string },
  outcome: 'bounced' | 'deferred',
): string {
  const classification = [event.bounceType, event.bounceSubType].filter(Boolean).join('/');
  return [
    outcome === 'bounced' ? 'Hard bounce' : 'Soft bounce (delivery deferred)',
    classification || 'unclassified',
    event.bounceMessage,
  ]
    .filter(Boolean)
    .join(' — ');
}
