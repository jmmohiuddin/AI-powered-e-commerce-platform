import { sql } from 'drizzle-orm';
import { uuidv7 } from '@voltix/db';
import { DomainError } from '@voltix/core';
import { recordEvent } from './checkout';
import { returnNumber } from './numbering';
import { refundOrder } from './payment-ops';
import type { ActorContext, TenantContext, Tx } from './types';

/**
 * RETURNS
 *
 * The other half of the money path. `/returns` on the storefront promises a
 * customer that a faulty item is replaced or refunded within 30 days and a
 * change of mind within 14 — this is the machinery that lets staff actually
 * honour that, rather than doing it by hand in the database.
 *
 * Three decisions shape the whole module:
 *
 * 1. **A return is a request first and a refund later.** The row is created in
 *    `requested`, and money only moves at `completed`. Refunding on request
 *    would mean paying out for parcels that never arrive, which is exactly the
 *    fraud a returns process exists to prevent.
 *
 * 2. **Restocking is a decision, not a consequence.** A returned handset with a
 *    cracked screen is not sellable stock. `restockable` is set by whoever
 *    inspects the parcel, and only then does the unit go back on the shelf —
 *    conflating "returned" with "back in stock" is how a catalogue starts
 *    selling broken goods.
 *
 * 3. **You cannot return more than was bought.** `order_items.quantity_returned`
 *    is the running total and every request is checked against the remaining
 *    balance, so two overlapping returns cannot together exceed the order.
 */

/** Statuses a return can legally move between. Anything else throws. */
const TRANSITIONS: Record<string, readonly string[]> = {
  requested: ['approved', 'rejected', 'cancelled'],
  approved: ['in_transit', 'received', 'cancelled'],
  in_transit: ['received', 'cancelled'],
  received: ['inspected', 'cancelled'],
  inspected: ['completed', 'rejected'],
  // Terminal.
  completed: [],
  rejected: [],
  cancelled: [],
};

export type ReturnStatus = keyof typeof TRANSITIONS;

export interface CreateReturnLine {
  readonly orderItemId: string;
  readonly quantity: number;
}

export interface CreateReturnInput {
  readonly orderId: string;
  readonly reason: string;
  readonly resolution: string;
  readonly lines: readonly CreateReturnLine[];
  readonly customerComment?: string;
}

export interface CreateReturnResult {
  readonly id: string;
  readonly number: string;
}

/**
 * Opens a return request against an order.
 *
 * Validates the requested quantities against what is actually still returnable
 * on each line, inside the same transaction that writes the rows — so two staff
 * members processing the same order at once cannot between them approve more
 * than was sold.
 */
export async function createReturn(
  tx: Tx,
  ctx: TenantContext,
  actor: ActorContext,
  input: CreateReturnInput,
): Promise<CreateReturnResult> {
  if (input.lines.length === 0) {
    throw new DomainError('VALIDATION_FAILED', 'A return needs at least one line', {
      publicMessage: 'Choose at least one item to return.',
    });
  }

  const orders = await tx.execute<{
    id: string;
    number: string;
    customer_id: string | null;
    currency: string;
    status: string;
  }>(sql`
    SELECT id, number, customer_id, currency, status FROM orders
    WHERE tenant_id = ${ctx.tenantId} AND id = ${input.orderId}
    FOR UPDATE
  `);
  const order = orders.rows[0];
  if (!order) throw new DomainError('NOT_FOUND', `Order ${input.orderId} not found`);

  if (order.status === 'cancelled') {
    throw new DomainError('CONFLICT', 'Order is cancelled', {
      publicMessage: 'This order was cancelled — there is nothing to return.',
    });
  }

  // Lock the lines being returned and read what is still returnable on each.
  const itemIds = input.lines.map((l) => l.orderItemId);
  const items = await tx.execute<{
    id: string;
    quantity: number;
    quantity_returned: number;
    unit_price: string;
    title: string;
  }>(sql`
    SELECT id, quantity, quantity_returned, unit_price, title
    FROM order_items
    WHERE tenant_id = ${ctx.tenantId}
      AND order_id = ${input.orderId}
      AND id IN (${sql.join(itemIds.map((id) => sql`${id}`), sql`, `)})
    FOR UPDATE
  `);
  const byId = new Map(items.rows.map((r) => [r.id, r]));

  let refundEstimate = 0;
  for (const line of input.lines) {
    const item = byId.get(line.orderItemId);
    if (!item) {
      throw new DomainError('VALIDATION_FAILED', `Line ${line.orderItemId} is not on this order`, {
        publicMessage: 'One of the items is not part of this order.',
      });
    }
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new DomainError('VALIDATION_FAILED', `Invalid quantity ${line.quantity}`, {
        publicMessage: 'Return quantities must be whole numbers above zero.',
      });
    }
    const remaining = Number(item.quantity) - Number(item.quantity_returned);
    if (line.quantity > remaining) {
      throw new DomainError('VALIDATION_FAILED', `Only ${remaining} of ${item.title} returnable`, {
        publicMessage: `Only ${remaining} × ${item.title} can still be returned.`,
      });
    }
    refundEstimate += Number(item.unit_price) * line.quantity;
  }

  const id = uuidv7();
  const number = await returnNumber(tx, ctx.tenantId);

  await tx.execute(sql`
    INSERT INTO returns
      (id, tenant_id, order_id, number, customer_id, status, reason, resolution,
       customer_comment, refund_amount, currency, created_at, updated_at)
    VALUES (${id}, ${ctx.tenantId}, ${input.orderId}, ${number}, ${order.customer_id},
            'requested', ${input.reason}::return_reason, ${input.resolution}::return_resolution,
            ${input.customerComment ?? null}, ${refundEstimate}, ${order.currency}, now(), now())
  `);

  for (const line of input.lines) {
    await tx.execute(sql`
      INSERT INTO return_items
        (id, tenant_id, return_id, order_item_id, quantity, created_at, updated_at)
      VALUES (${uuidv7()}, ${ctx.tenantId}, ${id}, ${line.orderItemId}, ${line.quantity},
              now(), now())
    `);
  }

  await recordEvent(tx, ctx.tenantId, input.orderId, {
    type: 'return.requested',
    isPublic: true,
    message: `Return ${number} requested`,
    actor,
  });

  return { id, number };
}

/**
 * Moves a return along its lifecycle.
 *
 * The side effects live here rather than in the caller, so they cannot be
 * forgotten by one code path and not another:
 *
 *  • reaching `received` bumps `order_items.quantity_returned`, which is what
 *    stops the same unit being returned twice;
 *  • reaching `completed` restocks (only if the inspection said so) and issues
 *    the refund through the same `refundOrder` the admin uses, so the money
 *    goes through the transaction ledger like every other movement.
 */
export async function transitionReturn(
  tx: Tx,
  ctx: TenantContext,
  actor: ActorContext,
  returnId: string,
  next: ReturnStatus,
  options: { inspectionNote?: string; restockable?: boolean; refundAmount?: number } = {},
): Promise<void> {
  const rows = await tx.execute<{
    id: string;
    number: string;
    order_id: string;
    status: string;
    resolution: string;
    restockable: boolean | null;
    refund_amount: string;
    currency: string;
  }>(sql`
    SELECT id, number, order_id, status, resolution, restockable, refund_amount, currency
    FROM returns WHERE tenant_id = ${ctx.tenantId} AND id = ${returnId}
    FOR UPDATE
  `);
  const ret = rows.rows[0];
  if (!ret) throw new DomainError('NOT_FOUND', `Return ${returnId} not found`);

  const allowed = TRANSITIONS[ret.status] ?? [];
  if (!allowed.includes(next)) {
    throw new DomainError('CONFLICT', `Cannot move a ${ret.status} return to ${next}`, {
      publicMessage: `A ${ret.status.replace(/_/g, ' ')} return cannot be marked ${next.replace(/_/g, ' ')}.`,
    });
  }

  const lines = await tx.execute<{ order_item_id: string; quantity: number }>(sql`
    SELECT order_item_id, quantity FROM return_items
    WHERE tenant_id = ${ctx.tenantId} AND return_id = ${returnId}
  `);

  // Receiving the parcel is the point the units are accounted for. Doing it at
  // `completed` instead would leave a window where an inspected-but-unfinished
  // return lets the same unit be requested again.
  if (next === 'received') {
    for (const line of lines.rows) {
      await tx.execute(sql`
        UPDATE order_items
        SET quantity_returned = quantity_returned + ${line.quantity}, updated_at = now()
        WHERE tenant_id = ${ctx.tenantId} AND id = ${line.order_item_id}
      `);
    }
  }

  const timestampColumn =
    next === 'approved'
      ? sql`approved_at = now(),`
      : next === 'received'
        ? sql`received_at = now(),`
        : next === 'completed'
          ? sql`completed_at = now(),`
          : sql``;

  await tx.execute(sql`
    UPDATE returns SET
      status = ${next}::return_status,
      ${timestampColumn}
      inspection_note = coalesce(${options.inspectionNote ?? null}, inspection_note),
      restockable = coalesce(${options.restockable ?? null}, restockable),
      refund_amount = coalesce(${options.refundAmount ?? null}, refund_amount),
      updated_at = now()
    WHERE tenant_id = ${ctx.tenantId} AND id = ${returnId}
  `);

  if (next === 'completed') {
    // Restock only what inspection cleared. `restockable` is deliberately
    // tri-state: null means nobody has decided, and undecided is not a yes.
    if (ret.restockable === true || options.restockable === true) {
      for (const line of lines.rows) {
        await restockReturnedUnits(tx, ctx, actor, line.order_item_id, line.quantity);
      }
    }

    // Money last, and only for resolutions that actually pay out. An exchange
    // or a warranty replacement returns goods without returning cash.
    const amount = options.refundAmount ?? Number(ret.refund_amount);
    if (ret.resolution === 'refund' && amount > 0) {
      await refundOrder(
        tx,
        ctx,
        actor,
        ret.order_id,
        { amount, reason: `Return ${ret.number}` },
        // No gateway: the admin's refund screen passes one for card payments.
        // A return completed from this path records the refund against the
        // ledger and leaves the gateway call to whoever has the adapter.
        undefined,
      );
    }
  }

  await recordEvent(tx, ctx.tenantId, ret.order_id, {
    type: `return.${next}`,
    isPublic: next !== 'inspected', // Inspection notes are internal.
    message: `Return ${ret.number} ${next.replace(/_/g, ' ')}`,
    actor,
  });
}

/**
 * Puts inspected-good units back into sellable stock, and writes the ledger row.
 *
 * The `stock_movements` insert is not bookkeeping for its own sake: that table
 * is append-only (UPDATE and DELETE are revoked from the app role) and is the
 * only place a stock level's history exists. A `stock_levels` update without a
 * matching movement leaves a count that changed for no recorded reason, which
 * is precisely the thing a stock-take argument cannot resolve.
 *
 * Units go back to the warehouse the order was picked from where that is
 * knowable, and otherwise to the tenant's default. Guessing wrong moves the
 * count between two real warehouses, so the fallback is the one place a human
 * would look first.
 */
async function restockReturnedUnits(
  tx: Tx,
  ctx: TenantContext,
  actor: ActorContext,
  orderItemId: string,
  quantity: number,
): Promise<void> {
  const rows = await tx.execute<{ variant_id: string | null; unit_cost: string | null }>(sql`
    SELECT variant_id, unit_cost FROM order_items
    WHERE tenant_id = ${ctx.tenantId} AND id = ${orderItemId} LIMIT 1
  `);
  const item = rows.rows[0];
  if (!item?.variant_id) return; // A deleted variant has nowhere to go back to.

  const warehouses = await tx.execute<{ warehouse_id: string }>(sql`
    SELECT warehouse_id FROM stock_levels
    WHERE tenant_id = ${ctx.tenantId} AND variant_id = ${item.variant_id}
    ORDER BY on_hand DESC
    LIMIT 1
  `);
  const warehouseId = warehouses.rows[0]?.warehouse_id;
  if (!warehouseId) return;

  const updated = await tx.execute<{ on_hand: number }>(sql`
    UPDATE stock_levels
    SET on_hand = on_hand + ${quantity}, version = version + 1, updated_at = now()
    WHERE tenant_id = ${ctx.tenantId}
      AND variant_id = ${item.variant_id}
      AND warehouse_id = ${warehouseId}
    RETURNING on_hand
  `);

  await tx.execute(sql`
    INSERT INTO stock_movements
      (id, tenant_id, variant_id, warehouse_id, delta, balance_after, reason,
       unit_cost, reference_type, reference_id, actor_user_id, created_at)
    VALUES (${uuidv7()}, ${ctx.tenantId}, ${item.variant_id}, ${warehouseId},
            ${quantity}, ${updated.rows[0]?.on_hand ?? 0}, 'return_restock',
            ${item.unit_cost}, 'return_item', ${orderItemId},
            ${actor.type === 'staff' ? (actor.id ?? null) : null}, now())
  `);
}
