import 'server-only';
import { sql } from 'drizzle-orm';
import { withTenant } from '@voltix/db';

/**
 * CATALOGUE READ MODEL
 *
 * The queries behind the Products and Customers screens. Same shape as
 * `queries.ts`: hand-written SQL inside `withTenant()` so row-level security
 * does the isolation, and every money value stays an integer in minor units
 * until a formatter touches it.
 *
 * The aggregate columns here (stock on hand, lifetime spend) are computed per
 * request rather than denormalised. At this catalogue size that is the right
 * trade — a stale `total_spent` column that disagrees with the orders table is
 * worse than a join, and the join is cheap while a merchant has thousands of
 * products rather than millions. When it stops being cheap the fix is a
 * materialised view, not a column the application has to remember to update.
 */

/* ────────────────────────────── Products ────────────────────────────── */

export interface ProductRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly status: string;
  readonly condition: string;
  readonly brandName: string | null;
  readonly categoryName: string | null;
  readonly priceFrom: number | null;
  readonly compareAtFrom: number | null;
  readonly currency: string;
  readonly variantCount: number;
  /** Summed across every warehouse and variant. */
  readonly onHand: number;
  /** Units sold in the last 30 days — the column that says what to reorder. */
  readonly sold30d: number;
  /** Stars out of 5, already scaled. The column stores hundredths (468 = 4.68). */
  readonly ratingAverage: number | null;
  readonly ratingCount: number;
  readonly publishedAt: Date | null;
}

export interface ProductListResult {
  readonly rows: readonly ProductRow[];
  readonly total: number;
}

export interface ProductFilters {
  readonly search?: string | undefined;
  readonly status?: string | undefined;
  /** 'in' | 'low' | 'out' — stock bands, not raw numbers. */
  readonly stock?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export async function listProducts(
  tenantId: string,
  filters: ProductFilters = {},
): Promise<ProductListResult> {
  // Clamped: both arrive from a query string, and an unbounded LIMIT is a
  // one-request denial of service.
  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);

  return withTenant(tenantId, async (tx) => {
    const conditions = [sql`p.tenant_id = ${tenantId}`, sql`p.deleted_at IS NULL`];

    if (filters.status) conditions.push(sql`p.status = ${filters.status}::product_status`);

    if (filters.search) {
      // Title, slug and SKU. A merchant looking for a product has either the
      // name in their head or a SKU on a label in their hand.
      const like = `%${filters.search.trim()}%`;
      conditions.push(sql`(
        p.title ILIKE ${like}
        OR p.slug ILIKE ${like}
        OR EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.sku ILIKE ${like})
      )`);
    }

    // Stock bands are expressed against the same subquery the SELECT uses, so
    // the filter and the displayed number can never disagree.
    const onHandExpr = sql`(
      SELECT coalesce(sum(sl.on_hand), 0)
      FROM variants v LEFT JOIN stock_levels sl ON sl.variant_id = v.id
      WHERE v.product_id = p.id AND v.deleted_at IS NULL
    )`;
    if (filters.stock === 'out') conditions.push(sql`${onHandExpr} <= 0`);
    if (filters.stock === 'low') conditions.push(sql`${onHandExpr} > 0 AND ${onHandExpr} <= 5`);
    if (filters.stock === 'in') conditions.push(sql`${onHandExpr} > 5`);

    const where = sql.join(conditions, sql` AND `);

    const totals = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM products p WHERE ${where}
    `);

    const rows = await tx.execute<{
      id: string;
      slug: string;
      title: string;
      status: string;
      condition: string;
      brand_name: string | null;
      category_name: string | null;
      price_from: string | null;
      compare_at_price_from: string | null;
      currency: string;
      variant_count: number;
      on_hand: string;
      sold_30d: string;
      rating_average: string | null;
      rating_count: number;
      published_at: Date | string | null;
    }>(sql`
      SELECT p.id, p.slug, p.title, p.status::text, p.condition::text,
             b.name AS brand_name,
             c.name AS category_name,
             p.price_from, p.compare_at_price_from, p.currency,
             (SELECT count(*)::int FROM variants v
               WHERE v.product_id = p.id AND v.deleted_at IS NULL) AS variant_count,
             ${onHandExpr} AS on_hand,
             (SELECT coalesce(sum(oi.quantity), 0)
                FROM order_items oi JOIN orders o ON o.id = oi.order_id
               WHERE oi.product_id = p.id
                 AND o.status <> 'cancelled'
                 AND o.placed_at >= now() - interval '30 days') AS sold_30d,
             p.rating_average, p.rating_count,
             p.published_at
      FROM products p
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE ${where}
      ORDER BY p.updated_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    return {
      total: Number(totals.rows[0]?.n ?? 0),
      rows: rows.rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        title: r.title,
        status: r.status,
        condition: r.condition,
        brandName: r.brand_name,
        categoryName: r.category_name,
        priceFrom: r.price_from === null ? null : Number(r.price_from),
        compareAtFrom: r.compare_at_price_from === null ? null : Number(r.compare_at_price_from),
        currency: r.currency,
        variantCount: Number(r.variant_count),
        onHand: Number(r.on_hand),
        sold30d: Number(r.sold_30d),
        // The column is hundredths of a star, not stars — reading it raw
        // renders a 4.7-star product as "468.0", which is what it did.
        ratingAverage: r.rating_average === null ? null : Number(r.rating_average) / 100,
        ratingCount: Number(r.rating_count),
        publishedAt: toDate(r.published_at),
      })),
    };
  });
}

export interface ProductVariantRow {
  readonly id: string;
  readonly sku: string;
  readonly title: string;
  readonly price: number;
  readonly costPrice: number | null;
  readonly currency: string;
  readonly onHand: number;
  readonly reserved: number;
  readonly incoming: number;
  readonly isActive: boolean;
  /** Null when cost is unknown — never a fabricated 100%. */
  readonly marginBps: number | null;
}

export interface ProductDetail extends ProductRow {
  readonly subtitle: string | null;
  readonly description: string | null;
  readonly warrantyMonths: number | null;
  readonly variants: readonly ProductVariantRow[];
}

export async function getProductDetail(
  tenantId: string,
  slug: string,
): Promise<ProductDetail | null> {
  const list = await listProducts(tenantId, { search: slug, limit: 200 });
  const summary = list.rows.find((p) => p.slug === slug);
  if (!summary) return null;

  return withTenant(tenantId, async (tx) => {
    const extra = await tx.execute<{
      subtitle: string | null;
      description: string | null;
      warranty_months: number | null;
    }>(sql`
      SELECT subtitle, description, warranty_months FROM products
      WHERE tenant_id = ${tenantId} AND id = ${summary.id} LIMIT 1
    `);

    const variants = await tx.execute<{
      id: string;
      sku: string;
      title: string;
      price: string;
      cost_price: string | null;
      currency: string;
      is_active: boolean;
      on_hand: string;
      reserved: string;
      incoming: string;
    }>(sql`
      SELECT v.id, v.sku, v.title, v.price, v.cost_price, v.currency, v.is_active,
             coalesce(sum(sl.on_hand), 0)  AS on_hand,
             coalesce(sum(sl.reserved), 0) AS reserved,
             coalesce(sum(sl.incoming), 0) AS incoming
      FROM variants v
      LEFT JOIN stock_levels sl ON sl.variant_id = v.id
      WHERE v.tenant_id = ${tenantId} AND v.product_id = ${summary.id} AND v.deleted_at IS NULL
      GROUP BY v.id, v.sku, v.title, v.price, v.cost_price, v.currency, v.is_active, v.position
      ORDER BY v.position, v.sku
    `);

    const row = extra.rows[0];
    return {
      ...summary,
      subtitle: row?.subtitle ?? null,
      description: row?.description ?? null,
      warrantyMonths: row?.warranty_months ?? null,
      variants: variants.rows.map((v) => {
        const price = Number(v.price);
        const hasCost = v.cost_price !== null;
        const cost = hasCost ? Number(v.cost_price) : 0;
        return {
          id: v.id,
          sku: v.sku,
          title: v.title,
          price,
          costPrice: hasCost ? cost : null,
          currency: v.currency,
          onHand: Number(v.on_hand),
          reserved: Number(v.reserved),
          incoming: Number(v.incoming),
          isActive: v.is_active,
          // Margin against the selling price, not against cost. A 20% markup
          // and a 20% margin are different numbers, and conflating them is how
          // a category looks profitable when it is not.
          marginBps: hasCost && price > 0 ? Math.round(((price - cost) / price) * 10_000) : null,
        };
      }),
    };
  });
}

/* ───────────────────────────── Customers ────────────────────────────── */

export interface CustomerRow {
  readonly id: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly orderCount: number;
  readonly lifetimeSpend: number;
  readonly currency: string;
  readonly lastOrderAt: Date | null;
  readonly loyaltyTier: string | null;
  readonly riskScore: number;
  readonly acceptsEmail: boolean;
  readonly acceptsWhatsapp: boolean;
  readonly createdAt: Date | null;
}

export interface CustomerListResult {
  readonly rows: readonly CustomerRow[];
  readonly total: number;
}

export interface CustomerFilters {
  readonly search?: string | undefined;
  /** 'repeat' | 'new' | 'at_risk' */
  readonly segment?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export async function listCustomers(
  tenantId: string,
  filters: CustomerFilters = {},
): Promise<CustomerListResult> {
  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);

  return withTenant(tenantId, async (tx) => {
    const conditions = [sql`cu.tenant_id = ${tenantId}`, sql`cu.deleted_at IS NULL`];

    if (filters.search) {
      const like = `%${filters.search.trim()}%`;
      conditions.push(sql`(
        cu.email ILIKE ${like} OR cu.phone ILIKE ${like}
        OR (coalesce(cu.first_name,'') || ' ' || coalesce(cu.last_name,'')) ILIKE ${like}
      )`);
    }

    // Spend and order count are derived from real orders rather than the
    // `stats` jsonb column — that column is a cache, and a customer screen
    // that disagrees with the orders list is a screen nobody trusts again.
    const orderCountExpr = sql`(
      SELECT count(*)::int FROM orders o
      WHERE o.customer_id = cu.id AND o.status <> 'cancelled'
    )`;
    if (filters.segment === 'repeat') conditions.push(sql`${orderCountExpr} > 1`);
    if (filters.segment === 'new') conditions.push(sql`${orderCountExpr} <= 1`);
    if (filters.segment === 'at_risk') {
      // Bought before, but not in 90 days. The group worth a win-back message.
      conditions.push(sql`${orderCountExpr} > 0 AND (cu.last_order_at IS NULL
        OR cu.last_order_at < now() - interval '90 days')`);
    }

    const where = sql.join(conditions, sql` AND `);

    const totals = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM customers cu WHERE ${where}
    `);

    const rows = await tx.execute<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      phone: string | null;
      order_count: number;
      lifetime_spend: string;
      last_order_at: Date | string | null;
      loyalty_tier: string | null;
      risk_score: number;
      accepts_marketing_email: boolean;
      accepts_marketing_whatsapp: boolean;
      created_at: Date | string | null;
    }>(sql`
      SELECT cu.id, cu.first_name, cu.last_name, cu.email, cu.phone,
             ${orderCountExpr} AS order_count,
             (SELECT coalesce(sum(o.total), 0) FROM orders o
               WHERE o.customer_id = cu.id AND o.status <> 'cancelled') AS lifetime_spend,
             cu.last_order_at, cu.loyalty_tier, cu.risk_score,
             cu.accepts_marketing_email, cu.accepts_marketing_whatsapp, cu.created_at
      FROM customers cu
      WHERE ${where}
      ORDER BY cu.last_order_at DESC NULLS LAST, cu.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    return {
      total: Number(totals.rows[0]?.n ?? 0),
      rows: rows.rows.map((r) => ({
        id: r.id,
        name: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
        email: r.email,
        phone: r.phone,
        orderCount: Number(r.order_count),
        lifetimeSpend: Number(r.lifetime_spend),
        currency: 'AED',
        lastOrderAt: toDate(r.last_order_at),
        loyaltyTier: r.loyalty_tier,
        riskScore: Number(r.risk_score),
        acceptsEmail: r.accepts_marketing_email,
        acceptsWhatsapp: r.accepts_marketing_whatsapp,
        createdAt: toDate(r.created_at),
      })),
    };
  });
}
