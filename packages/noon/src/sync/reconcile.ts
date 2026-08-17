/**
 * DRIFT RECONCILIATION — does noon actually hold what we think it holds?
 *
 * The diff in stock.ts trusts `pushed_qty`: if noon accepted 25 last time and
 * the local figure is still 25, nothing is sent. That is what keeps the sync
 * cheap, and it is correct exactly as long as nothing changes noon's copy
 * behind our back. Things do:
 *
 *   • an operator edits a quantity in Seller Lab by hand,
 *   • noon decrements on a marketplace sale we have not imported yet,
 *   • an accepted batch is later reverted on their side,
 *   • a bug here writes `pushed_qty` for an item that was actually rejected.
 *
 * In every case the local diff says "already in sync" forever, and the listing
 * stays wrong until a human notices. This job is the check that closes that
 * loop: it reads noon's own figures and, where they disagree, clears
 * `pushed_qty` so the next stock push treats the listing as unsynced.
 *
 * It deliberately does not push. Repair belongs to one code path — the one
 * that is already tested and already handles partial rejection — and a
 * reconcile that also writes would be a second, less-exercised copy of it.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '@voltix/db';
import type { NoonClient } from '../client.js';
import { chunk } from './batch.js';

export interface DriftReport {
  readonly checked: number;
  readonly drifted: Array<{
    partnerSku: string;
    warehouseCode: string;
    /** What noon holds. */
    remote: number;
    /** What we last recorded as accepted. */
    expected: number | null;
  }>;
}

/**
 * noon's stock read is per warehouse, so the sweep runs once per mapped
 * warehouse. `partnerSkuLimit` bounds a single run: a 40,000-SKU catalogue
 * would otherwise be one enormous job, and the sweep is oldest-first so
 * successive runs cover everything without needing a cursor.
 */
export async function reconcileStock(
  db: Database,
  client: NoonClient,
  tenantId: string,
  options: { partnerSkuLimit?: number } = {},
): Promise<DriftReport> {
  const limit = options.partnerSkuLimit ?? 2000;

  const warehouses = await db.transaction(async (tx) => {
    const result = await tx.execute<{ warehouse_code: string }>(sql`
      SELECT warehouse_code FROM noon_warehouse_map
       WHERE tenant_id = ${tenantId} AND is_active
    `);
    return result.rows;
  });

  const drifted: DriftReport['drifted'] = [];
  let checked = 0;

  for (const { warehouse_code: warehouseCode } of warehouses) {
    const listings = await db.transaction(async (tx) => {
      const result = await tx.execute<{
        id: string;
        partner_sku: string;
        pushed_qty: number | null;
      }>(sql`
        SELECT id, partner_sku, pushed_qty
          FROM noon_listings
         WHERE tenant_id = ${tenantId}
           AND status = 'live'
           AND sync_enabled
         ORDER BY pushed_qty_at ASC NULLS FIRST
         LIMIT ${limit}
      `);
      return result.rows;
    });

    const bySku = new Map(listings.map((row) => [row.partner_sku, row]));

    for (const batch of chunk([...bySku.keys()])) {
      // Outside a transaction — see the note on transaction shape in stock.ts.
      const remote = await client.getStock(warehouseCode, batch);
      checked += batch.length;

      const divergent = remote
        .map((entry) => ({ entry, local: bySku.get(entry.partner_sku) }))
        .filter(
          (pair): pair is { entry: (typeof remote)[number]; local: (typeof listings)[number] } =>
            pair.local !== undefined &&
            (pair.local.pushed_qty === null ? null : Number(pair.local.pushed_qty)) !==
              Number(pair.entry.qty),
        );

      if (divergent.length === 0) continue;

      await db.transaction(async (tx) => {
        for (const { entry, local } of divergent) {
          const expected = local.pushed_qty === null ? null : Number(local.pushed_qty);

          drifted.push({
            partnerSku: entry.partner_sku,
            warehouseCode,
            remote: Number(entry.qty),
            expected,
          });

          // Clearing the marker is the whole repair. The next stock push sees
          // an unsynced listing and re-sends the authoritative local figure.
          await tx.execute(sql`
            UPDATE noon_listings
               SET pushed_qty = NULL,
                   last_error = ${`Drift: noon held ${entry.qty}, we recorded ${expected ?? 'nothing'}`},
                   last_error_at = now(),
                   updated_at = now()
             WHERE id = ${local.id} AND tenant_id = ${tenantId}
          `);
        }
      });
    }
  }

  return { checked, drifted };
}
