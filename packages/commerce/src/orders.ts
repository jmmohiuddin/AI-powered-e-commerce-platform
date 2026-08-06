import { sql } from 'drizzle-orm';
import {
  assertTransition,
  availableActions,
  canCancel,
  DomainError,
  deriveFulfilmentStatus,
  derivePaymentStatus,
  normaliseUaePhone,
  type FulfilmentStatus,
  type OrderState,
  type OrderStatus,
  type PaymentStatus,
} from '@voltix/core';
import { recordEvent } from './checkout';
import { releaseReservations } from './reservations';
import type { ActorContext, TenantContext, Tx } from './types';

/**
 * ORDER SERVICE
 *
 * Every state change goes through the state machine in @voltix/core rather than
 * writing the column directly. That is what makes "refunded before shipped"
 * impossible instead of merely unlikely, and it is why the admin can ask
 * `availableActions()` and render exactly the buttons that will work — a UI
 * that offers a Refund button which throws when clicked is a worse experience
 * than one that never offered it.
 */

export interface OrderSummary {
  readonly id: string;
  readonly number: string;
  readonly status: OrderStatus;
  readonly paymentStatus: PaymentStatus;
  readonly fulfilmentStatus: FulfilmentStatus;
  readonly total: number;
  readonly paidTotal: number;
  readonly currency: string;
  readonly placedAt: Date | null;
  readonly customerName: string | null;
  readonly emirate: string | null;
  readonly itemCount: number;
  readonly availableActions: string[];
}

export async function getOrder(
  tx: Tx,
  ctx: TenantContext,
  orderId: string,
): Promise<OrderSummary | null> {
  const rows = await tx.execute<{
    id: string;
    number: string;
    status: OrderStatus;
    payment_status: PaymentStatus;
    fulfilment_status: FulfilmentStatus;
    total: number;
    paid_total: number;
    currency: string;
    placed_at: Date | null;
    shipping_address: { recipientName?: string; emirate?: string } | null;
    item_count: number;
  }>(sql`
    SELECT o.id, o.number, o.status, o.payment_status, o.fulfilment_status,
           o.total, o.paid_total, o.currency, o.placed_at, o.shipping_address,
           (SELECT coalesce(sum(quantity), 0)::int FROM order_items WHERE order_id = o.id) AS item_count
    FROM orders o
    WHERE o.tenant_id = ${ctx.tenantId} AND o.id = ${orderId}
  `);

  const row = rows.rows[0];
  if (!row) return null;

  const state: OrderState = {
    status: row.status,
    paymentStatus: row.payment_status,
    fulfilmentStatus: row.fulfilment_status,
  };

  return {
    id: row.id,
    number: row.number,
    status: row.status,
    paymentStatus: row.payment_status,
    fulfilmentStatus: row.fulfilment_status,
    total: Number(row.total),
    paidTotal: Number(row.paid_total),
    currency: row.currency,
    placedAt: row.placed_at,
    customerName: row.shipping_address?.recipientName ?? null,
    emirate: row.shipping_address?.emirate ?? null,
    itemCount: Number(row.item_count),
    availableActions: availableActions(state),
  };
}

/**
 * Guest order lookup: order number plus the phone it was placed with.
 *
 * Two factors rather than one, because an order number is sequential and
 * therefore guessable, and an order page exposes a delivery address.
 *
 * BOTH SIDES ARE NORMALISED TO E.164 BEFORE COMPARISON. Stripping non-digits
 * is not enough: an order stored as "+971501234567" yields "971501234567",
 * while a customer typing "0501234567" yields "0501234567", and those never
 * match. The customer is then told their own order does not exist — which is a
 * support call, and an avoidable one.
 */
export async function lookupOrder(
  tx: Tx,
  ctx: TenantContext,
  number: string,
  phone: string,
): Promise<OrderSummary | null> {
  const normalised = normaliseUaePhone(phone);
  if (!normalised) return null;

  const rows = await tx.execute<{ id: string }>(sql`
    SELECT id FROM orders
    WHERE tenant_id = ${ctx.tenantId}
      AND number = ${number.replace(/^#/, '')}
      AND phone = ${normalised}
    LIMIT 1
  `);
  const id = rows.rows[0]?.id;
  return id ? getOrder(tx, ctx, id) : null;
}

async function currentState(tx: Tx, tenantId: string, orderId: string): Promise<OrderState> {
  const rows = await tx.execute<{
    status: OrderStatus;
    payment_status: PaymentStatus;
    fulfilment_status: FulfilmentStatus;
  }>(sql`
    SELECT status, payment_status, fulfilment_status FROM orders
    WHERE tenant_id = ${tenantId} AND id = ${orderId}
    FOR UPDATE
  `);
  const row = rows.rows[0];
  if (!row) throw new DomainError('NOT_FOUND', `Order ${orderId} not found`);
  return {
    status: row.status,
    paymentStatus: row.payment_status,
    fulfilmentStatus: row.fulfilment_status,
  };
}

export async function transitionOrder(
  tx: Tx,
  ctx: TenantContext,
  actor: ActorContext,
  orderId: string,
  next: Partial<OrderState>,
  event: { type: string; message: string; isPublic?: boolean },
): Promise<OrderState> {
  const state = await currentState(tx, ctx.tenantId, orderId);
  // Throws IllegalTransitionError rather than writing an impossible state.
  assertTransition(state, next);
  const merged = { ...state, ...next };

  await tx.execute(sql`
    UPDATE orders
    SET status = ${merged.status},
        payment_status = ${merged.paymentStatus},
        fulfilment_status = ${merged.fulfilmentStatus},
        completed_at = ${merged.status === 'completed' ? sql`now()` : sql`completed_at`},
        updated_at = now()
    WHERE tenant_id = ${ctx.tenantId} AND id = ${orderId}
  `);

  await recordEvent(tx, ctx.tenantId, orderId, {
    type: event.type,
    isPublic: event.isPublic ?? false,
    message: event.message,
    actor,
  });

  return merged;
}

/**
 * Cancels an order and returns the stock.
 *
 * Refused once anything has shipped — a cancelled order releases inventory, and
 * doing that after a courier has the parcel means the count says "available"
 * for units that are on a van, and the next customer buys air.
 */
export async function cancelOrder(
  tx: Tx,
  ctx: TenantContext,
  actor: ActorContext,
  orderId: string,
  reason: string,
): Promise<void> {
  const state = await currentState(tx, ctx.tenantId, orderId);
  const check = canCancel(state);
  if (!check.allowed) {
    throw new DomainError('CONFLICT', check.reason ?? 'Order cannot be cancelled', {
      publicMessage: check.reason ?? 'This order can no longer be cancelled.',
    });
  }

  await releaseReservations(tx, ctx.tenantId, { orderId });

  // Return any already-committed units to the shelf, with a ledger row each.
  const committed = await tx.execute<{
    variant_id: string;
    warehouse_id: string;
    quantity: number;
  }>(sql`
    SELECT variant_id, warehouse_id, quantity FROM stock_reservations
    WHERE tenant_id = ${ctx.tenantId} AND order_id = ${orderId} AND status = 'committed'
  `);

  for (const row of committed.rows) {
    const updated = await tx.execute<{ on_hand: number }>(sql`
      UPDATE stock_levels
      SET on_hand = on_hand + ${row.quantity}, version = version + 1, updated_at = now()
      WHERE tenant_id = ${ctx.tenantId}
        AND variant_id = ${row.variant_id} AND warehouse_id = ${row.warehouse_id}
      RETURNING on_hand
    `);
    await tx.execute(sql`
      INSERT INTO stock_movements
        (id, tenant_id, variant_id, warehouse_id, delta, balance_after, reason,
         reference_type, reference_id, note, created_at)
      VALUES (gen_random_uuid(), ${ctx.tenantId}, ${row.variant_id}, ${row.warehouse_id},
              ${row.quantity}, ${updated.rows[0]?.on_hand ?? 0}, 'return_restock',
              'order', ${orderId}, ${'Order cancelled: ' + reason}, now())
    `);
  }

  await tx.execute(sql`
    UPDATE orders
    SET status = 'cancelled', cancelled_at = now(), cancel_reason = ${reason}, updated_at = now()
    WHERE tenant_id = ${ctx.tenantId} AND id = ${orderId}
  `);

  await recordEvent(tx, ctx.tenantId, orderId, {
    type: 'order.cancelled',
    isPublic: true,
    message: `Order cancelled: ${reason}`,
    actor,
  });
}

/**
 * Recomputes the derived statuses from the underlying rows.
 *
 * Run after any partial fulfilment or refund. The two derived columns are a
 * cache over the line-item quantities and the transaction ledger; recomputing
 * from the source keeps them from drifting, which is the failure that makes an
 * order list quietly lie about what has shipped.
 */
export async function refreshDerivedStatus(
  tx: Tx,
  ctx: TenantContext,
  orderId: string,
): Promise<OrderState> {
  const items = await tx.execute<{
    quantity: number;
    quantity_fulfilled: number;
    quantity_returned: number;
  }>(sql`
    SELECT quantity, quantity_fulfilled, quantity_returned
    FROM order_items WHERE tenant_id = ${ctx.tenantId} AND order_id = ${orderId}
  `);

  const totals = await tx.execute<{ total: number; paid: number; refunded: number }>(sql`
    SELECT o.total,
           coalesce(sum(t.amount) FILTER (WHERE t.kind IN ('capture','sale') AND t.status='succeeded'), 0) AS paid,
           coalesce(sum(t.amount) FILTER (WHERE t.kind = 'refund' AND t.status='succeeded'), 0) AS refunded
    FROM orders o
    LEFT JOIN transactions t ON t.order_id = o.id
    WHERE o.tenant_id = ${ctx.tenantId} AND o.id = ${orderId}
    GROUP BY o.total
  `);

  const row = totals.rows[0];
  const paymentStatus = derivePaymentStatus(
    Number(row?.total ?? 0),
    Number(row?.paid ?? 0),
    Number(row?.refunded ?? 0),
  );
  const fulfilmentStatus = deriveFulfilmentStatus(
    items.rows.map((i) => ({
      quantity: Number(i.quantity),
      quantityFulfilled: Number(i.quantity_fulfilled),
      quantityReturned: Number(i.quantity_returned),
    })),
  );

  await tx.execute(sql`
    UPDATE orders
    SET payment_status = ${paymentStatus},
        fulfilment_status = ${fulfilmentStatus},
        paid_total = ${Number(row?.paid ?? 0)},
        refunded_total = ${Number(row?.refunded ?? 0)},
        updated_at = now()
    WHERE tenant_id = ${ctx.tenantId} AND id = ${orderId}
  `);

  const state = await currentState(tx, ctx.tenantId, orderId);
  return { ...state, paymentStatus, fulfilmentStatus };
}
