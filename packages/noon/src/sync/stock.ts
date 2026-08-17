/**
 * STOCK PUSH — Voltix stock levels → noon.
 *
 * THE QUANTITY THAT GETS SENT
 * ---------------------------
 * `on_hand - reserved`, floored at zero. Not `on_hand`.
 *
 * A reservation is a unit that a Voltix shopper has at checkout and has not
 * yet paid for. Publishing it to noon offers the same physical unit to two
 * marketplaces at once, and the loser of that race is a noon order that cannot
 * be fulfilled — which on noon costs a cancellation against the seller's
 * fulfilment rate, not merely a refund.
 *
 * Backorderable variants are the deliberate exception: `allow_backorder` means
 * the merchant has said they can source more, so the local availability model
 * already sells below zero. Sending 0 for those would hide sellable stock.
 * They are excluded from the sync entirely rather than guessed at, because
 * "how many can I promise" is a purchasing question this module cannot answer.
 *
 * IDEMPOTENCE
 * -----------
 * noon's quantity is absolute, so a duplicated push is harmless and a lost one
 * is corrected by the next sweep. That is the property that lets the job
 * runner be at-least-once without a distributed lock.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '@voltix/db';
import type { NoonClient, StockUpdateItem } from '../client.js';
import { chunk } from './batch.js';
import { emptyOutcome, mergeOutcomes, type SyncOutcome, type Tx } from './types.js';

/** One variant's desired quantity in one noon warehouse. */
export interface DesiredStock {
  readonly listingId: string;
  readonly partnerSku: string;
  readonly warehouseCode: string;
  readonly available: number;
  readonly pushedQty: number | null;
}

/**
 * Reads what noon *should* be told, for listings that are live and enabled.
 *
 * `variantIds` narrows the sweep to the variants a stock movement just
 * touched; omitting it selects the whole catalogue, which is what the
 * reconcile job wants.
 *
 * The `consecutive_failures` ceiling stops a permanently broken listing — a
 * SKU noon does not recognise, say — from consuming a slot in every batch
 * forever. It is deliberately high enough that transient rejections recover
 * on their own, and the counter resets on the first success.
 */
export async function readDesiredStock(
  tx: Tx,
  tenantId: string,
  variantIds?: readonly string[],
): Promise<DesiredStock[]> {
  const result = await tx.execute<{
    listing_id: string;
    partner_sku: string;
    warehouse_code: string;
    available: number;
    pushed_qty: number | null;
  }>(sql`
    SELECT
      l.id            AS listing_id,
      l.partner_sku   AS partner_sku,
      w.warehouse_code AS warehouse_code,
      GREATEST(0, s.on_hand - s.reserved) AS available,
      l.pushed_qty    AS pushed_qty
    FROM noon_listings l
    JOIN stock_levels s
      ON s.variant_id = l.variant_id
     AND s.tenant_id  = l.tenant_id
    JOIN noon_warehouse_map w
      ON w.warehouse_id = s.warehouse_id
     AND w.tenant_id    = l.tenant_id
     AND w.is_active
    WHERE l.tenant_id = ${tenantId}
      AND l.status = 'live'
      AND l.sync_enabled
      AND l.consecutive_failures < 10
      -- Backorderable stock is not a quantity we can honestly publish. See
      -- the note at the top of this file.
      AND NOT s.allow_backorder
      -- Bound as a single array parameter. Interpolating the ids into the SQL
      -- text would be an injection site reachable from a job payload, which is
      -- written by a trigger but stored as user-adjacent JSON.
      ${variantIds && variantIds.length > 0 ? sql`AND l.variant_id = ANY(${variantIds}::uuid[])` : sql``}
  `);

  return result.rows.map((row) => ({
    listingId: row.listing_id,
    partnerSku: row.partner_sku,
    warehouseCode: row.warehouse_code,
    available: Number(row.available),
    pushedQty: row.pushed_qty === null ? null : Number(row.pushed_qty),
  }));
}

/** Only what has actually changed since the last accepted push. */
export function selectChanged(desired: readonly DesiredStock[]): DesiredStock[] {
  return desired.filter((row) => row.pushedQty !== row.available);
}

/**
 * Pushes stock for one tenant.
 *
 * TRANSACTION SHAPE
 * -----------------
 * Takes a `Database`, not a `Tx`, and opens several short transactions rather
 * than one long one. This mirrors `dispatchNotifications`: the read happens in
 * a transaction, the HTTP call happens outside any transaction, and the result
 * is recorded in another. Holding a Postgres transaction open across a
 * multi-second call to noon would pin a pooled connection, block vacuum on
 * `noon_listings`, and turn one slow marketplace response into database-wide
 * contention.
 *
 * The cost of that choice is that a crash between the call and the record
 * leaves noon updated and `pushed_qty` stale. That is the safe direction: the
 * next sweep recomputes the same diff and re-sends an identical absolute
 * quantity, which is a no-op on noon's side.
 *
 * Batches are sent one at a time rather than concurrently. noon's limit is
 * 1,500 requests per 60 seconds and a full catalogue sweep is a few dozen
 * calls, so parallelism buys almost nothing while making a 429 far more likely.
 */
export async function pushStock(
  db: Database,
  client: NoonClient,
  tenantId: string,
  options: { variantIds?: readonly string[] } = {},
): Promise<SyncOutcome> {
  const desired = await db.transaction((tx) => readDesiredStock(tx, tenantId, options.variantIds));
  const changed = selectChanged(desired);

  let outcome: SyncOutcome = { ...emptyOutcome(), skipped: desired.length - changed.length };

  for (const batch of chunk(changed)) {
    outcome = mergeOutcomes(outcome, await pushBatch(db, client, tenantId, batch));
  }

  return outcome;
}

export function toStockItems(batch: readonly DesiredStock[]): StockUpdateItem[] {
  return batch.map((row) => ({
    warehouse_code: row.warehouseCode,
    partner_sku: row.partnerSku,
    qty: row.available,
  }));
}

async function pushBatch(
  db: Database,
  client: NoonClient,
  tenantId: string,
  batch: DesiredStock[],
): Promise<SyncOutcome> {
  // Outside any transaction. A transport failure aborts this batch only; the
  // pushed_* columns are untouched, so the next attempt re-sends exactly these.
  const result = await client.updateStock(toStockItems(batch));

  const byKey = new Map(batch.map((row) => [`${row.warehouseCode}/${row.partnerSku}`, row]));
  const accepted = result.accepted
    .map((item) => byKey.get(item.key))
    .filter((row): row is DesiredStock => row !== undefined);

  await db.transaction(async (tx) => {
    if (accepted.length > 0) await recordAccepted(tx, tenantId, accepted);

    for (const rejection of result.rejected) {
      const row = byKey.get(rejection.key);
      if (row) {
        await recordRejected(tx, tenantId, row.listingId, rejection.message || rejection.statusCode);
      }
    }
  });

  return {
    skipped: 0,
    accepted: accepted.length,
    rejected: result.rejected.map((item) => ({ key: item.key, reason: item.message })),
    failedBatches: 0,
  };
}

/**
 * Records the quantity noon confirmed.
 *
 * Written per listing rather than in one statement because a listing can be
 * mapped to several warehouses, and `pushed_qty` is a single column: the last
 * warehouse written wins. That is a known simplification — the diff stays
 * correct for the single-warehouse case that is live today, and the reconcile
 * sweep catches the multi-warehouse case because it compares against noon's
 * own figures rather than this column. `docs/07-roadmap.md` tracks widening
 * this to a per-warehouse row.
 */
async function recordAccepted(tx: Tx, tenantId: string, rows: DesiredStock[]): Promise<void> {
  for (const row of rows) {
    await tx.execute(sql`
      UPDATE noon_listings
         SET pushed_qty = ${row.available},
             pushed_qty_at = now(),
             consecutive_failures = 0,
             last_error = NULL,
             updated_at = now()
       WHERE id = ${row.listingId} AND tenant_id = ${tenantId}
    `);
  }
}

async function recordRejected(
  tx: Tx,
  tenantId: string,
  listingId: string,
  reason: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE noon_listings
       SET last_error = ${reason},
           last_error_at = now(),
           consecutive_failures = consecutive_failures + 1,
           updated_at = now()
     WHERE id = ${listingId} AND tenant_id = ${tenantId}
  `);
}
