import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@voltix/db';
import { DomainError, money, priceChanged, validateAddress, type UaeAddress } from '@voltix/core';
import type { PaymentGateway, PaymentOutcome } from '@voltix/payments';
import { shouldCommitStock } from '@voltix/payments';
import { getCart } from './cart';
import { orderNumber } from './numbering';
import { commitReservations, releaseReservations, reserveStock } from './reservations';
import { enqueue } from './jobs';
import type { ActorContext, TenantContext, Tx } from './types';

/**
 * CHECKOUT — the money path.
 *
 * The one place where a mistake costs a customer real money, so the ordering of
 * these steps is the specification and not an implementation detail:
 *
 *   1. Claim the idempotency key      — a double-tap must not create two orders
 *   2. Recompute pricing server-side  — the client's number is never trusted
 *   3. Compare against what the shopper agreed to → 409 if it moved
 *   4. Reserve stock under row locks  — before taking money, never after
 *   5. Create the order and its lines — with immutable price/cost snapshots
 *   6. Create the payment intent      — the gateway's first involvement
 *   7. Commit or release the stock    — decided by the payment outcome
 *
 * Steps 2 and 3 are what stop a stale cached page becoming a wrong charge, and
 * step 4 before step 6 is what stops a slow gateway overselling the last unit.
 * Everything runs in one transaction: a failure anywhere unwinds the
 * reservations with it, so there is no state where stock is held for an order
 * that does not exist.
 */

export interface CheckoutRequest {
  readonly cartId: string;
  readonly idempotencyKey: string;
  /** What the shopper saw and agreed to. Compared against the recomputed total. */
  readonly expectedTotal: number;
  readonly paymentProvider: string;
  readonly email?: string;
  readonly phone: string;
  readonly shippingAddress: UaeAddress;
  readonly customerId?: string;
  readonly couponCodes?: readonly string[];
  readonly shippingCost?: number;
  readonly customerNote?: string;
  readonly channel?: 'web' | 'mobile_app' | 'whatsapp' | 'phone' | 'pos';
}

export interface CheckoutResult {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly total: number;
  readonly currency: string;
  readonly payment: PaymentOutcome;
  /** True when this call replayed a previous identical request. */
  readonly replayed: boolean;
}

export async function completeCheckout(
  tx: Tx,
  ctx: TenantContext,
  actor: ActorContext,
  request: CheckoutRequest,
  gateway: PaymentGateway,
  urls: { returnUrl: string; cancelUrl: string; webhookUrl: string },
): Promise<CheckoutResult> {
  /* ── 1. Idempotency ──────────────────────────────────────────────── */

  const requestHash = hashRequest(request);
  const replay = await claimIdempotencyKey(tx, ctx.tenantId, request.idempotencyKey, requestHash);
  if (replay) return { ...(replay as CheckoutResult), replayed: true };

  /* ── 2. Address validation, before anything expensive ────────────── */

  const address = validateAddress(request.shippingAddress);
  if (!address.valid) {
    throw new DomainError('VALIDATION_FAILED', `Undeliverable address: ${address.errors.join('; ')}`, {
      publicMessage: address.errors[0] ?? 'Please check the delivery address.',
      details: { errors: address.errors, warnings: address.warnings },
    });
  }

  /* ── 3. Authoritative pricing ────────────────────────────────────── */

  const cart = await getCart(tx, ctx, request.cartId, {
    ...(request.shippingCost != null ? { shippingCost: request.shippingCost } : {}),
    ...(request.couponCodes ? { couponCodes: request.couponCodes } : {}),
  });

  if (cart.lines.length === 0) {
    throw new DomainError('VALIDATION_FAILED', 'Cart is empty', {
      publicMessage: 'Your basket is empty.',
    });
  }
  if (cart.issues.length > 0) {
    throw new DomainError('OUT_OF_STOCK', cart.issues.join('; '), {
      publicMessage: cart.issues[0]!,
      details: { issues: cart.issues },
    });
  }

  // The check that makes a stale cached page harmless. The shopper agreed to a
  // number; if the server now computes a different one, they get told rather
  // than charged.
  if (cart.pricing.total.amount !== request.expectedTotal) {
    throw priceChanged(request.cartId, request.expectedTotal, cart.pricing.total.amount);
  }

  /* ── 4. Reserve stock, under row locks ───────────────────────────── */

  const orderId = uuidv7();
  await reserveStock(
    tx,
    ctx.tenantId,
    cart.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
    { cartId: request.cartId, orderId, paymentProvider: request.paymentProvider },
  );

  /* ── 5. Create the order ─────────────────────────────────────────── */

  const number = await orderNumber(tx, ctx.tenantId);
  const pricedById = new Map(cart.pricing.lines.map((l) => [l.id, l]));

  await tx.execute(sql`
    INSERT INTO orders (
      id, tenant_id, store_id, number, customer_id, email, phone,
      status, payment_status, fulfilment_status, channel, currency,
      subtotal, discount_total, shipping_total, tax_total, total,
      paid_total, refunded_total, cost_total,
      shipping_address, billing_address, applied_discounts,
      customer_note, placed_at, created_at, updated_at
    ) VALUES (
      ${orderId}, ${ctx.tenantId}, ${ctx.storeId ?? null}, ${number},
      ${request.customerId ?? null}, ${request.email ?? null}, ${request.phone},
      'pending', 'unpaid', 'unfulfilled', ${request.channel ?? 'web'}, ${ctx.currency},
      ${cart.pricing.subtotal.amount}, ${cart.pricing.discountTotal.amount},
      ${cart.pricing.shippingTotal.amount}, ${cart.pricing.taxTotal.amount},
      ${cart.pricing.total.amount}, 0, 0, ${cart.pricing.costTotal.amount},
      ${JSON.stringify(request.shippingAddress)}::jsonb,
      ${JSON.stringify(request.shippingAddress)}::jsonb,
      ${JSON.stringify(
        cart.pricing.appliedDiscounts.map((d) => ({
          id: d.discountId,
          code: d.code,
          name: d.name,
          amount: d.amount.amount,
        })),
      )}::jsonb,
      ${request.customerNote ?? null}, now(), now(), now()
    )
  `);

  for (const line of cart.lines) {
    const priced = pricedById.get(line.id);
    await tx.execute(sql`
      INSERT INTO order_items (
        id, tenant_id, order_id, variant_id, product_id,
        sku, title, variant_title, image_url,
        quantity, unit_price, unit_cost, discount_total, tax_total, line_total, currency,
        quantity_fulfilled, quantity_returned, quantity_refunded, created_at, updated_at
      ) VALUES (
        ${uuidv7()}, ${ctx.tenantId}, ${orderId}, ${line.variantId}, ${line.productId},
        ${line.sku}, ${line.title}, ${line.variantTitle}, ${line.imageUrl},
        ${line.quantity}, ${line.unitPrice},
        ${priced?.costTotal.amount ? Math.round(priced.costTotal.amount / line.quantity) : null},
        ${priced?.discountTotal.amount ?? 0}, ${priced?.taxTotal.amount ?? 0},
        ${priced?.lineTotal.amount ?? line.lineTotal}, ${ctx.currency},
        0, 0, 0, now(), now()
      )
    `);
  }

  await recordEvent(tx, ctx.tenantId, orderId, {
    type: 'order.placed',
    isPublic: true,
    message: `Order ${number} placed`,
    actor,
  });

  // Redeem coupons only once the order exists — the unique index on
  // (discount, order) is what enforces per-customer usage limits under
  // concurrency, rather than a read-then-check that two requests can both pass.
  for (const applied of cart.pricing.appliedDiscounts) {
    await tx.execute(sql`
      INSERT INTO discount_redemptions
        (id, tenant_id, discount_id, order_id, customer_id, amount, currency, created_at)
      VALUES (${uuidv7()}, ${ctx.tenantId}, ${applied.discountId}, ${orderId},
              ${request.customerId ?? null}, ${applied.amount.amount}, ${ctx.currency}, now())
      ON CONFLICT DO NOTHING
    `);
    await tx.execute(sql`
      UPDATE discounts SET usage_count = usage_count + 1, updated_at = now()
      WHERE id = ${applied.discountId}
    `);
  }

  /* ── 6. Payment ──────────────────────────────────────────────────── */

  const intentId = uuidv7();
  await tx.execute(sql`
    INSERT INTO payment_intents
      (id, tenant_id, order_id, customer_id, provider, amount, currency, status,
       idempotency_key, return_url, created_at, updated_at)
    VALUES (${intentId}, ${ctx.tenantId}, ${orderId}, ${request.customerId ?? null},
            ${request.paymentProvider}, ${cart.pricing.amountDue.amount}, ${ctx.currency},
            'created', ${request.idempotencyKey}, ${urls.returnUrl}, now(), now())
  `);

  const outcome = await gateway.createPayment({
    idempotencyKey: request.idempotencyKey,
    orderId,
    orderNumber: number,
    amount: money(cart.pricing.amountDue.amount, ctx.currency),
    customer: {
      ...(request.customerId ? { id: request.customerId } : {}),
      ...(request.email ? { email: request.email } : {}),
      phone: request.phone,
      name: request.shippingAddress.recipientName,
    },
    shippingAddress: request.shippingAddress as unknown as Record<string, unknown>,
    items: cart.lines.map((line) => ({
      name: line.title,
      quantity: line.quantity,
      unitPrice: money(line.unitPrice, ctx.currency),
    })),
    returnUrl: urls.returnUrl,
    cancelUrl: urls.cancelUrl,
    webhookUrl: urls.webhookUrl,
  });

  await applyPaymentOutcome(tx, ctx, orderId, intentId, outcome, actor);

  /* ── 7. Stock: commit or release ─────────────────────────────────── */

  if (shouldCommitStock(outcome)) {
    await commitReservations(tx, ctx.tenantId, { orderId });
  } else if (outcome.kind === 'failed') {
    await releaseReservations(tx, ctx.tenantId, { orderId });
  }
  // 'requires_action' and 'pending' keep the hold: the shopper is mid-payment,
  // and the TTL sweep releases it if they never come back.

  await tx.execute(sql`
    UPDATE carts SET status = 'converted', converted_order_id = ${orderId}, updated_at = now()
    WHERE id = ${request.cartId}
  `);

  // Confirmation is enqueued only for an order that is actually going ahead —
  // paid, or cash on delivery with stock committed. A 'requires_action' order
  // mid-redirect is not yet confirmed, and a 'failed' one never will be;
  // confirming either would be a message the store has to retract. Enqueued in
  // this same transaction, so the confirmation exists if and only if the order
  // commits, and the job runner sends it once the transaction lands.
  if (shouldCommitStock(outcome)) {
    await enqueue(tx, {
      kind: 'notifications.send',
      tenantId: ctx.tenantId,
      payload: { template: 'order.confirmation', orderId, locale: ctx.locale },
      dedupeKey: `order.confirmation:${orderId}`,
    });
  }

  const result: CheckoutResult = {
    orderId,
    orderNumber: number,
    total: cart.pricing.total.amount,
    currency: ctx.currency,
    payment: outcome,
    replayed: false,
  };

  await completeIdempotencyKey(tx, ctx.tenantId, request.idempotencyKey, result);
  return result;
}

/* ────────────────────────── Payment outcome ─────────────────────────── */

/**
 * Translates a gateway outcome into ledger rows and order state.
 *
 * Cash on delivery is the case worth reading twice: it returns `deferred`, so
 * the order becomes `confirmed` and stock is committed even though no money has
 * moved. That is correct — the merchant has committed to shipping, and the
 * courier's remittance later posts a `capture` transaction against this same
 * intent. Treating COD as "unpaid, do nothing" would leave the parcel unshipped.
 */
export async function applyPaymentOutcome(
  tx: Tx,
  ctx: TenantContext,
  orderId: string,
  intentId: string,
  outcome: PaymentOutcome,
  actor: ActorContext,
): Promise<void> {
  const intentStatus =
    outcome.kind === 'succeeded'
      ? 'succeeded'
      : outcome.kind === 'authorised' || outcome.kind === 'deferred'
        ? 'processing'
        : outcome.kind === 'requires_action'
          ? 'requires_action'
          : outcome.kind === 'failed'
            ? 'failed'
            : 'processing';

  await tx.execute(sql`
    UPDATE payment_intents
    SET status = ${intentStatus},
        provider_reference = ${'reference' in outcome ? outcome.reference : null},
        redirect_url = ${outcome.kind === 'requires_action' ? outcome.redirectUrl : null},
        failure_code = ${outcome.kind === 'failed' ? outcome.code : null},
        failure_message = ${outcome.kind === 'failed' ? outcome.message : null},
        succeeded_at = ${outcome.kind === 'succeeded' ? sql`now()` : sql`NULL`},
        raw = ${JSON.stringify('raw' in outcome ? (outcome.raw ?? null) : null)}::jsonb,
        updated_at = now()
    WHERE id = ${intentId}
  `);

  if (outcome.kind === 'succeeded') {
    const order = await tx.execute<{ total: number }>(sql`
      SELECT total FROM orders WHERE id = ${orderId}
    `);
    const amount = Number(order.rows[0]?.total ?? 0);

    await tx.execute(sql`
      INSERT INTO transactions
        (id, tenant_id, order_id, payment_intent_id, provider, provider_reference,
         kind, status, amount, currency, processed_at, created_at, updated_at)
      VALUES (${uuidv7()}, ${ctx.tenantId}, ${orderId}, ${intentId},
              (SELECT provider FROM payment_intents WHERE id = ${intentId}),
              ${outcome.reference}, 'capture', 'succeeded', ${amount}, ${ctx.currency},
              now(), now(), now())
      ON CONFLICT DO NOTHING
    `);

    await tx.execute(sql`
      UPDATE orders
      SET payment_status = 'paid', status = 'confirmed', paid_total = ${amount}, updated_at = now()
      WHERE id = ${orderId}
    `);
    await recordEvent(tx, ctx.tenantId, orderId, {
      type: 'payment.captured',
      isPublic: true,
      message: 'Payment received',
      actor,
    });
  } else if (outcome.kind === 'authorised') {
    await tx.execute(sql`
      UPDATE orders SET payment_status = 'authorised', status = 'confirmed', updated_at = now()
      WHERE id = ${orderId}
    `);
  } else if (outcome.kind === 'deferred') {
    await tx.execute(sql`
      UPDATE orders SET status = 'confirmed', updated_at = now() WHERE id = ${orderId}
    `);
    await recordEvent(tx, ctx.tenantId, orderId, {
      type: 'payment.deferred',
      isPublic: true,
      message: 'Cash on delivery — payment collected on delivery',
      actor,
    });
  } else if (outcome.kind === 'failed') {
    await tx.execute(sql`
      UPDATE orders SET payment_status = 'failed', updated_at = now() WHERE id = ${orderId}
    `);
    await recordEvent(tx, ctx.tenantId, orderId, {
      type: 'payment.failed',
      isPublic: false,
      message: outcome.message,
      actor,
    });
  }
}

export async function recordEvent(
  tx: Tx,
  tenantId: string,
  orderId: string,
  event: {
    type: string;
    isPublic: boolean;
    message: string;
    actor: ActorContext;
    data?: unknown;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO order_events
      (id, tenant_id, order_id, type, is_public, message, data, actor_type, actor_id, created_at)
    VALUES (${uuidv7()}, ${tenantId}, ${orderId}, ${event.type}, ${event.isPublic},
            ${event.message}, ${JSON.stringify(event.data ?? null)}::jsonb,
            ${event.actor.type}, ${event.actor.id ?? null}, now())
  `);
}

/* ───────────────────────────- Idempotency ───────────────────────────── */

/**
 * Claims the key, or returns the previous response.
 *
 * The unique index does the work: a concurrent duplicate loses the insert and
 * is told to retry rather than racing through in parallel. A key reused with
 * *different* inputs is a client bug and is rejected loudly — silently
 * returning the first response would be worse, because the caller would believe
 * their second, different request had been applied.
 */
async function claimIdempotencyKey(
  tx: Tx,
  tenantId: string,
  key: string,
  requestHash: string,
): Promise<unknown | null> {
  const existing = await tx.execute<{
    status: string;
    request_hash: string;
    response_body: unknown;
  }>(sql`
    SELECT status, request_hash, response_body FROM idempotency_keys
    WHERE tenant_id = ${tenantId} AND operation = 'checkout' AND key = ${key}
  `);

  const row = existing.rows[0];
  if (row) {
    if (row.request_hash !== requestHash) {
      throw new DomainError('CONFLICT', 'Idempotency key reused with different parameters', {
        publicMessage: 'This request conflicts with an earlier one. Please refresh and try again.',
      });
    }
    if (row.status === 'succeeded') return row.response_body;
    throw new DomainError('CONFLICT', 'A checkout with this key is already in progress', {
      publicMessage: 'Your order is being processed — please wait a moment.',
      retryable: true,
    });
  }

  await tx.execute(sql`
    INSERT INTO idempotency_keys
      (id, tenant_id, key, operation, request_hash, status, expires_at, created_at, updated_at)
    VALUES (${uuidv7()}, ${tenantId}, ${key}, 'checkout', ${requestHash}, 'in_progress',
            now() + interval '24 hours', now(), now())
  `);
  return null;
}

async function completeIdempotencyKey(
  tx: Tx,
  tenantId: string,
  key: string,
  response: unknown,
): Promise<void> {
  await tx.execute(sql`
    UPDATE idempotency_keys
    SET status = 'succeeded', response_body = ${JSON.stringify(response)}::jsonb,
        response_status = 200, updated_at = now()
    WHERE tenant_id = ${tenantId} AND operation = 'checkout' AND key = ${key}
  `);
}

/** Only the fields that change the outcome — a different note is not a different order. */
function hashRequest(request: CheckoutRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        cartId: request.cartId,
        expectedTotal: request.expectedTotal,
        provider: request.paymentProvider,
        phone: request.phone,
        address: request.shippingAddress,
      }),
    )
    .digest('hex');
}
