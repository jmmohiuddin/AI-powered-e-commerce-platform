import 'server-only';
import { sql } from 'drizzle-orm';
import { withTenant } from '@voltix/db';
import {
  classifyInventory,
  forecastDemand,
  recommendReplenishment,
  type DemandPoint,
  type Forecast,
  type InventoryClassification,
  type ReplenishmentAdvice,
} from '@voltix/ai';

/**
 * INVENTORY ANALYSIS ON REAL SALES HISTORY
 *
 * The forecasting itself is pure and already tested; this module's whole job is
 * getting it honest inputs. Two details in the SQL below do most of that work:
 *
 *  • **Zero-sales days are materialised.** `generate_series` produces every
 *    date in the window and left-joins sales onto it. Without that, a SKU that
 *    sold 5 units on three days looks like a steady 5/day series instead of the
 *    intermittent 0.16/day it actually is — and Croston's method, which exists
 *    precisely for intermittent demand, never gets selected. This is the single
 *    most common way a demand forecast is quietly wrong by an order of
 *    magnitude.
 *
 *  • **Cancelled orders are excluded.** They were never demand.
 */

const HISTORY_DAYS = 90;
const HORIZON_DAYS = 30;

export interface InventoryRow {
  readonly variantId: string;
  readonly sku: string;
  readonly title: string;
  readonly onHand: number;
  readonly reserved: number;
  readonly incoming: number;
  readonly leadTimeDays: number;
  readonly unitCost: number | null;
  readonly unitPrice: number;
  readonly tiedUpCapital: number;
  readonly marginBps: number | null;
  readonly daysSinceLastSale: number | null;
  readonly forecast: Forecast;
  readonly advice: ReplenishmentAdvice;
  readonly health: {
    readonly classification: InventoryClassification;
    readonly suggestedMarkdownBps: number;
  };
}

export async function analyseInventory(tenantId: string): Promise<InventoryRow[]> {
  return withTenant(tenantId, async (tx) => {
    const stock = await tx.execute<{
      variant_id: string;
      sku: string;
      title: string;
      variant_title: string | null;
      on_hand: string;
      reserved: string;
      incoming: string;
      lead_time_days: number | null;
      unit_cost: string | null;
      unit_price: string;
      days_since_last_sale: number | null;
    }>(sql`
      SELECT v.id                          AS variant_id,
             v.sku,
             p.title,
             v.title                       AS variant_title,
             coalesce(sum(sl.on_hand), 0)  AS on_hand,
             coalesce(sum(sl.reserved), 0) AS reserved,
             coalesce(sum(sl.incoming), 0) AS incoming,
             -- Lead time belongs to the *supplier relationship*, not to the
             -- product: the same handset is 5 days from a Dubai distributor and
             -- 30 from an overseas one. The preferred supplier wins, since that
             -- is who the purchase order would actually go to.
             (SELECT sp.lead_time_days FROM supplier_products sp
               WHERE sp.variant_id = v.id
               ORDER BY sp.is_preferred DESC, sp.lead_time_days NULLS LAST
               LIMIT 1)                    AS lead_time_days,
             v.cost_price                  AS unit_cost,
             v.price                       AS unit_price,
             (SELECT (current_date - max(o.placed_at)::date)
                FROM order_items oi
                JOIN orders o ON o.id = oi.order_id
               WHERE oi.variant_id = v.id AND o.status <> 'cancelled') AS days_since_last_sale
      FROM variants v
      JOIN products p ON p.id = v.product_id
      LEFT JOIN stock_levels sl ON sl.variant_id = v.id
      WHERE v.tenant_id = ${tenantId}
        AND v.deleted_at IS NULL
        AND p.deleted_at IS NULL
        AND v.is_active = true
      GROUP BY v.id, v.sku, p.title, v.title, v.cost_price, v.price
      ORDER BY p.title
    `);

    if (stock.rows.length === 0) return [];

    const history = await tx.execute<{ variant_id: string; day: string; units: string }>(sql`
      -- Sales are aggregated to (variant, day) FIRST, then left-joined onto the
      -- full date spine. Doing it the other way — left-joining order_items to
      -- the spine and filtering by day on the orders join — silently gives every
      -- day the variant's entire lifetime total: a row that fails the orders
      -- predicate still contributes its oi.quantity to the sum. The forecast
      -- then sees a flat series many times the true rate and every SKU reads as
      -- a stockout emergency.
      WITH sales AS (
        SELECT oi.variant_id, o.placed_at::date AS day, sum(oi.quantity) AS units
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE oi.tenant_id = ${tenantId}
          AND o.status <> 'cancelled'
          AND o.placed_at >= current_date - ${HISTORY_DAYS}::int
        GROUP BY oi.variant_id, o.placed_at::date
      )
      SELECT v.id AS variant_id,
             d.day::date::text AS day,
             coalesce(s.units, 0) AS units
      FROM variants v
      CROSS JOIN generate_series(
        current_date - ${HISTORY_DAYS}::int, current_date - 1, interval '1 day'
      ) AS d(day)
      LEFT JOIN sales s ON s.variant_id = v.id AND s.day = d.day::date
      WHERE v.tenant_id = ${tenantId} AND v.deleted_at IS NULL
      ORDER BY v.id, d.day
    `);

    const byVariant = new Map<string, DemandPoint[]>();
    for (const row of history.rows) {
      const points = byVariant.get(row.variant_id) ?? [];
      points.push({ date: row.day, units: Number(row.units) });
      byVariant.set(row.variant_id, points);
    }

    return stock.rows.map((row) => {
      const onHand = Number(row.on_hand);
      const incoming = Number(row.incoming);
      // cost_price is nullable — a catalogue can be loaded before costs are.
      // Treating null as 0 would report 100% margin and AED 0 of capital tied
      // up, which is a more confident lie than showing nothing.
      const unitCost = row.unit_cost === null ? 0 : Number(row.unit_cost);
      const hasCost = row.unit_cost !== null;
      const unitPrice = Number(row.unit_price);
      const leadTimeDays = row.lead_time_days ?? 14;

      const forecast = forecastDemand(byVariant.get(row.variant_id) ?? [], HORIZON_DAYS);
      const advice = recommendReplenishment({ forecast, onHand, incoming, leadTimeDays });
      const health = classifyInventory({
        daysOfCover: advice.daysOfCover,
        daysSinceLastSale: row.days_since_last_sale,
        unitsOnHand: onHand,
      });

      return {
        variantId: row.variant_id,
        sku: row.sku,
        title: row.variant_title ? `${row.title} — ${row.variant_title}` : row.title,
        onHand,
        reserved: Number(row.reserved),
        incoming,
        leadTimeDays,
        unitCost: hasCost ? unitCost : null,
        unitPrice,
        tiedUpCapital: onHand * unitCost,
        // Margin against the *selling* price, not against cost. Marking up 20%
        // and margin of 20% are different numbers, and conflating them is how a
        // retailer thinks a category is profitable when it is not.
        marginBps: hasCost && unitPrice > 0
          ? Math.round(((unitPrice - unitCost) / unitPrice) * 10_000)
          : null,
        daysSinceLastSale: row.days_since_last_sale,
        forecast,
        advice,
        health,
      };
    });
  });
}
