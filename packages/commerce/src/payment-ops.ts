import { sql } from 'drizzle-orm';
import { uuidv7 } from '@voltix/db';
import {
  canRefund,
  DomainError,
  money,
  type FulfilmentStatus,
  type OrderStatus,
  type PaymentStatus,
} from '@voltix/core';
import type { PaymentGateway } from '@voltix/payments';
import { recordEvent } from './checkout';
import { refreshDerivedStatus } from './orders';
import type { ActorContext, TenantContext, Tx } from './types';

/**
 * ADMIN-SIDE PAYMENT OPERATIONS
 *
 * Two flows the storefront never touches: recording that cash-on-delivery money
 * actually arrived, and giving money back. Both end in `refreshDerivedStatus`,
 * which recomputes the order's payment status from the transaction ledger —
 * the ledger is the source of truth and the status column is a cache over it,
 * so these functions write ledger rows and never set `payment_status` directly.
 *
 * Money amounts are integer minor units (fils) throughout, like everywhere
 * else. The one place a decimal string exists is the admin's form input, and
 * converting it is the UI's job, not this module's.
 */

interface OrderPaymentSnapshot {
  readonly id: string;
  readonly number: string;
  readonly status: string;
  readonly paymentStatus: string;
  readonly fulfilmentStatus: string;
  readonly total: number;
  readonly paidTotal: number;
  readonly refundedTotal: number;
  readonly currency: string;
  readonly provider: string | null;
  readonly intentId: string | null;
  readonly providerReference: string | null;
}

/** Locks the order row and returns the payment-relevant facts. */
async function snapshotForUpdate(
  tx: Tx,
  tenantId: string,
  orderId: string,
): Promise<OrderPaymentSnapshot> {
  const rows = await tx.execute<{
    id: string;
    number: string;
    status: string;
    payment_status: string;
    fulfilment_status: string;
    total: string;
    paid_total: string;
    refunded_total: string;
    currency: string;
    provider: string | null;
    intent_id: string | null;
    provider_reference: string | null;
  }>(sql`
    SELECT o.id, o.number, o.status, o.payment_status, o.fulfilment_status,
           o.total, o.paid_total, o.refunded_total, o.currency,
           pi.provider, pi.id AS intent_id, pi.provider_reference
    FROM orders o
    LEFT JOIN LATERAL (
      SELECT id, provider, provider_reference FROM payment_intents
      WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1
    ) pi ON true
    WHERE o.tenant_id = ${tenantId} AND o.id = ${orderId}
    FOR UPDATE OF o
  `);
  const row = rows.rows[0];
  if (!row) throw new DomainError('NOT_FOUND', `Order ${orderId} not found`);
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    paymentStatus: row.payment_status,
    fulfilmentStatus: row.fulfilment_status,
    total: Number(row.total),
    paidTotal: Number(row.paid_total),
    refundedTotal: Number(row.refunded_total),
    currency: row.currency,
    provider: row.provider,
    intentId: row.intent_id,
    providerReference: row.provider_reference,
  };
}

/**
 * Records that cash-on-delivery money was collected.
 *
 * This is bookkeeping, not a gateway call — the courier already has the cash.
 * What matters is that it goes through the ledger: a `capture` transaction row,
 * then a recompute. Setting `payment_status = 'paid'` directly would leave a
 * paid order with no transaction behind it, which is the exact drift
 * `refreshDerivedStatus` exists to make impossible.
 *
 * The amount is always the outstanding balance rather than a parameter. A
 * courier does not collect part of a COD order — they collect the total or the
 * delivery is refused — so offering a partial amount here would only create a
 * way to fat-finger the books.
 */
export async function recordCodCollection(
  tx: Tx,
  ctx: TenantContext,
  actor: ActorContext,
  orderId: string,
): Promise<void> {
  const order = await snapshotForUpdate(tx, ctx.tenantId, orderId);

  if (order.status === 'cancelled') {
    throw new DomainError('CONFLICT', 'Order is cancelled', {
      publicMessage: 'This order was cancelled — record any money received as a manual note.',
    });
  }
  if (order.provider !== 'cod') {
    throw new DomainError('CONFLICT', `Order was paid via ${order.provider ?? 'unknown'}`, {
      publicMessage: 'This order was not placed as cash on delivery.',
    });
  }
  const outstanding = order.total - order.paidTotal;
  if (outstanding <= 0) {
    throw new DomainError('CONFLICT', 'Order already fully paid', {
      publicMessage: 'This order is already recorded as paid.',
    });
  }

  await tx.execute(sql`
    INSERT INTO transactions
      (id, tenant_id, order_id, payment_intent_id, provider, provider_reference,
       kind, status, amount, currency, processed_at, created_at, updated_at)
    VALUES (${uuidv7()}, ${ctx.tenantId}, ${orderId}, ${order.intentId},
            'cod', ${order.providerReference ?? `cod_${order.number}`},
            'capture', 'succeeded', ${outstanding}, ${order.currency}, now(), now(), now())
  `);

  await refreshDerivedStatus(tx, ctx, orderId);

  await recordEvent(tx, ctx.tenantId, orderId, {
    type: 'payment.captured',
    isPublic: true,
    message: `Cash on delivery collected: ${(outstanding / 100).toFixed(2)} ${order.currency}`,
    actor,
  });
}

export interface RefundRequestInput {
  /** Minor units. Refunds the full refundable balance when omitted. */
  readonly amount?: number;
  readonly reason: string;
}

export interface RefundResult {
  readonly amount: number;
  readonly currency: string;
  /** 'succeeded' immediately, or 'pending' while the gateway processes it. */
  readonly status: 'succeeded' | 'pending';
}

/**
 * Refunds money against an order.
 *
 * The refundable balance is `paid − already refunded`, and the database
 * enforces the same ceiling with a CHECK constraint (`refunded_total <=
 * paid_total`) — so even a bug that slipped past this guard could not
 * over-refund. Belt and braces, because this is the function that gives
 * money away.
 *
 * The gateway is a parameter, not a lookup: cash and bank-transfer refunds
 * pass none and are recorded directly, while card/BNPL refunds go through the
 * adapter for the provider that took the payment. A failed gateway refund
 * throws and writes nothing — the admin retries once the gateway is healthy,
 * and an half-recorded refund never exists.
 *
 * Refunds are deliberately financial-only. Returning goods to the shelf is the
 * returns flow's job; conflating them is how stock counts drift on every
 * "refund as goodwill, customer keeps the item" case.
 */
export async function refundOrder(
  tx: Tx,
  ctx: TenantContext,
  actor: ActorContext,
  orderId: string,
  request: RefundRequestInput,
  gateway?: PaymentGateway,
): Promise<RefundResult> {
  const reason = request.reason.trim();
  if (!reason) {
    throw new DomainError('VALIDATION_FAILED', 'Refund reason is required', {
      publicMessage: 'Give a reason — it goes on the order record and the customer statement.',
    });
  }

  const order = await snapshotForUpdate(tx, ctx.tenantId, orderId);

  const check = canRefund({
    status: order.status as OrderStatus,
    paymentStatus: order.paymentStatus as PaymentStatus,
    fulfilmentStatus: order.fulfilmentStatus as FulfilmentStatus,
  });
  if (!check.allowed) {
    throw new DomainError('CONFLICT', check.reason ?? 'Order cannot be refunded', {
      publicMessage: check.reason ?? 'This order cannot be refunded.',
    });
  }

  const refundable = order.paidTotal - order.refundedTotal;
  const amount = request.amount ?? refundable;

  if (!Number.isInteger(amount) || amount <= 0) {
    throw new DomainError('VALIDATION_FAILED', `Invalid refund amount ${amount}`, {
      publicMessage: 'Enter a refund amount greater than zero.',
    });
  }
  if (amount > refundable) {
    throw new DomainError('VALIDATION_FAILED', `Refund ${amount} exceeds refundable ${refundable}`, {
      publicMessage: `The most that can be refunded is ${(refundable / 100).toFixed(2)} ${order.currency}.`,
    });
  }

  // The capture this refund reverses — the gateway needs its reference, and
  // the ledger links child to parent so a statement can show which payment a
  // refund belongs to.
  const captures = await tx.execute<{ id: string; provider_reference: string | null }>(sql`
    SELECT id, provider_reference FROM transactions
    WHERE tenant_id = ${ctx.tenantId} AND order_id = ${orderId}
      AND kind IN ('capture', 'sale') AND status = 'succeeded'
    ORDER BY created_at DESC LIMIT 1
  `);
  const capture = captures.rows[0];
  if (!capture) {
    throw new DomainError('CONFLICT', 'No captured payment found to refund', {
      publicMessage: 'No captured payment exists on this order.',
    });
  }

  const refundId = uuidv7();
  let status: 'succeeded' | 'pending' = 'succeeded';
  // `transactions` carries a UNIQUE index on (provider, provider_reference,
  // kind) — the database's own guarantee that the same gateway operation
  // cannot be recorded twice. A manual refund has no provider reference to
  // supply, so it gets a unique synthetic one derived from the transaction id.
  // A constant here (the first version of this line used the literal 'manual')
  // collides on the *second* manual refund in the entire system, which the
  // integration tests caught and a staging environment would not.
  let providerReference = `manual_${refundId}`;

  if (gateway) {
    // The refund transaction id doubles as the idempotency key, so a retried
    // call after a network timeout cannot refund twice at the gateway.
    const outcome = await gateway.refundPayment({
      idempotencyKey: refundId,
      transactionReference: capture.provider_reference ?? order.providerReference ?? '',
      amount: money(amount, order.currency),
      reason,
      orderNumber: order.number,
    });

    if (outcome.kind === 'failed') {
      throw new DomainError('GATEWAY_UNAVAILABLE', `Refund failed: ${outcome.message}`, {
        publicMessage: `The payment provider refused the refund: ${outcome.message}`,
        retryable: true,
      });
    }
    status = outcome.kind === 'pending' ? 'pending' : 'succeeded';
    providerReference = outcome.reference;
  }

  await tx.execute(sql`
    INSERT INTO transactions
      (id, tenant_id, order_id, payment_intent_id, parent_transaction_id,
       provider, provider_reference, kind, status, amount, currency, reason,
       processed_at, created_at, updated_at)
    VALUES (${refundId}, ${ctx.tenantId}, ${orderId}, ${order.intentId}, ${capture.id},
            ${gateway?.id ?? order.provider ?? 'manual'}, ${providerReference},
            'refund', ${status}, ${amount}, ${order.currency}, ${reason},
            ${status === 'succeeded' ? sql`now()` : null}, now(), now())
  `);

  // Only a succeeded refund moves the derived status — a pending one is money
  // still in flight, and counting it as returned before the gateway confirms
  // would overstate what the customer has back.
  if (status === 'succeeded') {
    await refreshDerivedStatus(tx, ctx, orderId);
  }

  await recordEvent(tx, ctx.tenantId, orderId, {
    type: 'payment.refunded',
    isPublic: true,
    message: `Refund of ${(amount / 100).toFixed(2)} ${order.currency}${
      status === 'pending' ? ' initiated' : ' issued'
    }: ${reason}`,
    actor,
  });

  return { amount, currency: order.currency, status };
}
