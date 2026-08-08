import { sql } from 'drizzle-orm';
import { uuidv7 } from '@voltix/db';
import {
  classifyInventory,
  forecastDemand,
  recommendReplenishment,
  type DemandPoint,
} from '@voltix/ai';
import type { Tx } from './types';

/**
 * NIGHTLY ANALYTICS JOBS
 *
 * `forecast.refresh` and `inventory.classify` were registered as no-ops, which
 * meant `demand_forecasts` and `inventory_health` were tables nothing ever
 * wrote to. The admin's inventory screen worked around that by recomputing
 * every forecast on each page load — correct, but it does a 90-day history
 * scan per variant per request, which is fine for six products and untenable
 * for six thousand.
 *
 * These handlers move that work to a scheduled job and persist the result, so
 * the screen becomes a read. Nothing about the maths changes: they call the
 * same pure functions in `@voltix/ai` the page already called, so the numbers
 * cannot drift between the two.
 *
 * Both run across every tenant, which is why they belong to the worker rather
 * than a request. They are idempotent: each writes one current row per variant
 * and replaces its own previous output, so a retry costs a rewrite rather than
 * producing duplicates.
 */

const HISTORY_DAYS = 90;
const HORIZON_DAYS = 30;

/** Loads a zero-filled daily demand series per variant for one tenant. */
async function demandHistory(tx: Tx, tenantId: string): Promise<Map<string, DemandPoint[]>> {
  const rows = await tx.execute<{ variant_id: string; day: string; units: string }>(sql`
    -- Sales are aggregated to (variant, day) FIRST, then left-joined onto a
    -- full date spine. Filtering by day on the orders join instead would give
    -- every day the variant's entire lifetime total — the forecast then sees a
    -- flat series many times the true rate and every SKU reads as an emergency.
    WITH sales AS (
      SELECT oi.variant_id, o.placed_at::date AS day, sum(oi.quantity) AS units
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.tenant_id = ${tenantId}
        AND o.status <> 'cancelled'
        AND o.placed_at >= current_date - ${HISTORY_DAYS}::int
      GROUP BY oi.variant_id, o.placed_at::date
    )
    SELECT v.id AS variant_id, d.day::date::text AS day, coalesce(s.units, 0) AS units
    FROM variants v
    CROSS JOIN generate_series(
      current_date - ${HISTORY_DAYS}::int, current_date - 1, interval '1 day'
    ) AS d(day)
    LEFT JOIN sales s ON s.variant_id = v.id AND s.day = d.day::date
    WHERE v.tenant_id = ${tenantId} AND v.deleted_at IS NULL
    ORDER BY v.id, d.day
  `);

  const byVariant = new Map<string, DemandPoint[]>();
  for (const row of rows.rows) {
    const points = byVariant.get(row.variant_id) ?? [];
    points.push({ date: row.day, units: Number(row.units) });
    byVariant.set(row.variant_id, points);
  }
  return byVariant;
}

/**
 * A `type` with an index signature rather than an `interface`.
 *
 * `tx.execute<T>` constrains T to `Record<string, unknown>`, and TypeScript
 * does not treat a plain interface as satisfying that — interfaces are open to
 * declaration merging, so it cannot prove no other keys exist. A type alias is
 * closed, so the assignment checks.
 */
type StockRow = {
  variant_id: string;
  on_hand: string;
  incoming: string;
  unit_cost: string | null;
  currency: string;
  lead_time_days: number | null;
  days_since_last_sale: number | null;
};

async function stockPositions(tx: Tx, tenantId: string): Promise<StockRow[]> {
  const rows = await tx.execute<StockRow>(sql`
    SELECT v.id AS variant_id,
           coalesce(sum(sl.on_hand), 0)  AS on_hand,
           coalesce(sum(sl.incoming), 0) AS incoming,
           v.cost_price AS unit_cost,
           v.currency,
           (SELECT sp.lead_time_days FROM supplier_products sp
             WHERE sp.variant_id = v.id
             ORDER BY sp.is_preferred DESC, sp.lead_time_days NULLS LAST
             LIMIT 1) AS lead_time_days,
           (SELECT (current_date - max(o.placed_at)::date)
              FROM order_items oi JOIN orders o ON o.id = oi.order_id
             WHERE oi.variant_id = v.id AND o.status <> 'cancelled') AS days_since_last_sale
    FROM variants v
    LEFT JOIN stock_levels sl ON sl.variant_id = v.id
    WHERE v.tenant_id = ${tenantId} AND v.deleted_at IS NULL AND v.is_active = true
    GROUP BY v.id, v.cost_price, v.currency
  `);
  return rows.rows;
}

/** Every tenant that has an active catalogue worth forecasting. */
async function activeTenants(tx: Tx): Promise<string[]> {
  const rows = await tx.execute<{ tenant_id: string }>(sql`
    SELECT DISTINCT tenant_id FROM variants WHERE deleted_at IS NULL AND is_active = true
  `);
  return rows.rows.map((r) => r.tenant_id);
}

/**
 * Recomputes the demand forecast and replenishment advice for every variant.
 *
 * Writes one row per (variant, horizon) and deletes the previous generation for
 * that horizon first, so the table always holds exactly one current answer.
 * Keeping history would be useful for measuring forecast drift over time and is
 * the obvious next step — but a table that grows by every variant every night
 * needs a retention policy before it needs a first row.
 */
export async function refreshForecasts(tx: Tx): Promise<void> {
  const tenants = await activeTenants(tx);
  let written = 0;

  for (const tenantId of tenants) {
    const [history, stock] = await Promise.all([
      demandHistory(tx, tenantId),
      stockPositions(tx, tenantId),
    ]);
    if (stock.length === 0) continue;

    await tx.execute(sql`
      DELETE FROM demand_forecasts
      WHERE tenant_id = ${tenantId} AND horizon_days = ${HORIZON_DAYS}
    `);

    for (const row of stock) {
      const forecast = forecastDemand(history.get(row.variant_id) ?? [], HORIZON_DAYS);
      const advice = recommendReplenishment({
        forecast,
        onHand: Number(row.on_hand),
        incoming: Number(row.incoming),
        leadTimeDays: row.lead_time_days ?? 14,
      });

      await tx.execute(sql`
        INSERT INTO demand_forecasts
          (id, tenant_id, variant_id, warehouse_id, horizon_days, model_kind,
           predicted_units, lower_bound, upper_bound, safety_stock,
           reorder_recommendation, backtest_mape_bps, features, computed_at,
           created_at, updated_at)
        VALUES (${uuidv7()}, ${tenantId}, ${row.variant_id}, NULL, ${HORIZON_DAYS},
                ${forecast.method}, ${forecast.predictedUnits}, ${forecast.lowerBound},
                ${forecast.upperBound}, ${advice.safetyStock},
                ${advice.shouldReorder ? advice.recommendedQuantity : 0},
                ${forecast.backtestMapeBps},
                ${JSON.stringify({
                  dailyRate: forecast.dailyRate,
                  reorderPoint: advice.reorderPoint,
                  daysOfCover: Number.isFinite(advice.daysOfCover) ? advice.daysOfCover : null,
                  urgency: advice.urgency,
                })}::jsonb,
                now(), now(), now())
      `);
      written += 1;
    }
  }

  if (written > 0) console.log(`  refreshed ${written} forecast(s)`);
}

/**
 * Classifies every variant as healthy, at risk, overstocked, slow or dead.
 *
 * Depends on the forecast for days-of-cover, so it is scheduled after it. If a
 * forecast row is missing — first run, or a variant added since — cover is
 * computed from the same functions inline rather than skipping the variant:
 * a missing classification reads as "fine" on the dashboard, which is exactly
 * wrong for a product nobody has looked at.
 */
export async function classifyInventoryHealth(tx: Tx): Promise<void> {
  const tenants = await activeTenants(tx);
  let written = 0;

  for (const tenantId of tenants) {
    const [history, stock] = await Promise.all([
      demandHistory(tx, tenantId),
      stockPositions(tx, tenantId),
    ]);
    if (stock.length === 0) continue;

    await tx.execute(sql`DELETE FROM inventory_health WHERE tenant_id = ${tenantId}`);

    for (const row of stock) {
      const onHand = Number(row.on_hand);
      const forecast = forecastDemand(history.get(row.variant_id) ?? [], HORIZON_DAYS);
      const advice = recommendReplenishment({
        forecast,
        onHand,
        incoming: Number(row.incoming),
        leadTimeDays: row.lead_time_days ?? 14,
      });
      const health = classifyInventory({
        daysOfCover: advice.daysOfCover,
        daysSinceLastSale: row.days_since_last_sale,
        unitsOnHand: onHand,
      });

      // Capital is only meaningful where cost is known. Treating an unknown
      // cost as zero would report AED 0 tied up in a warehouse full of stock.
      const tiedUp = row.unit_cost === null ? 0 : onHand * Number(row.unit_cost);

      await tx.execute(sql`
        INSERT INTO inventory_health
          (id, tenant_id, variant_id, classification, days_of_cover, days_since_last_sale,
           units_on_hand, tied_up_capital, currency, suggested_markdown_bps, computed_at)
        VALUES (${uuidv7()}, ${tenantId}, ${row.variant_id}, ${health.classification},
                ${Number.isFinite(advice.daysOfCover) ? Math.round(advice.daysOfCover) : null},
                ${row.days_since_last_sale}, ${onHand}, ${tiedUp}, ${row.currency},
                ${health.suggestedMarkdownBps}, now())
      `);
      written += 1;
    }
  }

  if (written > 0) console.log(`  classified ${written} variant(s)`);
}
