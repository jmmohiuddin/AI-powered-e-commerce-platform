import { sql } from 'drizzle-orm';
import { uuidv7 } from '@voltix/db';
import { outcomeFromStatus, shouldCommitStock, type PaymentOutcome } from '@voltix/payments';
import { applyPaymentOutcome, recordEvent } from './checkout';
import { enqueue } from './jobs';
import { commitReservations, releaseReservations } from './reservations';
import type { ActorContext, TenantContext, Tx } from './types';

/**
 * INBOUND PAYMENT EVENTS — how a redirect payment reaches a terminal state.
 *
 * `completeCheckout` can only ever finish the payments that complete inline.
 * A card or BNPL shopper leaves for a hosted page, and the answer comes back
 * later on one of two paths: the gateway's server-to-server webhook, or the
 * shopper's own browser landing on the return URL. Both arrive here, and both
 * end in the same `settlePayment` — because two code paths that decide
 * independently whether an order is paid will eventually disagree, and the
 * disagreement is discovered as a parcel shipped against a payment that failed.
 *
 * THE SPLIT BETWEEN INGRESS AND WORK, and why it is not an optimisation:
 *
 * `recordPaymentWebhookEvent` writes the event and enqueues a job. That is all
 * the request handler does. Gateways time out an unacknowledged webhook in
 * seconds and then retry, so a handler that reserves stock and writes a ledger
 * inside the request is a handler that gets abandoned mid-transaction and
 * redelivered — repeatedly, under exactly the load that made it slow. Writing a
 * row and returning 200 takes a millisecond and cannot be retried into a mess,
 * because the unique index on (provider, provider_event_id) makes the second
 * delivery a no-op.
 */

/**
 * What the ingress persists for the worker.
 *
 * Deliberately the *verified* view rather than the untouched request body. Every
 * adapter's `verifyWebhook` already resolves the event against the gateway —
 * Tabby and N-Genius literally re-fetch the payment before answering — so this
 * is the authoritative reading of the event, and `raw` keeps the gateway's own
 * payload beside it for forensics. The alternative, storing only the body,
 * would force the worker to know how to parse every provider's JSON, which is
 * precisely the knowledge the gateway port exists to keep out of the domain.
 */
export interface PaymentWebhookEnvelope {
  readonly status?: 'succeeded' | 'failed' | 'refunded' | 'cancelled' | 'pending';
  readonly paymentReference?: string;
  /** Minor units, as the gateway reported them. Recorded, never used as the amount. */
  readonly amount?: { readonly amount: number; readonly currency: string };
  readonly raw: unknown;
}

export interface InboundPaymentWebhook {
  readonly provider: string;
  /** The gateway's own event id. The idempotency key for the whole pipeline. */
  readonly eventId: string;
  readonly eventType: string;
  readonly signatureVerified: boolean;
  readonly envelope: PaymentWebhookEnvelope;
}

const WEBHOOK_ACTOR: ActorContext = { type: 'system', label: 'payment-webhook' };

/**
 * Records an inbound event and queues the work.
 *
 * A rejected signature is recorded too, and stamped `processed_at` so no worker
 * ever picks it up. Discarding it silently would throw away the only evidence
 * that someone is posting forged payment notifications at the store, and that
 * is a thing an operator needs to be able to see.
 */
export async function recordPaymentWebhookEvent(
  tx: Tx,
  ctx: TenantContext,
  event: InboundPaymentWebhook,
): Promise<{ duplicate: boolean }> {
  const id = uuidv7();

  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO payment_webhook_events
      (id, tenant_id, provider, provider_event_id, event_type, signature_verified,
       payload, processed_at, processing_error, attempts, created_at, updated_at)
    VALUES (${id}, ${ctx.tenantId}, ${event.provider}, ${event.eventId}, ${event.eventType},
            ${event.signatureVerified}, ${JSON.stringify(event.envelope)}::jsonb,
            ${event.signatureVerified ? null : sql`now()`},
            ${event.signatureVerified ? null : 'signature verification failed'},
            0, now(), now())
    ON CONFLICT (provider, provider_event_id) DO NOTHING
    RETURNING id
  `);

  // No row back means this event is already recorded — a redelivery, which is
  // normal traffic rather than an error. The first delivery already queued the
  // work, so there is nothing left to do but let the caller answer 200.
  if (inserted.rows.length === 0) return { duplicate: true };
  if (!event.signatureVerified) return { duplicate: false };

  await enqueue(tx, {
    kind: 'payments.webhook',
    tenantId: ctx.tenantId,
    payload: { eventId: id },
    // Keyed on the gateway's event id rather than the row id, so a replay of
    // the same event can never produce a second job even if the row is
    // recreated by hand during an incident.
    dedupeKey: `payment-webhook:${event.provider}:${event.eventId}`,
  });

  return { duplicate: false };
}

/**
 * Applies a verified event to the order it belongs to.
 *
 * Called by the `payments.webhook` job handler, one event per transaction. A
 * throw here is the right response to anything unexpected: the job queue's
 * backoff retries it, and five failures dead-letter it for a human. The
 * tempting alternative — swallow the error and stamp the event processed — is
 * how a paid order stays unfulfilled with nothing anywhere saying why.
 */
export async function settlePaymentWebhookEvent(
  tx: Tx,
  eventId: string,
  attempt: number,
): Promise<void> {
  const events = await tx.execute<{
    id: string;
    tenant_id: string;
    provider: string;
    payload: PaymentWebhookEnvelope;
  }>(sql`
    SELECT id, tenant_id, provider, payload
    FROM payment_webhook_events
    WHERE id = ${eventId} AND signature_verified AND processed_at IS NULL
    FOR UPDATE
  `);

  // Already applied, or never verified. Either way this job has nothing to do,
  // and the row lock above is what stops two workers applying it at once.
  const event = events.rows[0];
  if (!event) return;

  const envelope = event.payload;
  const reference = envelope.paymentReference;
  if (!reference) {
    throw new Error(`Webhook event ${eventId} carries no payment reference`);
  }

  const intents = await tx.execute<{
    id: string;
    order_id: string;
    currency: string;
    status: string;
  }>(sql`
    SELECT id, order_id, currency, status
    FROM payment_intents
    WHERE tenant_id = ${event.tenant_id}
      AND provider = ${event.provider}
      AND provider_reference = ${reference}
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `);

  const intent = intents.rows[0];
  if (!intent || !intent.order_id) {
    throw new Error(
      `No payment intent for ${event.provider} reference '${reference}' (event ${eventId})`,
    );
  }

  const ctx = await tenantContextFor(tx, event.tenant_id, intent.currency);
  const outcome = outcomeFor(envelope, reference);

  if (!outcome) {
    // A refund notification. The money going back is `refundOrder`'s ledger
    // entry to write, and restating the original payment from here would
    // double-count it.
    await stampProcessed(tx, event.id, attempt, 'refund events are applied by the refund flow');
    return;
  }

  /**
   * Gateways deliver out of order and retry old events for hours.
   *
   * Once an intent has succeeded, a late `failed` or `pending` event is stale
   * news, and acting on it would release stock the store has already been paid
   * for and mark a paid order unpaid.
   */
  if (intent.status === 'succeeded' && outcome.kind !== 'succeeded') {
    await stampProcessed(tx, event.id, attempt, 'ignored: intent already succeeded');
    return;
  }

  await settlePayment(
    tx,
    ctx,
    WEBHOOK_ACTOR,
    { orderId: intent.order_id, intentId: intent.id },
    outcome,
  );
  await stampProcessed(tx, event.id, attempt, null);
}

/**
 * Applies a payment outcome that arrived *after* checkout finished, and moves
 * the stock with it.
 *
 * This is step 7 of `completeCheckout` replayed at the moment the answer
 * actually arrives. A redirect payment leaves checkout as `requires_action`
 * with the reservation held and nothing committed; this is where that hold
 * becomes either a sale or shelf stock again.
 *
 * Shared by the webhook worker and the shopper's return page on purpose. They
 * race each other constantly — a shopper's browser is often faster than a
 * gateway's callback queue — and both being this function is what makes the
 * race harmless.
 */
export async function settlePayment(
  tx: Tx,
  ctx: TenantContext,
  actor: ActorContext,
  target: { orderId: string; intentId: string },
  outcome: PaymentOutcome,
): Promise<void> {
  await applyPaymentOutcome(tx, ctx, target.orderId, target.intentId, outcome, actor);

  if (shouldCommitStock(outcome)) {
    await commitReservations(tx, ctx.tenantId, { orderId: target.orderId });

    // The confirmation checkout deliberately did not send. It skips
    // `requires_action` because an order mid-redirect is not yet confirmed —
    // this is the point at which it becomes one. The dedupe key is the same one
    // checkout uses, so an inline payment that already confirmed cannot be
    // confirmed twice.
    await enqueue(tx, {
      kind: 'notifications.send',
      tenantId: ctx.tenantId,
      payload: { template: 'order.confirmation', orderId: target.orderId, locale: ctx.locale },
      dedupeKey: `order.confirmation:${target.orderId}`,
    });
  } else if (outcome.kind === 'failed') {
    await releaseReservations(tx, ctx.tenantId, { orderId: target.orderId });

    /**
     * Give the shopper their basket back.
     *
     * Checkout marked the cart converted on the way out. If it stays that way
     * after a declined card, "try another payment method" lands the shopper on
     * an empty basket and the sale is lost to a bookkeeping detail. The order
     * remains as the record of the attempt; a retry places a new one, which is
     * what the ledger should show.
     *
     * `converted_order_id` is deliberately left pointing at the failed order.
     * It is how the return page finds what happened when the shopper reloads,
     * and the next checkout overwrites it anyway.
     */
    await tx.execute(sql`
      UPDATE carts
      SET status = 'active', updated_at = now()
      WHERE tenant_id = ${ctx.tenantId}
        AND converted_order_id = ${target.orderId}
        AND status = 'converted'
    `);

    await recordEvent(tx, ctx.tenantId, target.orderId, {
      type: 'payment.abandoned',
      isPublic: false,
      message: 'Stock released and basket restored after a failed payment',
      actor,
    });
  }
  // 'pending' and 'requires_action' change nothing: the shopper is still
  // mid-payment and the TTL sweep releases the hold if they never come back.
}

/* ────────────────────────── The shopper's return ─────────────────────── */

export interface CheckoutReturn {
  readonly orderId: string;
  readonly orderNumber: string;
  /** The phone the order was placed with — the confirmation page's second factor. */
  readonly phone: string;
  readonly paymentStatus: string;
  readonly intentId: string | null;
  readonly provider: string | null;
  readonly providerReference: string | null;
  readonly intentStatus: string | null;
}

/**
 * The order this browser just came back from paying for.
 *
 * Found through the cart cookie rather than anything in the return URL. The
 * gateway appends its own parameters on the way back — `?ref=`, `?payment_id=`,
 * `?redirect_status=succeeded` — and every one of them is a value the shopper
 * can type themselves. Resolving the order from an httpOnly session cookie and
 * then asking the gateway what really happened is the only version of this that
 * cannot be talked into confirming an unpaid order.
 */
export async function checkoutReturnState(
  tx: Tx,
  ctx: TenantContext,
  sessionToken: string,
): Promise<CheckoutReturn | null> {
  if (!sessionToken) return null;

  const rows = await tx.execute<{
    order_id: string;
    number: string;
    phone: string;
    payment_status: string;
    intent_id: string | null;
    provider: string | null;
    provider_reference: string | null;
    intent_status: string | null;
  }>(sql`
    SELECT o.id AS order_id, o.number, o.phone, o.payment_status,
           pi.id AS intent_id, pi.provider, pi.provider_reference,
           pi.status AS intent_status
    FROM carts c
    JOIN orders o ON o.id = c.converted_order_id
    LEFT JOIN LATERAL (
      SELECT id, provider, provider_reference, status FROM payment_intents
      WHERE order_id = o.id
      -- The leg the shopper was just redirected for. A cash-on-delivery order
      -- with a deposit has two intents written in the same transaction, so
      -- created_at cannot separate them, and the cash leg is the one that
      -- never sends anybody anywhere.
      ORDER BY (provider <> 'cod') DESC, created_at DESC, id DESC
      LIMIT 1
    ) pi ON true
    WHERE c.tenant_id = ${ctx.tenantId}
      AND c.session_token = ${sessionToken}
      AND c.converted_order_id IS NOT NULL
    ORDER BY c.updated_at DESC
    LIMIT 1
  `);

  const row = rows.rows[0];
  if (!row) return null;

  return {
    orderId: row.order_id,
    orderNumber: row.number,
    phone: row.phone,
    paymentStatus: row.payment_status,
    intentId: row.intent_id,
    provider: row.provider,
    providerReference: row.provider_reference,
    intentStatus: row.intent_status,
  };
}

/* ─────────────────────────────── Internals ──────────────────────────── */

function outcomeFor(envelope: PaymentWebhookEnvelope, reference: string): PaymentOutcome | null {
  // An event with no status at all is one the adapter could not classify. It is
  // not evidence of payment, so it is treated as still in flight rather than
  // guessed at.
  if (!envelope.status) return { kind: 'pending', reference, raw: envelope.raw };
  return outcomeFromStatus(envelope.status, reference, envelope.raw);
}

async function stampProcessed(
  tx: Tx,
  eventId: string,
  attempt: number,
  note: string | null,
): Promise<void> {
  await tx.execute(sql`
    UPDATE payment_webhook_events
    SET processed_at = now(), attempts = ${attempt}, processing_error = ${note}, updated_at = now()
    WHERE id = ${eventId}
  `);
}

/**
 * Rebuilds the tenant context the worker needs.
 *
 * The job runner has no request behind it, so there is no session to read this
 * from. The currency comes from the payment intent rather than the tenant
 * default: an order placed in USD must not settle into an AED ledger row
 * because the tenant happens to sell mostly in dirhams.
 */
async function tenantContextFor(
  tx: Tx,
  tenantId: string,
  currency: string,
): Promise<TenantContext> {
  const rows = await tx.execute<{
    default_currency: string;
    default_locale: string;
    vat_rate_bps: number;
    prices_include_vat: boolean;
  }>(sql`
    SELECT default_currency, default_locale, vat_rate_bps, prices_include_vat
    FROM tenants WHERE id = ${tenantId}
  `);

  const row = rows.rows[0];
  if (!row) throw new Error(`Tenant ${tenantId} not found`);

  return {
    tenantId,
    currency: currency || row.default_currency,
    locale: row.default_locale,
    vatRateBps: Number(row.vat_rate_bps),
    pricesIncludeVat: row.prices_include_vat,
  };
}
