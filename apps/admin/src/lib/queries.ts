import 'server-only';
import { sql } from 'drizzle-orm';
import { withTenant } from '@voltix/db';
import { availableActions, type FulfilmentStatus, type OrderStatus, type PaymentStatus } from '@voltix/core';

/**
 * ADMIN READ MODEL
 *
 * Every function here opens a tenant-scoped transaction, so row-level security
 * is active for the whole query. The tenant id comes from the session and never
 * from a URL or a form field — an admin that accepts a tenant id from the
 * client is not multi-tenant, it is single-tenant with extra steps.
 *
 * These are hand-written SQL rather than ORM query builders because they are
 * aggregates over several tables and the generated SQL for that is both slower
 * and harder to reason about than the statement you would have written anyway.
 */

/**
 * Coerces a timestamp from a raw SQL result into a real `Date`.
 *
 * `tx.execute()` returns driver rows without the ORM's column mapping, so a
 * `timestamptz` can arrive as a string depending on the type parsers in play.
 * The typings say `Date` and the value is not one — which fails at the first
 * `.getTime()`, in a template, at render time, as a 500.
 *
 * Normalising here means every consumer of this module gets a real Date, rather
 * than each page defending itself and one of them forgetting.
 */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export interface DashboardMetrics {
  readonly revenue: number;
  readonly revenueDeltaPct: number | null;
  readonly orders: number;
  readonly ordersDeltaPct: number | null;
  readonly averageOrderValue: number;
  readonly aovDeltaPct: number | null;
  readonly awaitingFulfilment: number;
  readonly unpaid: number;
  readonly currency: string;
}

/**
 * Today's trading, compared with the same day last week.
 *
 * Week-on-week rather than day-on-day, because retail demand is strongly
 * weekly: comparing a Saturday with a Friday tells you about the calendar, not
 * about the business. In the UAE the weekend is Sat–Sun, so the seven-day
 * offset also keeps weekend against weekend.
 *
 * The whole thing is one query with FILTER clauses rather than four round
 * trips. It also means both windows are measured against a single `now()`,
 * which matters at midnight — two queries either side of it compare different
 * days and produce a delta that is pure artefact.
 */
export async function dashboardMetrics(
  tenantId: string,
  currency: string,
): Promise<DashboardMetrics> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.execute<{
      revenue: string;
      orders: string;
      prior_revenue: string;
      prior_orders: string;
      awaiting_fulfilment: string;
      unpaid: string;
    }>(sql`
      SELECT
        coalesce(sum(total) FILTER (WHERE placed_at >= current_date), 0)          AS revenue,
        count(*)            FILTER (WHERE placed_at >= current_date)              AS orders,
        coalesce(sum(total) FILTER (WHERE placed_at >= current_date - 7
                                      AND placed_at <  current_date - 6), 0)      AS prior_revenue,
        count(*)            FILTER (WHERE placed_at >= current_date - 7
                                      AND placed_at <  current_date - 6)          AS prior_orders,
        count(*)            FILTER (WHERE fulfilment_status IN ('unfulfilled','partially_fulfilled')
                                      AND status NOT IN ('cancelled'))            AS awaiting_fulfilment,
        count(*)            FILTER (WHERE payment_status IN ('unpaid','authorised','failed')
                                      AND status NOT IN ('cancelled'))            AS unpaid
      FROM orders
      WHERE tenant_id = ${tenantId}
        -- Cancelled orders are excluded from revenue but counted in the
        -- operational tallies above via their own filters. Including them in
        -- revenue is the single most common way a dashboard overstates a day.
        AND status <> 'cancelled'
    `);

    const row = rows.rows[0];
    const revenue = Number(row?.revenue ?? 0);
    const orders = Number(row?.orders ?? 0);
    const priorRevenue = Number(row?.prior_revenue ?? 0);
    const priorOrders = Number(row?.prior_orders ?? 0);

    return {
      revenue,
      orders,
      // Null, not zero, when there is no prior period. "0% change" against a day
      // with no orders is a fabrication, and a green ▲ 0.0% on a store's first
      // week is worse than an honest dash.
      revenueDeltaPct: percentChange(revenue, priorRevenue),
      ordersDeltaPct: percentChange(orders, priorOrders),
      averageOrderValue: orders > 0 ? Math.round(revenue / orders) : 0,
      aovDeltaPct: percentChange(
        orders > 0 ? revenue / orders : 0,
        priorOrders > 0 ? priorRevenue / priorOrders : 0,
      ),
      awaitingFulfilment: Number(row?.awaiting_fulfilment ?? 0),
      unpaid: Number(row?.unpaid ?? 0),
      currency,
    };
  });
}

function percentChange(current: number, prior: number): number | null {
  if (prior === 0) return null;
  return ((current - prior) / prior) * 100;
}

export interface OrderRow {
  readonly id: string;
  readonly number: string;
  readonly status: OrderStatus;
  readonly paymentStatus: PaymentStatus;
  readonly fulfilmentStatus: FulfilmentStatus;
  readonly total: number;
  readonly currency: string;
  readonly placedAt: Date | null;
  readonly customerName: string | null;
  readonly emirate: string | null;
  readonly channel: string;
  readonly itemCount: number;
  readonly riskScore: number;
  readonly isGuest: boolean;
}

export interface OrderListResult {
  readonly rows: readonly OrderRow[];
  readonly total: number;
}

export interface OrderFilters {
  readonly status?: string;
  readonly paymentStatus?: string;
  readonly fulfilmentStatus?: string;
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * The order list.
 *
 * Paginated by offset rather than by cursor, deliberately. Offset pagination
 * degrades on deep pages, but this list is filtered and sorted by recency and
 * the realistic worst case is a merchant clicking to page 20 — the queries a
 * cursor would save are not the queries that hurt. Cursors also break the
 * "jump to page N" affordance that operators actually use when reconciling.
 */
export async function listOrders(
  tenantId: string,
  filters: OrderFilters = {},
): Promise<OrderListResult> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);

  return withTenant(tenantId, async (tx) => {
    const conditions = [sql`o.tenant_id = ${tenantId}`];

    if (filters.status) conditions.push(sql`o.status = ${filters.status}`);
    if (filters.paymentStatus) conditions.push(sql`o.payment_status = ${filters.paymentStatus}`);
    if (filters.fulfilmentStatus) {
      conditions.push(sql`o.fulfilment_status = ${filters.fulfilmentStatus}`);
    }

    if (filters.search?.trim()) {
      const term = filters.search.trim().replace(/^#/, '');
      // Order number, phone or recipient name. ILIKE with a leading wildcard
      // cannot use a btree index, which is fine at this table's size and is the
      // honest trade for "paste any fragment the customer read out on the
      // phone and find the order".
      const like = `%${term}%`;
      conditions.push(sql`(
        o.number ILIKE ${like}
        OR o.phone ILIKE ${like}
        OR o.email ILIKE ${like}
        OR o.shipping_address->>'recipientName' ILIKE ${like}
      )`);
    }

    const where = sql.join(conditions, sql` AND `);

    const rows = await tx.execute<{
      id: string;
      number: string;
      status: OrderStatus;
      payment_status: PaymentStatus;
      fulfilment_status: FulfilmentStatus;
      total: string;
      currency: string;
      placed_at: Date | string | null;
      channel: string;
      customer_id: string | null;
      shipping_address: { recipientName?: string; emirate?: string } | null;
      item_count: string;
      risk_score: number;
      total_count: string;
    }>(sql`
      SELECT o.id, o.number, o.status, o.payment_status, o.fulfilment_status,
             o.total, o.currency, o.placed_at, o.channel, o.customer_id, o.shipping_address,
             (SELECT coalesce(sum(quantity), 0) FROM order_items WHERE order_id = o.id) AS item_count,
             o.risk_score,
             -- A window function rather than a second COUNT(*) query: one round
             -- trip, and the count is guaranteed consistent with the page.
             count(*) OVER () AS total_count
      FROM orders o
      WHERE ${where}
      ORDER BY o.placed_at DESC NULLS LAST, o.number DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    return {
      total: Number(rows.rows[0]?.total_count ?? 0),
      rows: rows.rows.map((row) => ({
        id: row.id,
        number: row.number,
        status: row.status,
        paymentStatus: row.payment_status,
        fulfilmentStatus: row.fulfilment_status,
        total: Number(row.total),
        currency: row.currency,
        placedAt: toDate(row.placed_at),
        customerName: row.shipping_address?.recipientName ?? null,
        emirate: row.shipping_address?.emirate ?? null,
        channel: row.channel,
        itemCount: Number(row.item_count),
        riskScore: Number(row.risk_score),
        isGuest: row.customer_id === null,
      })),
    };
  });
}

export interface OrderDetail extends OrderRow {
  readonly email: string | null;
  readonly phone: string | null;
  readonly shippingAddress: Record<string, unknown> | null;
  readonly subtotal: number;
  readonly discountTotal: number;
  readonly shippingTotal: number;
  readonly taxTotal: number;
  readonly paidTotal: number;
  readonly refundedTotal: number;
  readonly items: readonly OrderLine[];
  readonly events: readonly OrderEvent[];
  readonly transactions: readonly OrderTransaction[];
  readonly actions: readonly string[];
  /**
   * The provider the order was placed with, from its latest payment intent —
   * 'cod', 'stripe', 'tabby', and so on.
   *
   * Not derivable from `transactions`: a COD order has no transaction row until
   * the courier's cash is recorded, which is precisely the moment before the
   * operator needs to know it is COD. This is the same signal
   * `recordCodCollection` enforces against, so the buttons the UI offers match
   * what the domain will accept.
   */
  readonly paymentProvider: string | null;
  /** The buyer's TRN when they gave one. Its presence makes this a B2B supply. */
  readonly recipientTrn: string | null;
}

export interface OrderLine {
  readonly id: string;
  readonly title: string;
  readonly variantTitle: string | null;
  readonly sku: string | null;
  readonly quantity: number;
  readonly quantityFulfilled: number;
  readonly unitPrice: number;
  readonly lineTotal: number;
}

export interface OrderEvent {
  readonly type: string;
  readonly message: string;
  readonly isPublic: boolean;
  readonly actorLabel: string | null;
  readonly createdAt: Date;
}

export interface OrderTransaction {
  readonly kind: string;
  readonly status: string;
  readonly amount: number;
  readonly gateway: string | null;
  readonly createdAt: Date;
}

/**
 * One order, with everything needed to act on it.
 *
 * Four queries in one transaction rather than one query with three joins: the
 * joins would multiply rows (3 items × 8 events × 2 transactions = 48 rows to
 * de-duplicate in application code) and the de-duplication is exactly where
 * subtle bugs live. Four small indexed reads inside a single transaction are
 * both faster and obviously correct.
 */
export async function getOrderDetail(
  tenantId: string,
  orderNumber: string,
): Promise<OrderDetail | null> {
  return withTenant(tenantId, async (tx) => {
    const orderRows = await tx.execute<{
      id: string;
      number: string;
      status: OrderStatus;
      payment_status: PaymentStatus;
      fulfilment_status: FulfilmentStatus;
      total: string;
      subtotal: string;
      discount_total: string;
      shipping_total: string;
      tax_total: string;
      paid_total: string;
      refunded_total: string;
      currency: string;
      placed_at: Date | string | null;
      channel: string;
      customer_id: string | null;
      email: string | null;
      phone: string | null;
      shipping_address: Record<string, unknown> | null;
      risk_score: number;
      recipient_trn: string | null;
      payment_provider: string | null;
    }>(sql`
      SELECT o.*, pi.provider AS payment_provider
      FROM orders o
      -- Latest intent only. A shopper whose card is declined and who retries as
      -- cash on delivery leaves two intents behind, and the one that matters is
      -- the one they actually checked out with.
      LEFT JOIN LATERAL (
        SELECT provider FROM payment_intents
        WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1
      ) pi ON true
      WHERE o.tenant_id = ${tenantId} AND o.number = ${orderNumber.replace(/^#/, '')}
      LIMIT 1
    `);

    const order = orderRows.rows[0];
    if (!order) return null;

    const [items, events, transactions] = await Promise.all([
      tx.execute<{
        id: string;
        title: string;
        variant_title: string | null;
        sku: string | null;
        quantity: string;
        quantity_fulfilled: string;
        unit_price: string;
        line_total: string;
      }>(sql`
        SELECT id, title, variant_title, sku, quantity, quantity_fulfilled, unit_price, line_total
        FROM order_items WHERE tenant_id = ${tenantId} AND order_id = ${order.id}
        ORDER BY created_at
      `),
      tx.execute<{
        type: string;
        message: string | null;
        is_public: boolean;
        actor_type: string;
        actor_name: string | null;
        created_at: Date | string;
      }>(sql`
        SELECT e.type, e.message, e.is_public, e.actor_type, u.name AS actor_name, e.created_at
        FROM order_events e
        -- Left join: most events are written by 'system' or by a guest, where
        -- actor_id is null and there is no user row to resolve. An inner join
        -- here would silently drop most of the timeline.
        LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.tenant_id = ${tenantId} AND e.order_id = ${order.id}
        ORDER BY e.created_at DESC
      `),
      tx.execute<{
        kind: string;
        status: string;
        amount: string;
        provider: string | null;
        created_at: Date | string;
      }>(sql`
        SELECT kind, status, amount, provider, created_at
        FROM transactions WHERE tenant_id = ${tenantId} AND order_id = ${order.id}
        ORDER BY created_at DESC
      `),
    ]);

    const state = {
      status: order.status,
      paymentStatus: order.payment_status,
      fulfilmentStatus: order.fulfilment_status,
    };

    return {
      id: order.id,
      number: order.number,
      status: order.status,
      paymentStatus: order.payment_status,
      fulfilmentStatus: order.fulfilment_status,
      total: Number(order.total),
      subtotal: Number(order.subtotal),
      discountTotal: Number(order.discount_total),
      shippingTotal: Number(order.shipping_total),
      taxTotal: Number(order.tax_total),
      paidTotal: Number(order.paid_total),
      refundedTotal: Number(order.refunded_total),
      currency: order.currency,
      placedAt: toDate(order.placed_at),
      channel: order.channel,
      customerName: (order.shipping_address?.recipientName as string) ?? null,
      emirate: (order.shipping_address?.emirate as string) ?? null,
      email: order.email,
      phone: order.phone,
      shippingAddress: order.shipping_address,
      itemCount: items.rows.reduce((sum, i) => sum + Number(i.quantity), 0),
      riskScore: Number(order.risk_score),
      isGuest: order.customer_id === null,
      items: items.rows.map((i) => ({
        id: i.id,
        title: i.title,
        variantTitle: i.variant_title,
        sku: i.sku,
        quantity: Number(i.quantity),
        quantityFulfilled: Number(i.quantity_fulfilled),
        unitPrice: Number(i.unit_price),
        lineTotal: Number(i.line_total),
      })),
      events: events.rows.map((e) => ({
        type: e.type,
        message: e.message ?? '',
        isPublic: e.is_public,
        actorLabel: e.actor_name ?? e.actor_type,
        createdAt: toDate(e.created_at) ?? new Date(0),
      })),
      transactions: transactions.rows.map((t) => ({
        kind: t.kind,
        status: t.status,
        amount: Number(t.amount),
        gateway: t.provider,
        createdAt: toDate(t.created_at) ?? new Date(0),
      })),
      paymentProvider: order.payment_provider,
      recipientTrn: order.recipient_trn,
      // Asked of the state machine rather than derived in the template, so the
      // buttons the UI offers are exactly the transitions the domain will
      // accept. A Refund button that throws when clicked is worse than one that
      // was never rendered.
      actions: availableActions(state),
    };
  });
}
