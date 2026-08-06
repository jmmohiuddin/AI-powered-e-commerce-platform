import { sql } from 'drizzle-orm';
import { uuidv7 } from '@voltix/db';
import {
  calculatePricing,
  money,
  notFound,
  outOfStock,
  UAE_STANDARD_VAT,
  type DiscountInput,
  type PricingLineInput,
  type PricingResult,
} from '@voltix/core';
import { availabilityFor } from './reservations';
import type { TenantContext, Tx } from './types';

/**
 * CART SERVICE
 *
 * The cart is a *draft*, and its stored totals are a cache. The pricing engine
 * recomputes from line items on every mutation and again before payment, so a
 * stale or tampered total can never become a charge.
 *
 * Stock is deliberately **not** reserved when an item is added. Reserving at
 * add-to-cart is the design that looks generous and quietly kills the store:
 * every abandoned tab freezes inventory, and abandonment is the common case.
 * Reservation happens at checkout, where the shopper has signalled intent and
 * a TTL is defensible.
 */

export interface CartLine {
  readonly id: string;
  readonly variantId: string;
  readonly productId: string;
  readonly productSlug: string;
  readonly title: string;
  readonly variantTitle: string;
  readonly sku: string;
  readonly imageUrl: string | null;
  readonly quantity: number;
  readonly unitPrice: number;
  readonly compareAtPrice: number | null;
  readonly lineTotal: number;
  readonly available: number;
  /** True when the cart holds more than the shelf does. */
  readonly exceedsStock: boolean;
}

export interface CartView {
  readonly id: string;
  readonly currency: string;
  readonly lines: CartLine[];
  readonly pricing: PricingResult;
  readonly itemCount: number;
  /** Blocking problems — the checkout button stays disabled while non-empty. */
  readonly issues: string[];
}

/** Finds the shopper's active cart, or creates one. */
export async function getOrCreateCart(
  tx: Tx,
  ctx: TenantContext,
  identity: { sessionToken: string; customerId?: string },
): Promise<string> {
  const existing = await tx.execute<{ id: string }>(sql`
    SELECT id FROM carts
    WHERE tenant_id = ${ctx.tenantId}
      AND status = 'active'
      AND (
        ${identity.customerId ? sql`customer_id = ${identity.customerId}` : sql`false`}
        OR session_token = ${identity.sessionToken}
      )
    ORDER BY updated_at DESC
    LIMIT 1
  `);

  if (existing.rows[0]) {
    // Claim an anonymous cart for a customer who has just signed in, so the
    // items they added before logging in are not silently lost.
    if (identity.customerId) {
      await tx.execute(sql`
        UPDATE carts SET customer_id = ${identity.customerId}, updated_at = now()
        WHERE id = ${existing.rows[0].id} AND customer_id IS NULL
      `);
    }
    return existing.rows[0].id;
  }

  const id = uuidv7();
  await tx.execute(sql`
    INSERT INTO carts (id, tenant_id, store_id, customer_id, session_token, status,
                       currency, created_at, updated_at)
    VALUES (${id}, ${ctx.tenantId}, ${ctx.storeId ?? null}, ${identity.customerId ?? null},
            ${identity.sessionToken}, 'active', ${ctx.currency}, now(), now())
  `);
  return id;
}

export async function addItem(
  tx: Tx,
  ctx: TenantContext,
  cartId: string,
  input: { variantId: string; quantity: number },
): Promise<void> {
  if (input.quantity <= 0) return;

  const variant = await tx.execute<{ id: string; price: number; is_active: boolean }>(sql`
    SELECT v.id, v.price, v.is_active
    FROM variants v
    JOIN products p ON p.id = v.product_id
    WHERE v.tenant_id = ${ctx.tenantId}
      AND v.id = ${input.variantId}
      AND v.deleted_at IS NULL
      AND p.status = 'active'
      AND p.deleted_at IS NULL
    LIMIT 1
  `);

  const row = variant.rows[0];
  if (!row || !row.is_active) throw notFound('Product', input.variantId);

  const available = (await availabilityFor(tx, ctx.tenantId, [input.variantId])).get(
    input.variantId,
  ) ?? 0;

  const existing = await tx.execute<{ id: string; quantity: number }>(sql`
    SELECT id, quantity FROM cart_items
    WHERE cart_id = ${cartId} AND variant_id = ${input.variantId}
  `);

  const desired = (existing.rows[0]?.quantity ?? 0) + input.quantity;
  if (desired > available) throw outOfStock(input.variantId, desired, available);

  if (existing.rows[0]) {
    await tx.execute(sql`
      UPDATE cart_items
      SET quantity = ${desired}, unit_price = ${row.price}, updated_at = now()
      WHERE id = ${existing.rows[0].id}
    `);
  } else {
    await tx.execute(sql`
      INSERT INTO cart_items (id, tenant_id, cart_id, variant_id, quantity, unit_price,
                              currency, created_at, updated_at)
      VALUES (${uuidv7()}, ${ctx.tenantId}, ${cartId}, ${input.variantId}, ${input.quantity},
              ${row.price}, ${ctx.currency}, now(), now())
    `);
  }

  await touch(tx, cartId);
}

export async function updateItemQuantity(
  tx: Tx,
  ctx: TenantContext,
  cartId: string,
  itemId: string,
  quantity: number,
): Promise<void> {
  if (quantity <= 0) {
    await removeItem(tx, cartId, itemId);
    return;
  }

  const item = await tx.execute<{ variant_id: string }>(sql`
    SELECT variant_id FROM cart_items WHERE id = ${itemId} AND cart_id = ${cartId}
  `);
  const variantId = item.rows[0]?.variant_id;
  if (!variantId) throw notFound('Cart item', itemId);

  const available = (await availabilityFor(tx, ctx.tenantId, [variantId])).get(variantId) ?? 0;
  if (quantity > available) throw outOfStock(variantId, quantity, available);

  await tx.execute(sql`
    UPDATE cart_items SET quantity = ${quantity}, updated_at = now() WHERE id = ${itemId}
  `);
  await touch(tx, cartId);
}

export async function removeItem(tx: Tx, cartId: string, itemId: string): Promise<void> {
  await tx.execute(sql`DELETE FROM cart_items WHERE id = ${itemId} AND cart_id = ${cartId}`);
  await touch(tx, cartId);
}

/**
 * Builds the full cart view, recomputing totals from scratch every time.
 *
 * Recompute-always rather than incremental-update is the whole design. An
 * incremental total has to remember to undo a coupon when the line that
 * qualified for it is removed, and eventually it forgets. A pure function of
 * the current line items cannot drift.
 */
export async function getCart(
  tx: Tx,
  ctx: TenantContext,
  cartId: string,
  options: { shippingCost?: number; couponCodes?: readonly string[] } = {},
): Promise<CartView> {
  const rows = await tx.execute<{
    id: string;
    variant_id: string;
    product_id: string;
    product_slug: string;
    title: string;
    variant_title: string;
    sku: string;
    image_url: string | null;
    quantity: number;
    unit_price: number;
    compare_at_price: number | null;
    category_id: string | null;
    brand_id: string | null;
    requires_shipping: boolean;
    cost_price: number | null;
  }>(sql`
    SELECT ci.id, ci.variant_id, ci.quantity, ci.unit_price,
           v.title AS variant_title, v.sku, v.compare_at_price, v.requires_shipping, v.cost_price,
           p.id AS product_id, p.slug AS product_slug, p.title,
           p.category_id, p.brand_id,
           (SELECT m.url FROM media m WHERE m.product_id = p.id ORDER BY m.position LIMIT 1) AS image_url
    FROM cart_items ci
    JOIN variants v ON v.id = ci.variant_id
    JOIN products p ON p.id = v.product_id
    WHERE ci.cart_id = ${cartId} AND ci.tenant_id = ${ctx.tenantId}
    ORDER BY ci.created_at
  `);

  const availability = await availabilityFor(
    tx,
    ctx.tenantId,
    rows.rows.map((r) => r.variant_id),
  );

  const issues: string[] = [];
  const lines: CartLine[] = rows.rows.map((row) => {
    const available = availability.get(row.variant_id) ?? 0;
    const exceedsStock = row.quantity > available;
    if (exceedsStock) {
      issues.push(
        available === 0
          ? `${row.title} is now out of stock`
          : `Only ${available} of ${row.title} remain — please reduce the quantity`,
      );
    }
    return {
      id: row.id,
      variantId: row.variant_id,
      productId: row.product_id,
      productSlug: row.product_slug,
      title: row.title,
      variantTitle: row.variant_title,
      sku: row.sku,
      imageUrl: row.image_url,
      quantity: row.quantity,
      unitPrice: Number(row.unit_price),
      compareAtPrice: row.compare_at_price == null ? null : Number(row.compare_at_price),
      lineTotal: Number(row.unit_price) * row.quantity,
      available,
      exceedsStock,
    };
  });

  const pricingLines: PricingLineInput[] = rows.rows.map((row) => ({
    id: row.id,
    variantId: row.variant_id,
    productId: row.product_id,
    categoryIds: row.category_id ? [row.category_id] : [],
    ...(row.brand_id ? { brandId: row.brand_id } : {}),
    quantity: row.quantity,
    unitPrice: money(Number(row.unit_price), ctx.currency),
    ...(row.cost_price != null ? { unitCost: money(Number(row.cost_price), ctx.currency) } : {}),
    requiresShipping: row.requires_shipping,
  }));

  const discounts = await loadDiscounts(tx, ctx, options.couponCodes ?? []);

  const pricing = calculatePricing(pricingLines, discounts, {
    currency: ctx.currency,
    now: new Date(),
    channel: 'web',
    customerSegments: [],
    isFirstOrder: true,
    shippingCost: money(options.shippingCost ?? 0, ctx.currency),
    // UAE: 5% VAT, extracted from the inclusive shelf price rather than added.
    taxRules: ctx.pricesIncludeVat ? [UAE_STANDARD_VAT] : [],
  });

  await tx.execute(sql`
    UPDATE carts
    SET subtotal = ${pricing.subtotal.amount},
        discount_total = ${pricing.discountTotal.amount},
        shipping_total = ${pricing.shippingTotal.amount},
        tax_total = ${pricing.taxTotal.amount},
        total = ${pricing.total.amount},
        updated_at = now()
    WHERE id = ${cartId}
  `);

  return {
    id: cartId,
    currency: ctx.currency,
    lines,
    pricing,
    itemCount: lines.reduce((n, l) => n + l.quantity, 0),
    issues,
  };
}

/** Active, in-window discounts: the coupons the shopper typed plus automatics. */
async function loadDiscounts(
  tx: Tx,
  ctx: TenantContext,
  codes: readonly string[],
): Promise<DiscountInput[]> {
  const rows = await tx.execute<{
    id: string;
    code: string | null;
    name: string;
    type: string;
    scope: string;
    value: number;
    max_discount_amount: number | null;
    conditions: Record<string, unknown>;
    is_stackable: boolean;
    priority: number;
    starts_at: Date | null;
    ends_at: Date | null;
    usage_limit: number | null;
    usage_count: number;
  }>(sql`
    SELECT id, code, name, type, scope, value, max_discount_amount, conditions,
           is_stackable, priority, starts_at, ends_at, usage_limit, usage_count
    FROM discounts
    WHERE tenant_id = ${ctx.tenantId}
      AND is_active = true
      AND (starts_at IS NULL OR starts_at <= now())
      AND (ends_at IS NULL OR ends_at >= now())
      AND (
        code IS NULL
        ${codes.length > 0
          ? sql`OR upper(code) = ANY(${sql`ARRAY[${sql.join(
              codes.map((c) => sql`${c.toUpperCase()}`),
              sql`, `,
            )}]`})`
          : sql``}
      )
  `);

  return rows.rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type as DiscountInput['type'],
    scope: row.scope as DiscountInput['scope'],
    value: Number(row.value),
    maxDiscountAmount: row.max_discount_amount == null ? null : Number(row.max_discount_amount),
    conditions: (row.conditions ?? {}) as DiscountInput['conditions'],
    isStackable: row.is_stackable,
    priority: row.priority,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    usageLimit: row.usage_limit,
    usageCount: row.usage_count,
  }));
}

/**
 * Bumps `updated_at`, which is what the abandoned-cart sweep measures against.
 * Without it a cart that is actively being edited looks abandoned.
 */
function touch(tx: Tx, cartId: string) {
  return tx.execute(sql`UPDATE carts SET updated_at = now() WHERE id = ${cartId}`);
}
