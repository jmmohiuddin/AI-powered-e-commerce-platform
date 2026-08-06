import { sql } from 'drizzle-orm';
import { uuidv7 } from '@voltix/db';
import { outOfStock, reservationTtlMs } from '@voltix/core';
import type { Tx } from './types';

/**
 * STOCK RESERVATION — the code that stops the store overselling.
 *
 * THE RACE, concretely: one unit left. Two shoppers reach checkout in the same
 * millisecond. Both read `available = 1`, both decide it is fine, both create an
 * order. One of them gets a phone call the next morning.
 *
 * The fix is a row lock, and the important detail is *which* row. Locking the
 * variant, or a global lock, serialises unrelated checkouts. Locking the
 * `stock_levels` row for that (variant, warehouse) serialises exactly the
 * contended pair and nothing else — two people buying different phones never
 * touch each other.
 *
 * DEADLOCK is the second-order problem. Cart A holds a lock on SKU 1 and wants
 * SKU 2; cart B holds SKU 2 and wants SKU 1. Postgres detects this and kills
 * one of them — a checkout failure with no cause a customer could understand.
 * Locking rows in a globally consistent order (by stock_levels id) makes the
 * cycle impossible: both carts take SKU 1 first, and the second simply waits.
 *
 * Reservations carry a TTL rather than being permanent. A shopper who closes
 * the tab must not hold the last unit forever, which is what a naive
 * "decrement on add to cart" design does.
 */

export interface ReserveRequest {
  readonly variantId: string;
  readonly quantity: number;
  readonly preferredWarehouseId?: string;
}

export interface Reservation {
  readonly id: string;
  readonly variantId: string;
  readonly warehouseId: string;
  readonly quantity: number;
}

export interface ReserveResult {
  readonly reservations: Reservation[];
  readonly expiresAt: Date;
}

/**
 * Reserves every line, or none of them.
 *
 * Partial reservation is not offered on purpose: a checkout that succeeds for
 * three of four items and silently drops the fourth is worse than a clear
 * failure, because the shopper pays before noticing. The caller's transaction
 * rolls the whole thing back on the first shortfall.
 */
export async function reserveStock(
  tx: Tx,
  tenantId: string,
  lines: readonly ReserveRequest[],
  options: {
    cartId?: string;
    orderId?: string;
    paymentProvider?: string;
    /** Click-and-collect, or a nearest-branch choice made at checkout. */
    preferredWarehouseId?: string;
  } = {},
): Promise<ReserveResult> {
  const expiresAt = new Date(Date.now() + reservationTtlMs(options.paymentProvider));
  const reservations: Reservation[] = [];
  if (lines.length === 0) return { reservations, expiresAt };

  const variantIds = [...new Set(lines.map((l) => l.variantId))];

  /**
   * Lock every candidate row up front, ordered by id.
   *
   * `ORDER BY sl.id` inside `FOR UPDATE` is the deadlock guard described above:
   * concurrent transactions acquire the same rows in the same sequence, so one
   * always waits rather than both blocking each other.
   */
  const locked = await tx.execute<{
    id: string;
    variant_id: string;
    warehouse_id: string;
    available: number;
    allow_backorder: boolean;
    priority: number;
  }>(sql`
    SELECT sl.id,
           sl.variant_id,
           sl.warehouse_id,
           greatest(sl.on_hand - sl.reserved, 0) AS available,
           sl.allow_backorder,
           w.priority
    FROM stock_levels sl
    JOIN warehouses w ON w.id = sl.warehouse_id
    WHERE sl.tenant_id = ${tenantId}
      AND sl.variant_id = ANY(${sql`ARRAY[${sql.join(
        variantIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]`})
      AND w.is_active = true
    ORDER BY sl.id
    FOR UPDATE OF sl
  `);

  const byVariant = new Map<string, typeof locked.rows>();
  for (const row of locked.rows) {
    const list = byVariant.get(row.variant_id) ?? [];
    list.push(row);
    byVariant.set(row.variant_id, list);
  }

  for (const line of lines) {
    const positions = [...(byVariant.get(line.variantId) ?? [])].sort((a, b) => {
      if (options.preferredWarehouseId ?? line.preferredWarehouseId) {
        const preferred = line.preferredWarehouseId ?? options.preferredWarehouseId;
        if (a.warehouse_id === preferred) return -1;
        if (b.warehouse_id === preferred) return 1;
      }
      if (a.priority !== b.priority) return a.priority - b.priority;
      return b.available - a.available;
    });

    const totalAvailable = positions.reduce((n, p) => n + Number(p.available), 0);
    const canBackorder = positions.some((p) => p.allow_backorder);

    if (totalAvailable < line.quantity && !canBackorder) {
      // Throws rather than returns, so the caller's transaction unwinds and any
      // reservations already taken in this loop are released with it.
      throw outOfStock(line.variantId, line.quantity, totalAvailable);
    }

    let remaining = line.quantity;

    // Prefer a single source: a split shipment costs a second delivery fee and
    // doubles the chance of a delivery problem.
    const single = positions.find((p) => Number(p.available) >= remaining);
    const targets = single ? [single] : positions;

    for (const position of targets) {
      if (remaining <= 0) break;
      const take = single ? remaining : Math.min(Number(position.available), remaining);
      if (take <= 0) continue;

      const reservationId = uuidv7();
      await tx.execute(sql`
        INSERT INTO stock_reservations
          (id, tenant_id, variant_id, warehouse_id, quantity, cart_id, order_id,
           status, expires_at, created_at, updated_at)
        VALUES (${reservationId}, ${tenantId}, ${line.variantId}, ${position.warehouse_id},
                ${take}, ${options.cartId ?? null}, ${options.orderId ?? null},
                'held', ${expiresAt.toISOString()}, now(), now())
      `);

      // `reserved` moves; `on_hand` does not. The unit is still physically in
      // the building — it is promised, not gone. The CHECK constraint on
      // reserved >= 0 is the backstop if this arithmetic is ever wrong.
      await tx.execute(sql`
        UPDATE stock_levels
        SET reserved = reserved + ${take}, version = version + 1, updated_at = now()
        WHERE id = ${position.id}
      `);

      reservations.push({
        id: reservationId,
        variantId: line.variantId,
        warehouseId: position.warehouse_id,
        quantity: take,
      });
      remaining -= take;
    }

    if (remaining > 0) {
      const backorderTarget = positions.find((p) => p.allow_backorder);
      if (!backorderTarget) throw outOfStock(line.variantId, line.quantity, totalAvailable);

      const reservationId = uuidv7();
      await tx.execute(sql`
        INSERT INTO stock_reservations
          (id, tenant_id, variant_id, warehouse_id, quantity, cart_id, order_id,
           status, expires_at, created_at, updated_at)
        VALUES (${reservationId}, ${tenantId}, ${line.variantId}, ${backorderTarget.warehouse_id},
                ${remaining}, ${options.cartId ?? null}, ${options.orderId ?? null},
                'held', ${expiresAt.toISOString()}, now(), now())
      `);
      await tx.execute(sql`
        UPDATE stock_levels
        SET reserved = reserved + ${remaining}, version = version + 1, updated_at = now()
        WHERE id = ${backorderTarget.id}
      `);
      reservations.push({
        id: reservationId,
        variantId: line.variantId,
        warehouseId: backorderTarget.warehouse_id,
        quantity: remaining,
      });
    }
  }

  return { reservations, expiresAt };
}

/**
 * Commits held reservations: the units leave the building.
 *
 * `on_hand` and `reserved` both drop, and a ledger row records why. The ledger
 * is what makes "we are three short and nobody knows why" answerable — the
 * cached `on_hand` is a projection of it, and if they ever disagree the ledger
 * wins.
 */
export async function commitReservations(
  tx: Tx,
  tenantId: string,
  options: { cartId?: string; orderId?: string; reason?: string },
): Promise<number> {
  const scope = options.orderId
    ? sql`order_id = ${options.orderId}`
    : sql`cart_id = ${options.cartId}`;

  const held = await tx.execute<{
    id: string;
    variant_id: string;
    warehouse_id: string;
    quantity: number;
  }>(sql`
    SELECT id, variant_id, warehouse_id, quantity
    FROM stock_reservations
    WHERE tenant_id = ${tenantId} AND status = 'held' AND ${scope}
    ORDER BY id
    FOR UPDATE
  `);

  for (const reservation of held.rows) {
    const updated = await tx.execute<{ on_hand: number }>(sql`
      UPDATE stock_levels
      SET on_hand = on_hand - ${reservation.quantity},
          reserved = greatest(reserved - ${reservation.quantity}, 0),
          version = version + 1,
          updated_at = now()
      WHERE tenant_id = ${tenantId}
        AND variant_id = ${reservation.variant_id}
        AND warehouse_id = ${reservation.warehouse_id}
      RETURNING on_hand
    `);

    await tx.execute(sql`
      INSERT INTO stock_movements
        (id, tenant_id, variant_id, warehouse_id, delta, balance_after, reason,
         reference_type, reference_id, created_at)
      VALUES (${uuidv7()}, ${tenantId}, ${reservation.variant_id}, ${reservation.warehouse_id},
              ${-reservation.quantity}, ${updated.rows[0]?.on_hand ?? 0}, 'sale',
              'order', ${options.orderId ?? null}, now())
    `);
  }

  await tx.execute(sql`
    UPDATE stock_reservations
    SET status = 'committed', updated_at = now()
    WHERE tenant_id = ${tenantId} AND status = 'held' AND ${scope}
  `);

  return held.rows.length;
}

/** Releases held reservations — abandonment, expiry, or a failed payment. */
export async function releaseReservations(
  tx: Tx,
  tenantId: string,
  options: { cartId?: string; orderId?: string; expired?: boolean },
): Promise<number> {
  const scope = options.orderId
    ? sql`order_id = ${options.orderId}`
    : sql`cart_id = ${options.cartId}`;

  const held = await tx.execute<{ variant_id: string; warehouse_id: string; quantity: number }>(sql`
    SELECT variant_id, warehouse_id, quantity
    FROM stock_reservations
    WHERE tenant_id = ${tenantId} AND status = 'held' AND ${scope}
    ORDER BY id
    FOR UPDATE
  `);

  for (const reservation of held.rows) {
    await tx.execute(sql`
      UPDATE stock_levels
      SET reserved = greatest(reserved - ${reservation.quantity}, 0),
          version = version + 1,
          updated_at = now()
      WHERE tenant_id = ${tenantId}
        AND variant_id = ${reservation.variant_id}
        AND warehouse_id = ${reservation.warehouse_id}
    `);
  }

  await tx.execute(sql`
    UPDATE stock_reservations
    SET status = ${options.expired ? 'expired' : 'released'}, released_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND status = 'held' AND ${scope}
  `);

  return held.rows.length;
}

/**
 * Sweeps expired holds across every tenant. Run by the job runner every minute.
 *
 * Without this, one abandoned tab freezes a unit permanently and the store
 * slowly stops being able to sell its own stock. It is the least glamorous job
 * in the system and the one whose absence is most obvious to customers.
 */
export async function sweepExpiredReservations(tx: Tx, limit = 500): Promise<number> {
  const expired = await tx.execute<{
    id: string;
    tenant_id: string;
    variant_id: string;
    warehouse_id: string;
    quantity: number;
  }>(sql`
    SELECT id, tenant_id, variant_id, warehouse_id, quantity
    FROM stock_reservations
    WHERE status = 'held' AND expires_at < now()
    ORDER BY expires_at
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `);

  for (const reservation of expired.rows) {
    await tx.execute(sql`
      UPDATE stock_levels
      SET reserved = greatest(reserved - ${reservation.quantity}, 0),
          version = version + 1,
          updated_at = now()
      WHERE variant_id = ${reservation.variant_id}
        AND warehouse_id = ${reservation.warehouse_id}
    `);
    await tx.execute(sql`
      UPDATE stock_reservations
      SET status = 'expired', released_at = now(), updated_at = now()
      WHERE id = ${reservation.id}
    `);
  }

  return expired.rows.length;
}

/** Live availability for a set of variants, aggregated across warehouses. */
export async function availabilityFor(
  tx: Tx,
  tenantId: string,
  variantIds: readonly string[],
): Promise<Map<string, number>> {
  if (variantIds.length === 0) return new Map();

  const rows = await tx.execute<{ variant_id: string; available: number }>(sql`
    SELECT variant_id,
           sum(greatest(on_hand - reserved, 0))::int AS available
    FROM stock_levels
    WHERE tenant_id = ${tenantId}
      AND variant_id = ANY(${sql`ARRAY[${sql.join(
        variantIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]`})
    GROUP BY variant_id
  `);

  return new Map(rows.rows.map((r) => [r.variant_id, Number(r.available)]));
}
