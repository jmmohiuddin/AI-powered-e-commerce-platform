import 'server-only';
import { sql } from 'drizzle-orm';
import { withTenant } from '@voltix/db';

/**
 * RETURNS READ MODEL
 *
 * The queue a returns desk works from. Ordered oldest-first rather than
 * newest-first, unlike every other list in the admin: a return that has sat
 * unapproved for four days is the one costing goodwill, and putting the newest
 * at the top is how the oldest never gets looked at.
 */

export interface ReturnRow {
  readonly id: string;
  readonly number: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly status: string;
  readonly reason: string;
  readonly resolution: string;
  readonly refundAmount: number;
  readonly currency: string;
  readonly restockable: boolean | null;
  readonly itemCount: number;
  readonly customerName: string | null;
  readonly createdAt: Date | null;
  /** Whole days since the request was opened — the ageing signal. */
  readonly ageDays: number;
}

export interface ReturnListResult {
  readonly rows: readonly ReturnRow[];
  readonly total: number;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** Statuses where a human still has to do something. */
export const OPEN_RETURN_STATUSES = [
  'requested',
  'approved',
  'in_transit',
  'received',
  'inspected',
] as const;

export async function listReturns(
  tenantId: string,
  filters: { status?: string | undefined; open?: boolean | undefined; limit?: number | undefined } = {},
): Promise<ReturnListResult> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);

  return withTenant(tenantId, async (tx) => {
    const conditions = [sql`r.tenant_id = ${tenantId}`];
    if (filters.status) conditions.push(sql`r.status = ${filters.status}::return_status`);
    if (filters.open) {
      conditions.push(
        sql`r.status IN (${sql.join(
          OPEN_RETURN_STATUSES.map((s) => sql`${s}::return_status`),
          sql`, `,
        )})`,
      );
    }
    const where = sql.join(conditions, sql` AND `);

    const totals = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM returns r WHERE ${where}
    `);

    const rows = await tx.execute<{
      id: string;
      number: string;
      order_id: string;
      order_number: string;
      status: string;
      reason: string;
      resolution: string;
      refund_amount: string;
      currency: string;
      restockable: boolean | null;
      item_count: number;
      customer_name: string | null;
      created_at: Date | string | null;
      age_days: number;
    }>(sql`
      SELECT r.id, r.number, r.order_id, o.number AS order_number,
             r.status::text, r.reason::text, r.resolution::text,
             r.refund_amount, r.currency, r.restockable,
             (SELECT coalesce(sum(ri.quantity), 0)::int FROM return_items ri
               WHERE ri.return_id = r.id) AS item_count,
             o.shipping_address->>'recipientName' AS customer_name,
             r.created_at,
             extract(day FROM now() - r.created_at)::int AS age_days
      FROM returns r
      JOIN orders o ON o.id = r.order_id
      WHERE ${where}
      -- Oldest first: the point of this screen is the thing that has waited.
      ORDER BY r.created_at ASC
      LIMIT ${limit}
    `);

    return {
      total: Number(totals.rows[0]?.n ?? 0),
      rows: rows.rows.map((r) => ({
        id: r.id,
        number: r.number,
        orderId: r.order_id,
        orderNumber: r.order_number,
        status: r.status,
        reason: r.reason,
        resolution: r.resolution,
        refundAmount: Number(r.refund_amount),
        currency: r.currency,
        restockable: r.restockable,
        itemCount: Number(r.item_count),
        customerName: r.customer_name,
        createdAt: toDate(r.created_at),
        ageDays: Number(r.age_days),
      })),
    };
  });
}
