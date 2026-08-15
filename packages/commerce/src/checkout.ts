import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@voltix/db';
import {
  DomainError,
  isValidTrn,
  money,
  priceChanged,
  validateAddress,
  type UaeAddress,
} from '@voltix/core';
import type { PaymentGateway, PaymentOutcome } from '@voltix/payments';
import { hasEligibility, shouldCommitStock } from '@voltix/payments';
import { getCart } from './cart';
import { orderNumber } from './numbering';
import { refreshDerivedStatus } from './orders';
import { commitReservations, releaseReservations, reserveStock } from './reservations';
import { assessCheckoutRisk, recordRiskAssessment } from './risk';
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
 *   4. Score the risk and gate the payment method — before anything is held
 *   5. Reserve stock under row locks  — before taking money, never after
 *   6. Create the order and its lines — with immutable price/cost snapshots
 *   7. Create the payment intents     — the gateway's first involvement
 *   8. Commit or release the stock    — decided by the payment outcome
 *
 * Steps 2 and 3 are what stop a stale cached page becoming a wrong charge, and
 * step 5 before step 7 is what stops a slow gateway overselling the last unit.
 * Everything runs in one transaction: a failure anywhere unwinds the
 * reservations with it, so there is no state where stock is held for an order
 * that does not exist.
 *
 * STEP 4 IS THE ONE THAT WAS MISSING. Both halves of it existed and neither
 * ran: a complete risk model with no caller, and a cash-on-delivery gate that
 * accepted a risk score nothing produced. The checkout page could ask the
 * registry which methods to *display*, but display is not enforcement — a
 * replayed form post names whatever provider it likes. So the gate lives here,
 * on the money path, where it cannot be walked past.
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
  /**
   * The buyer's 15-digit Tax Registration Number, when they are buying for a
   * business.
   *
   * Optional, and deliberately so — most shoppers are consumers and a required
   * tax field on a consumer checkout costs conversion for no benefit. But when
   * it is given it changes the document the sale legally requires: a supply to
   * a registered business needs a full tax invoice carrying this number at any
   * value, and without it on the invoice the buyer cannot reclaim the input VAT.
   *
   * Stored on the order rather than the customer because the same person may
   * buy personally one week and for their company the next.
   */
  readonly recipientTrn?: string;
  readonly channel?: 'web' | 'mobile_app' | 'whatsapp' | 'phone' | 'pos';
  /**
   * Gateway the shopper chose to pay a required cash-on-delivery deposit with.
   *
   * Only meaningful alongside a deferred-settlement provider. Absent when an
   * advance is required, the checkout refuses rather than guessing which card
   * the shopper meant.
   */
  readonly advancePaymentProvider?: string;
}

export interface CheckoutResult {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly total: number;
  readonly currency: string;
  /**
   * The outcome the shopper still has to act on.
   *
   * On a split cash-on-delivery order this is the *advance*, not the cash leg:
   * the deposit may need 3-D Secure, and the cash leg never needs anything.
   */
  readonly payment: PaymentOutcome;
  /** The cash leg of a split order — the obligation the courier collects. */
  readonly codPayment?: PaymentOutcome;
  /**
   * Deposit demanded up front, in minor units. Zero on an ordinary order.
   *
   * Demanded, not collected: on a redirect card the shopper has not paid it yet
   * when this returns. `orders.paid_total` is the record of what actually
   * arrived.
   */
  readonly advanceDue?: number;
  /** What the courier must collect on delivery. Zero unless deferred. */
  readonly codDue?: number;
  readonly riskScore?: number;
  /** True when this call replayed a previous identical request. */
  readonly replayed: boolean;
}

export async function completeCheckout(
  tx: Tx,
  ctx: TenantContext,
  actor: ActorContext,
  request: CheckoutRequest,
  gateway: PaymentGateway,
  urls: {
    returnUrl: string;
    cancelUrl: string;
    webhookUrl: string;
    /**
     * Callback for the deposit leg, which is a different provider and therefore
     * a different route. Falls back to `webhookUrl`, which is right only when
     * there is no deposit.
     */
    advanceWebhookUrl?: string;
  },
  /** Charges the deposit when the cash-on-delivery gate demands one. */
  advanceGateway?: PaymentGateway,
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

  /* ── 4. Risk, and the payment-method gate ────────────────────────── */

  const risk = await assessCheckoutRisk(tx, ctx, {
    ...(request.customerId ? { customerId: request.customerId } : {}),
    phone: request.phone,
    paymentProvider: request.paymentProvider,
    orderTotal: cart.pricing.total.amount,
    shippingAddress: request.shippingAddress,
    addressWarnings: address.warnings,
    lines: cart.lines.map((line) => ({ unitPrice: line.unitPrice, quantity: line.quantity })),
  });

  /**
   * A blocked order stops here, before a single unit is held.
   *
   * The message is deliberately neutral and does not enumerate the signals.
   * Telling someone which check they tripped is a free tuning loop for the next
   * attempt; telling them nothing at all strands the far more common case, a
   * real customer caught by a proxy signal. Naming a human is the compromise
   * that serves both.
   */
  if (risk.decision === 'block') {
    throw new DomainError('RISK_BLOCKED', `Blocked by risk model: ${risk.explanation}`, {
      publicMessage:
        'We can’t complete this order online. Please contact us and we’ll sort it out with you.',
      details: { score: risk.score },
    });
  }

  /**
   * The cash-on-delivery gate, finally connected.
   *
   * The gateway owns the policy — amount ceiling, risk ceiling, refusal
   * history, phone verification — and it has owned it all along. What was
   * missing was a caller on this side of the form post, and a risk score to
   * feed it.
   */
  /**
   * `phoneVerified` is deliberately not passed.
   *
   * The gate treats an explicit `false` as an outright refusal, and this is a
   * guest storefront where nobody's phone is verified — passing the truth here
   * would switch cash on delivery off for every customer the store has. The
   * signal is not discarded: the risk model already weights an unverified phone
   * at 18 points on a COD order, which reaches this gate through the score. The
   * day a verification flow exists, this becomes a real input.
   */
  const verdict = hasEligibility(gateway)
    ? gateway.eligibility({
        orderTotal: cart.pricing.amountDue,
        customerRiskScore: risk.score,
        riskRequiresAdvance: risk.decision === 'require_advance_payment',
      })
    : null;

  if (verdict && !verdict.allowed) {
    // The reason always names the alternative — see the COD adapter. A refusal
    // that does not is an abandoned basket rather than a prepaid order.
    throw new DomainError('VALIDATION_FAILED', `COD refused: ${verdict.reason}`, {
      publicMessage: verdict.reason ?? 'That payment method is not available for this order.',
      // `codRefused` is a flag rather than something the caller infers from the
      // message, because this is the store's core business metric and a metric
      // keyed on prose splits into two series the day the copy is improved.
      details: { score: risk.score, codRefused: true, reason: verdict.reason },
    });
  }

  /**
   * The deposit, in minor units.
   *
   * Capped at the amount due: a badly-set basis-points value must not produce a
   * deposit larger than the order, which would leave the courier collecting a
   * negative amount.
   */
  const advanceDue = Math.min(verdict?.advanceRequired.amount ?? 0, cart.pricing.amountDue.amount);

  if (advanceDue > 0 && !advanceGateway) {
    throw new DomainError('ADVANCE_REQUIRED', `Advance of ${advanceDue} required`, {
      publicMessage: `This order needs ${formatMinor(advanceDue, ctx.currency)} paid now, with the rest to the courier. Choose a card or wallet for the deposit.`,
      details: { advanceDue, currency: ctx.currency },
    });
  }

  /**
   * The buyer's TRN, validated here rather than at invoice time.
   *
   * A typo'd TRN is only discovered when the business customer's accountant
   * tries to reclaim the VAT and finds the number on the invoice does not
   * exist — weeks later, when reissuing means voiding a numbered document.
   * Refusing at checkout costs one form error instead.
   *
   * Stored normalised (digits only), because customers type it with spaces and
   * an invoice must not depend on which way they did.
   */
  const rawTrn = request.recipientTrn?.trim();
  if (rawTrn && !isValidTrn(rawTrn)) {
    throw new DomainError('VALIDATION_FAILED', 'Recipient TRN is not 15 digits', {
      publicMessage: 'A Tax Registration Number is 15 digits. Check it, or leave it blank.',
    });
  }
  const normalisedTrn = rawTrn ? rawTrn.replace(/[\s-]/g, '') : null;

  /* ── 5. Reserve stock, under row locks ───────────────────────────── */

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
      id, tenant_id, store_id, number, customer_id, email, phone, recipient_trn,
      status, payment_status, fulfilment_status, channel, currency,
      subtotal, discount_total, shipping_total, tax_total, total,
      paid_total, refunded_total, cost_total,
      shipping_address, billing_address, applied_discounts,
      customer_note, placed_at, created_at, updated_at
    ) VALUES (
      ${orderId}, ${ctx.tenantId}, ${ctx.storeId ?? null}, ${number},
      ${request.customerId ?? null}, ${request.email ?? null}, ${request.phone},
      ${normalisedTrn},
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

  await recordRiskAssessment(tx, ctx, orderId, risk);

  /* ── 7. Payment ──────────────────────────────────────────────────── */

  /**
   * A split order is two intents against one order, not one intent that means
   * two things.
   *
   * The deposit and the cash are different money with different lifecycles: the
   * card leg may need 3-D Secure and settles today, the cash leg settles when a
   * courier hands over a bag of notes days later. One intent cannot carry two
   * statuses, and forcing it to is how a half-paid order ends up reported as
   * either fully paid or entirely unpaid — both wrong, in opposite directions.
   *
   * Order matters: the deposit is taken first. A shopper whose card is declined
   * must not end up with a cash obligation for the full amount, which is
   * exactly what happens if the cash leg is committed before the card is tried.
   */
  const codDue = cart.pricing.amountDue.amount - advanceDue;
  const paymentItems = cart.lines.map((line) => ({
    name: line.title,
    quantity: line.quantity,
    unitPrice: money(line.unitPrice, ctx.currency),
  }));
  const customer = {
    ...(request.customerId ? { id: request.customerId } : {}),
    ...(request.email ? { email: request.email } : {}),
    phone: request.phone,
    name: request.shippingAddress.recipientName,
  };

  let advanceOutcome: PaymentOutcome | undefined;
  let advanceIntentId: string | undefined;

  if (advanceDue > 0 && advanceGateway) {
    advanceIntentId = uuidv7();
    await createIntent(tx, ctx, {
      intentId: advanceIntentId,
      orderId,
      customerId: request.customerId,
      provider: advanceGateway.id,
      amount: advanceDue,
      // Suffixed rather than reused: the unique index is on (tenant, key), and
      // two intents sharing one key cannot both be recorded.
      idempotencyKey: `${request.idempotencyKey}-advance`,
      returnUrl: urls.returnUrl,
    });

    advanceOutcome = await advanceGateway.createPayment({
      idempotencyKey: `${request.idempotencyKey}-advance`,
      orderId,
      orderNumber: number,
      amount: money(advanceDue, ctx.currency),
      customer,
      shippingAddress: request.shippingAddress as unknown as Record<string, unknown>,
      items: paymentItems,
      returnUrl: urls.returnUrl,
      cancelUrl: urls.cancelUrl,
      webhookUrl: urls.advanceWebhookUrl ?? urls.webhookUrl,
      metadata: { leg: 'cod_advance' },
    });

    await applyPaymentOutcome(tx, ctx, orderId, advanceIntentId, advanceOutcome, actor);

    // A declined deposit ends the order here. Creating the cash leg anyway
    // would dispatch a high-risk parcel on exactly the terms the deposit
    // existed to avoid.
    if (advanceOutcome.kind === 'failed') {
      await releaseReservations(tx, ctx.tenantId, { orderId });
      const failed: CheckoutResult = {
        orderId,
        orderNumber: number,
        total: cart.pricing.total.amount,
        currency: ctx.currency,
        payment: advanceOutcome,
        advanceDue,
        codDue: 0,
        riskScore: risk.score,
        replayed: false,
      };
      await completeIdempotencyKey(tx, ctx.tenantId, request.idempotencyKey, failed);
      return failed;
    }
  }

  const intentId = uuidv7();
  await createIntent(tx, ctx, {
    intentId,
    orderId,
    customerId: request.customerId,
    provider: request.paymentProvider,
    amount: codDue,
    idempotencyKey: request.idempotencyKey,
    returnUrl: urls.returnUrl,
  });

  const outcome = await gateway.createPayment({
    idempotencyKey: request.idempotencyKey,
    orderId,
    orderNumber: number,
    amount: money(codDue, ctx.currency),
    customer,
    shippingAddress: request.shippingAddress as unknown as Record<string, unknown>,
    items: paymentItems,
    returnUrl: urls.returnUrl,
    cancelUrl: urls.cancelUrl,
    webhookUrl: urls.webhookUrl,
  });

  await applyPaymentOutcome(tx, ctx, orderId, intentId, outcome, actor);

  if (advanceDue > 0) {
    await recordEvent(tx, ctx.tenantId, orderId, {
      type: 'payment.advance_required',
      isPublic: true,
      message: `Deposit of ${formatMinor(advanceDue, ctx.currency)} taken; ${formatMinor(codDue, ctx.currency)} due to the courier`,
      actor,
      data: { advanceDue, codDue, riskScore: risk.score },
    });
  }

  /* ── 8. Stock: commit or release ─────────────────────────────────── */

  // Both legs have to be going ahead. A cash leg on its own is not a sale when
  // the deposit is still sitting in a 3-D Secure window.
  const settling = shouldCommitStock(outcome) && (!advanceOutcome || shouldCommitStock(advanceOutcome));

  if (settling) {
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
  if (settling) {
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
    // The advance is what the shopper may still have to act on; the cash leg
    // never asks them for anything at this point.
    payment: advanceOutcome ?? outcome,
    ...(advanceOutcome ? { codPayment: outcome } : {}),
    advanceDue,
    codDue,
    riskScore: risk.score,
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
    /**
     * The capture is for the INTENT's amount, not the order's total.
     *
     * They are the same number on an ordinary order and deliberately different
     * on a split one, where a deposit intent settles for a fraction of the
     * order. Writing the order total here — which this did — reported a 20%
     * deposit as payment in full and left the courier with nothing to collect.
     *
     * `refreshDerivedStatus` then recomputes `payment_status` and `paid_total`
     * from the ledger, which is what turns two partial captures into
     * `partially_paid` and then `paid` without either leg needing to know the
     * other exists.
     */
    const intent = await tx.execute<{ amount: number }>(sql`
      SELECT amount FROM payment_intents WHERE id = ${intentId}
    `);
    const amount = Number(intent.rows[0]?.amount ?? 0);

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
      UPDATE orders SET status = 'confirmed', updated_at = now() WHERE id = ${orderId}
    `);
    await refreshDerivedStatus(tx, ctx, orderId);

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

/* ─────────────────────────────── Helpers ────────────────────────────── */

async function createIntent(
  tx: Tx,
  ctx: TenantContext,
  input: {
    intentId: string;
    orderId: string;
    customerId?: string;
    provider: string;
    amount: number;
    idempotencyKey: string;
    returnUrl: string;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO payment_intents
      (id, tenant_id, order_id, customer_id, provider, amount, currency, status,
       idempotency_key, return_url, created_at, updated_at)
    VALUES (${input.intentId}, ${ctx.tenantId}, ${input.orderId}, ${input.customerId ?? null},
            ${input.provider}, ${input.amount}, ${ctx.currency},
            'created', ${input.idempotencyKey}, ${input.returnUrl}, now(), now())
  `);
}

/**
 * Minor units to a readable amount, for a message the shopper will see.
 *
 * Not `formatPrice` from @voltix/ui: that is a React-facing module and the
 * domain does not depend on the presentation layer. Two decimal places and the
 * code is the right amount of formatting for an error string — the storefront
 * localises anything it renders itself.
 */
function formatMinor(amount: number, currency: string): string {
  return `${currency} ${(amount / 100).toFixed(2)}`;
}

/** Only the fields that change the outcome — a different note is not a different order. */
function hashRequest(request: CheckoutRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        cartId: request.cartId,
        expectedTotal: request.expectedTotal,
        provider: request.paymentProvider,
        // A deposit paid on a different card is a different order, and a replay
        // that silently reuses the first one would charge the wrong card.
        advanceProvider: request.advancePaymentProvider ?? null,
        phone: request.phone,
        address: request.shippingAddress,
      }),
    )
    .digest('hex');
}
