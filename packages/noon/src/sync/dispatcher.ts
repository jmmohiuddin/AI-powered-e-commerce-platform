/**
 * THE SYNC LOOP
 *
 * Called by the worker on every tick, alongside `dispatchNotifications` and
 * for the same reason: this is work that talks to the network, so it lives
 * outside the job runner's per-job transaction.
 *
 * WHY THERE IS NO "ON STOCK CHANGE, ENQUEUE A JOB" TRIGGER
 * -------------------------------------------------------
 * The obvious design is to enqueue a sync job from every code path that moves
 * stock or edits a price. It was rejected, and the reason is worth stating
 * because the alternative looks lazier than it is.
 *
 * An enqueue-on-write design is only as complete as its call sites. Checkout
 * moves stock; so does the returns flow, the purchase-order receipt, the
 * stocktake adjustment, the admin quantity edit, the reservation sweep, and
 * the noon order import in orders.ts. Every one of them must remember to
 * enqueue, forever, including the ones written next year. A single missed call
 * site produces a listing that is silently wrong until someone reconciles it —
 * the exact failure this integration exists to prevent.
 *
 * Diffing desired-against-pushed has no call sites to miss. Any change made by
 * any code path, present or future, shows up in the next tick's diff because
 * the diff reads the resulting state rather than trusting a notification about
 * it. The cost is one indexed query per tick per tenant, which is cheaper than
 * the class of bug it removes.
 *
 * `MIN_SWEEP_INTERVAL_MS` keeps that query off a 5-second cadence it does not
 * need — stock reaching noon within a minute is well inside the marketplace's
 * own processing latency.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '@voltix/db';
import { NoonApiError } from '../errors.js';
import type { NoonClient } from '../client.js';
import { pushStock } from './stock.js';
import { pushPrices } from './pricing.js';
import { importOrders, sinceWithLap } from './orders.js';
import { reconcileStock } from './reconcile.js';
import { mergeOutcomes, emptyOutcome, type SyncOutcome } from './types.js';

export interface DispatchSummary {
  readonly stock: SyncOutcome;
  readonly price: SyncOutcome;
  readonly ordersImported: number;
  readonly driftFound: number;
  /** Set when the pass ended early because noon was unreachable. */
  readonly abortedWith?: string;
}

const MIN_SWEEP_INTERVAL_MS = Number(process.env.NOON_SWEEP_INTERVAL_MS ?? 60_000);
const RECONCILE_INTERVAL_MS = Number(process.env.NOON_RECONCILE_INTERVAL_MS ?? 15 * 60_000);
const ORDER_PULL_INTERVAL_MS = Number(process.env.NOON_ORDER_PULL_INTERVAL_MS ?? 5 * 60_000);

/**
 * Per-process clocks.
 *
 * In-memory rather than in the database because they are a politeness
 * throttle, not a correctness mechanism. Two workers each running the sweep on
 * their own schedule is harmless — the second finds nothing changed and sends
 * nothing — whereas a shared lock would add a failure mode to save a query.
 */
const lastRun = { sweep: 0, reconcile: 0, orders: 0 };

/** Tenants with at least one mapped listing. Nothing to do for the rest. */
async function activeTenants(db: Database): Promise<string[]> {
  const result = await db.transaction(async (tx) => {
    const rows = await tx.execute<{ tenant_id: string }>(sql`
      SELECT DISTINCT tenant_id FROM noon_listings WHERE sync_enabled
    `);
    return rows.rows;
  });
  return result.map((row) => row.tenant_id);
}

export async function dispatchNoonSync(
  db: Database,
  client: NoonClient,
  options: { now?: number } = {},
): Promise<DispatchSummary> {
  const now = options.now ?? Date.now();

  let summary: DispatchSummary = {
    stock: emptyOutcome(),
    price: emptyOutcome(),
    ordersImported: 0,
    driftFound: 0,
  };

  const dueSweep = now - lastRun.sweep >= MIN_SWEEP_INTERVAL_MS;
  const dueOrders = now - lastRun.orders >= ORDER_PULL_INTERVAL_MS;
  const dueReconcile = now - lastRun.reconcile >= RECONCILE_INTERVAL_MS;

  if (!dueSweep && !dueOrders && !dueReconcile) return summary;

  const tenants = await activeTenants(db);

  for (const tenantId of tenants) {
    try {
      if (dueSweep) {
        summary = {
          ...summary,
          stock: mergeOutcomes(summary.stock, await pushStock(db, client, tenantId)),
          price: mergeOutcomes(summary.price, await pushPrices(db, client, tenantId)),
        };
      }

      if (dueOrders) {
        summary = { ...summary, ordersImported: summary.ordersImported + (await pullOrders(db, client, tenantId)) };
      }

      if (dueReconcile) {
        const report = await reconcileStock(db, client, tenantId);
        summary = { ...summary, driftFound: summary.driftFound + report.drifted.length };
      }
    } catch (error) {
      // noon being down must not stop the worker or the other tenants. A
      // retryable error simply means the next tick tries again — the diff is
      // recomputed from scratch, so nothing is lost by giving up here.
      if (error instanceof NoonApiError && error.isRetryable) {
        summary = { ...summary, abortedWith: error.message };
        break;
      }
      throw error;
    }
  }

  if (dueSweep) lastRun.sweep = now;
  if (dueOrders) lastRun.orders = now;
  if (dueReconcile) lastRun.reconcile = now;

  return summary;
}

/**
 * Pulls orders for every mapped warehouse.
 *
 * The window starts from the most recent successful import, lapped backwards.
 * Deriving it from `noon_order_links` rather than keeping a cursor table means
 * there is no separate piece of state that can disagree with reality — the
 * data itself says how far the import got.
 */
async function pullOrders(db: Database, client: NoonClient, tenantId: string): Promise<number> {
  const rows = await db.transaction(async (tx) => {
    const warehouses = await tx.execute<{ warehouse_code: string; last_import: Date | null }>(sql`
      SELECT w.warehouse_code AS warehouse_code,
             (SELECT MAX(l.imported_at) FROM noon_order_links l
               WHERE l.tenant_id = w.tenant_id AND l.warehouse_code = w.warehouse_code)
             AS last_import
        FROM noon_warehouse_map w
       WHERE w.tenant_id = ${tenantId} AND w.is_active
    `);
    return warehouses.rows;
  });

  let imported = 0;
  const now = new Date();

  for (const row of rows) {
    const result = await importOrders(db, client, tenantId, row.warehouse_code, {
      since: sinceWithLap(row.last_import ? new Date(row.last_import) : null, now),
    });
    imported += result.imported;

    if (result.unmapped.length > 0) {
      // Not an error the sync can fix: someone sold a SKU on noon that has no
      // Voltix variant. Logged loudly because the stock for it is now wrong.
      console.warn(
        `  noon: ${result.unmapped.length} order line(s) reference unmapped SKUs — ` +
          result.unmapped
            .slice(0, 5)
            .map((entry) => `${entry.partnerSku} (${entry.fbpiOrderNr})`)
            .join(', '),
      );
    }
  }

  return imported;
}

/** Exposed for tests, which must not inherit another test's throttle state. */
export function resetDispatchClocks(): void {
  lastRun.sweep = 0;
  lastRun.reconcile = 0;
  lastRun.orders = 0;
}
