/**
 * ORDER IMPORT — noon → Voltix.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * Without it, the same physical unit is advertised on the storefront and on
 * noon with two independent counters. The first customer to buy the last one
 * on noon does not decrement the storefront, and the second sale is a
 * cancellation. Importing orders is what makes the two channels share one
 * inventory pool, and it is the reason a stock push alone is not "sync".
 *
 * IDEMPOTENCE IS THE ENTIRE DESIGN
 * --------------------------------
 * The pull is at-least-once. Windows deliberately overlap (see `sinceWithLap`)
 * because an order created *during* the previous run would fall into the gap
 * between a non-overlapping window and be lost forever — silently, and only
 * discovered when a customer asks where their order went.
 *
 * Overlapping means the same order is seen repeatedly, so every effect is
 * gated on `INSERT … ON CONFLICT DO NOTHING RETURNING id`. If that returns no
 * row, this order was already imported and nothing further happens. Deducting
 * stock outside that gate is how a re-run sells the same unit twice on paper.
 */

import { sql } from 'drizzle-orm';
import { uuidv7, type Database } from '@voltix/db';
import type { FbpiOrder, NoonClient } from '../client.js';
import type { Tx } from './types.js';

export interface ImportResult {
  readonly seen: number;
  readonly imported: number;
  /** Orders whose SKUs are not mapped to a Voltix variant. */
  readonly unmapped: Array<{ fbpiOrderNr: string; partnerSku: string }>;
}

/**
 * The start of the pull window, with a deliberate overlap.
 *
 * Ten minutes is chosen against the failure it prevents rather than the
 * duplicates it creates: duplicates are free (the conflict clause discards
 * them), whereas a missed order is unrecoverable without manual reconciliation.
 * It comfortably exceeds the runtime of a sweep plus any clock skew between
 * our host and noon's.
 */
export function sinceWithLap(lastRunAt: Date | null, now: Date, lapMinutes = 10): Date {
  const fallbackHours = 24;
  if (!lastRunAt) return new Date(now.getTime() - fallbackHours * 3600_000);
  return new Date(lastRunAt.getTime() - lapMinutes * 60_000);
}

/** noon timestamps are ISO-8601 in UTC with a trailing Z. */
function toNoonTimestamp(date: Date): string {
  return `${date.toISOString().split('.')[0]}Z`;
}

/**
 * Pulls a window of orders and applies each one.
 *
 * The fetch — which may be many paginated round trips — happens before any
 * transaction is opened. Each order is then imported in its *own* transaction,
 * so one order referencing an unmapped warehouse cannot roll back the twenty
 * that imported cleanly before it.
 */
export async function importOrders(
  db: Database,
  client: NoonClient,
  tenantId: string,
  warehouseCode: string,
  options: { since: Date; until?: Date } = { since: new Date(Date.now() - 86_400_000) },
): Promise<ImportResult> {
  const orders = await client.listAllOrders({
    warehouse_code: warehouseCode,
    created_after: toNoonTimestamp(options.since),
    ...(options.until ? { created_before: toNoonTimestamp(options.until) } : {}),
  });

  let imported = 0;
  const unmapped: ImportResult['unmapped'] = [];

  for (const order of orders) {
    // The link row and the stock it moves must commit together: a link
    // without its movement is an order that silently never left the shelf.
    const result = await db.transaction(async (tx) => {
      const isNew = await linkOrder(tx, tenantId, order);
      if (!isNew) return null;
      return applyStockEffect(tx, tenantId, order);
    });

    if (result === null) continue;
    imported += 1;
    unmapped.push(...result);
  }

  return { seen: orders.length, imported, unmapped };
}

/**
 * Records the order and reports whether this call is the one that created it.
 *
 * The unique index on (tenant_id, fbpi_order_nr) is the concurrency guard as
 * well as the idempotency one: two workers running the same window at once
 * both attempt the insert, exactly one gets a row back, and only that one
 * moves stock.
 */
async function linkOrder(tx: Tx, tenantId: string, order: FbpiOrder): Promise<boolean> {
  const result = await tx.execute<{ id: string }>(sql`
    INSERT INTO noon_order_links
      (id, tenant_id, fbpi_order_nr, mp_order_nr, mp_code, warehouse_code,
       payload, imported_at, created_at, updated_at)
    VALUES
      (${uuidv7()}, ${tenantId}, ${order.fbpi_order_nr}, ${order.mp_order_nr},
       ${order.mp_code}, ${order.warehouse_code},
       ${JSON.stringify(order)}::jsonb, now(), now(), now())
    ON CONFLICT (tenant_id, fbpi_order_nr) DO NOTHING
    RETURNING id
  `);

  return result.rows.length > 0;
}

/**
 * Deducts the sold units from the shared pool.
 *
 * Only `MP_ITEM_STATUS_CONFIRMED` items move stock — a line cancelled by the
 * marketplace before it reached us was never ours to ship.
 *
 * Note what this does *not* do: it does not create a Voltix `orders` row. A
 * noon order has no Voltix customer, no local cart, no payment intent and no
 * address until `GetFbpiOrderCustomerData` is called, and manufacturing a
 * synthetic order record to hold it would put rows into the revenue and VAT
 * reporting tables for a sale that noon invoices, not us. The link row plus
 * the stock movement is the honest representation; `docs/07-roadmap.md` tracks
 * surfacing these in admin as a distinct "marketplace orders" view.
 */
async function applyStockEffect(
  tx: Tx,
  tenantId: string,
  order: FbpiOrder,
): Promise<ImportResult['unmapped']> {
  const unmapped: ImportResult['unmapped'] = [];

  const warehouse = await tx.execute<{ warehouse_id: string }>(sql`
    SELECT warehouse_id FROM noon_warehouse_map
     WHERE tenant_id = ${tenantId} AND warehouse_code = ${order.warehouse_code}
  `);
  const warehouseId = warehouse.rows[0]?.warehouse_id;
  if (!warehouseId) {
    // The order arrived for a warehouse we have no mapping for. Recorded on
    // the link row so it surfaces, rather than throwing and stalling the
    // import of every other order in the window.
    await noteError(
      tx,
      tenantId,
      order.fbpi_order_nr,
      `No Voltix warehouse mapped to noon warehouse_code "${order.warehouse_code}"`,
    );
    return unmapped;
  }

  for (const item of order.items) {
    if (item.mp_status !== 'MP_ITEM_STATUS_CONFIRMED') continue;

    const listing = await tx.execute<{ variant_id: string }>(sql`
      SELECT variant_id FROM noon_listings
       WHERE tenant_id = ${tenantId} AND partner_sku = ${item.partner_sku}
    `);
    const variantId = listing.rows[0]?.variant_id;

    if (!variantId) {
      unmapped.push({ fbpiOrderNr: order.fbpi_order_nr, partnerSku: item.partner_sku });
      continue;
    }

    // One unit per marketplace item line — noon models quantity as repeated
    // `mp_item_nr` entries rather than a qty field.
    const updated = await tx.execute<{ on_hand: number }>(sql`
      UPDATE stock_levels
         SET on_hand = on_hand - 1,
             version = version + 1,
             updated_at = now()
       WHERE tenant_id = ${tenantId}
         AND variant_id = ${variantId}
         AND warehouse_id = ${warehouseId}
      RETURNING on_hand
    `);

    const balanceAfter = updated.rows[0]?.on_hand;
    if (balanceAfter === undefined) {
      unmapped.push({ fbpiOrderNr: order.fbpi_order_nr, partnerSku: item.partner_sku });
      continue;
    }

    await tx.execute(sql`
      INSERT INTO stock_movements
        (id, tenant_id, variant_id, warehouse_id, delta, balance_after, reason,
         reference_type, reference_id, note, created_at)
      VALUES
        (${uuidv7()}, ${tenantId}, ${variantId}, ${warehouseId}, -1,
         ${Number(balanceAfter)}, 'sale', 'noon_order', NULL,
         ${`noon ${order.mp_order_nr} item ${item.mp_item_nr}`}, now())
    `);
  }

  return unmapped;
}

async function noteError(
  tx: Tx,
  tenantId: string,
  fbpiOrderNr: string,
  message: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE noon_order_links
       SET last_error = ${message}, updated_at = now()
     WHERE tenant_id = ${tenantId} AND fbpi_order_nr = ${fbpiOrderNr}
  `);
}
