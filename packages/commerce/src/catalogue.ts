import { sql } from 'drizzle-orm';
import { uuidv7 } from '@voltix/db';
import { DomainError } from '@voltix/core';
import type { ActorContext, TenantContext, Tx } from './types';

/**
 * CATALOGUE WRITES
 *
 * Creating and editing products. Until this existed the catalogue could only be
 * populated by `npm run db:seed` or by hand in SQL, which meant the admin was
 * read-only and a merchant could not run their own shop.
 *
 * Three rules shape the module:
 *
 * 1. **A product is created as a draft, always.** Publishing is a separate,
 *    explicit act with its own preconditions. Creating straight to `active`
 *    would put a half-filled product on the storefront the moment someone
 *    saved a title, and the fastest way to lose a sale is a live product with
 *    no price.
 *
 * 2. **A product without a sellable variant cannot be published.** Price and
 *    stock live on the variant, so a product with none is an empty page. The
 *    check is here rather than in the form because the same rule has to hold
 *    for an API or an import that never touches the form.
 *
 * 3. **Slugs are immutable once published.** A slug is a URL; changing it
 *    breaks every existing link, every share and every search result. Before
 *    publication nobody has the link yet, so it is still free to change.
 */

/** URL-safe slug. Arabic and other non-Latin titles fall back to a stable id. */
export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    // Strip diacritics so "Café" and "Cafe" produce the same slug.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug;
}

/**
 * A product's copy in one non-default locale.
 *
 * Mirrors `LocaleOverrides` in the storefront's lib/types.ts, which is what
 * reads these back. The two are deliberately separate declarations rather than
 * a shared type: this package must not import from an app.
 *
 * UAE Federal Law 15/2020 requires consumer product information in Arabic, so
 * `ar-AE` is not an optional nicety here — it is the reason this exists.
 */
export interface ProductTranslation {
  readonly title?: string | undefined;
  readonly subtitle?: string | undefined;
  readonly description?: string | undefined;
  readonly highlights?: readonly string[] | undefined;
}

export interface ProductInput {
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly description?: string | undefined;
  readonly highlights?: readonly string[] | undefined;
  /** Keyed by locale tag: `{ "ar-AE": { title, subtitle, … } }`. */
  readonly translations?: Readonly<Record<string, ProductTranslation>> | undefined;
  readonly brandId?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly condition?: string | undefined;
  readonly warrantyMonths?: number | undefined;
}

export interface VariantInput {
  readonly sku: string;
  readonly title: string;
  /** Minor units. VAT-inclusive, like every other price in the system. */
  readonly price: number;
  readonly costPrice?: number | undefined;
  readonly onHand?: number | undefined;
}

function requireText(value: string | undefined, field: string, max = 200): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) {
    throw new DomainError('VALIDATION_FAILED', `${field} is required`, {
      publicMessage: `${field} is required.`,
    });
  }
  if (trimmed.length > max) {
    throw new DomainError('VALIDATION_FAILED', `${field} too long`, {
      publicMessage: `${field} must be ${max} characters or fewer.`,
    });
  }
  return trimmed;
}

/** Bullet lines, trimmed, with the blanks dropped. A textarea returns one
 *  string per line and merchants leave trailing newlines. */
function normaliseHighlights(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}

/**
 * Strips empty fields out of a translation set before it reaches the database.
 *
 * This is load-bearing, not tidying. The storefront resolves a translated field
 * with `overrides.title ?? product.title` — `??` falls back on null/undefined
 * only, so an empty string is a *value*, and one stored here would blank the
 * English title for Arabic readers instead of falling back to it. A merchant
 * who opens the Arabic fields, types nothing and saves must leave no trace.
 *
 * A locale left with no fields at all is dropped, so the column holds `{}`
 * rather than `{"ar-AE": {}}`. Both mean "nothing translated", but only one of
 * them reads that way to the next person looking at the row.
 */
function normaliseTranslations(
  input: Readonly<Record<string, ProductTranslation>> | undefined,
): Record<string, ProductTranslation> {
  const output: Record<string, ProductTranslation> = {};

  for (const [locale, fields] of Object.entries(input ?? {})) {
    const title = fields.title?.trim();
    const subtitle = fields.subtitle?.trim();
    const description = fields.description?.trim();
    const highlights = normaliseHighlights(fields.highlights);

    const translation: ProductTranslation = {
      ...(title ? { title } : {}),
      ...(subtitle ? { subtitle } : {}),
      ...(description ? { description } : {}),
      ...(highlights.length > 0 ? { highlights } : {}),
    };

    if (Object.keys(translation).length > 0) output[locale] = translation;
  }

  return output;
}

function requireMinorUnits(value: number | undefined, field: string): number {
  if (value == null || !Number.isInteger(value) || value < 0) {
    throw new DomainError('VALIDATION_FAILED', `${field} must be a whole number of fils`, {
      publicMessage: `${field} must be a valid amount.`,
    });
  }
  // A price above AED 1,000,000 is a decimal-point mistake far more often than
  // a real product, and catching it here is cheaper than a refund later.
  if (value > 100_000_000) {
    throw new DomainError('VALIDATION_FAILED', `${field} implausibly large`, {
      publicMessage: `${field} looks wrong — check the decimal point.`,
    });
  }
  return value;
}

/**
 * Allocates a slug that is unique within the tenant.
 *
 * Appends `-2`, `-3`, … rather than a random suffix: two products genuinely
 * called "USB-C Cable" should read `usb-c-cable` and `usb-c-cable-2`, not
 * `usb-c-cable-x7f2`. Bounded so a pathological case fails loudly instead of
 * looping.
 */
async function allocateSlug(tx: Tx, tenantId: string, base: string): Promise<string> {
  const root = base || `product-${Date.now()}`;
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const candidate = attempt === 1 ? root : `${root}-${attempt}`;
    const clash = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM products
      WHERE tenant_id = ${tenantId} AND slug = ${candidate}
    `);
    if (Number(clash.rows[0]?.n ?? 0) === 0) return candidate;
  }
  throw new DomainError('CONFLICT', 'Could not allocate a unique slug', {
    publicMessage: 'Too many products share this name. Give it a more specific title.',
  });
}

export interface CreateProductResult {
  readonly id: string;
  readonly slug: string;
}

/**
 * Creates a draft product with one initial variant.
 *
 * One variant is required rather than optional: a product with none cannot be
 * priced or stocked, and allowing the empty case just moves the problem to
 * every screen that has to render it.
 */
export async function createProduct(
  tx: Tx,
  ctx: TenantContext,
  actor: ActorContext,
  product: ProductInput,
  variant: VariantInput,
): Promise<CreateProductResult> {
  const title = requireText(product.title, 'Title');
  const sku = requireText(variant.sku, 'SKU', 64);
  const variantTitle = requireText(variant.title || 'Default', 'Variant name', 200);
  const price = requireMinorUnits(variant.price, 'Price');
  const cost = variant.costPrice == null ? null : requireMinorUnits(variant.costPrice, 'Cost');

  if (cost != null && cost > price) {
    // Not blocked — clearance below cost is a real thing — but it is almost
    // always a data-entry error, so it is worth refusing until someone edits
    // it deliberately after creation.
    throw new DomainError('VALIDATION_FAILED', 'Cost exceeds price', {
      publicMessage: 'Cost is higher than the selling price. Check both figures.',
    });
  }

  const duplicate = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM variants
    WHERE tenant_id = ${ctx.tenantId} AND sku = ${sku} AND deleted_at IS NULL
  `);
  if (Number(duplicate.rows[0]?.n ?? 0) > 0) {
    throw new DomainError('CONFLICT', `SKU ${sku} already exists`, {
      publicMessage: `SKU "${sku}" is already used by another product.`,
    });
  }

  const productId = uuidv7();
  const variantId = uuidv7();
  const slug = await allocateSlug(tx, ctx.tenantId, slugify(title));

  await tx.execute(sql`
    INSERT INTO products
      (id, tenant_id, store_id, slug, title, subtitle, description, highlights, translations,
       brand_id, category_id,
       status, condition, currency, price_from, warranty_months, rating_count,
       created_at, updated_at)
    VALUES (${productId}, ${ctx.tenantId}, ${ctx.storeId ?? null}, ${slug}, ${title},
            ${product.subtitle?.trim() || null}, ${product.description?.trim() || null},
            ${JSON.stringify(normaliseHighlights(product.highlights))}::jsonb,
            ${JSON.stringify(normaliseTranslations(product.translations))}::jsonb,
            ${product.brandId ?? null}, ${product.categoryId ?? null},
            'draft', ${(product.condition ?? 'new')}::product_condition, ${ctx.currency},
            ${price}, ${product.warrantyMonths ?? null}, 0, now(), now())
  `);

  await tx.execute(sql`
    INSERT INTO variants
      (id, tenant_id, product_id, sku, title, options, price, cost_price, currency,
       is_active, requires_shipping, position, created_at, updated_at)
    VALUES (${variantId}, ${ctx.tenantId}, ${productId}, ${sku}, ${variantTitle}, '{}'::jsonb,
            ${price}, ${cost}, ${ctx.currency}, true, true, 0, now(), now())
  `);

  // Stock rows are created per warehouse so the variant is immediately
  // countable. Without them the product looks out of stock rather than
  // unstocked, and those are different problems for a merchant to diagnose.
  const warehouses = await tx.execute<{ id: string }>(sql`
    SELECT id FROM warehouses WHERE tenant_id = ${ctx.tenantId} AND is_active = true
    ORDER BY priority DESC
  `);
  const opening = variant.onHand ?? 0;
  let first = true;
  for (const warehouse of warehouses.rows) {
    await tx.execute(sql`
      INSERT INTO stock_levels
        (id, tenant_id, variant_id, warehouse_id, on_hand, reserved, incoming,
         reorder_point, reorder_quantity, allow_backorder, version, created_at, updated_at)
      VALUES (${uuidv7()}, ${ctx.tenantId}, ${variantId}, ${warehouse.id},
              ${first ? opening : 0}, 0, 0, 5, 20, false, 0, now(), now())
    `);
    first = false;
  }

  // Opening stock is a movement like any other. Recording it means the ledger
  // explains the whole life of the count, starting from the first unit.
  if (opening > 0 && warehouses.rows[0]) {
    await tx.execute(sql`
      INSERT INTO stock_movements
        (id, tenant_id, variant_id, warehouse_id, delta, balance_after, reason,
         unit_cost, reference_type, reference_id, actor_user_id, created_at)
      VALUES (${uuidv7()}, ${ctx.tenantId}, ${variantId}, ${warehouses.rows[0].id},
              ${opening}, ${opening}, 'manual_adjustment', ${cost}, 'product_create',
              ${productId}, ${actor.type === 'staff' ? (actor.id ?? null) : null}, now())
    `);
  }

  return { id: productId, slug };
}

/**
 * Edits an existing product's descriptive fields.
 *
 * Deliberately does not touch price, stock or SKU. Those live on the variant
 * and each has its own ledger consequence — changing a price is a pricing
 * event, changing stock is a movement. Bundling them into a generic "update"
 * is how those ledgers end up with gaps.
 */
export async function updateProduct(
  tx: Tx,
  ctx: TenantContext,
  _actor: ActorContext,
  productId: string,
  patch: ProductInput,
): Promise<void> {
  const title = requireText(patch.title, 'Title');

  const rows = await tx.execute<{ id: string; status: string }>(sql`
    SELECT id, status::text FROM products
    WHERE tenant_id = ${ctx.tenantId} AND id = ${productId} AND deleted_at IS NULL
    FOR UPDATE
  `);
  if (!rows.rows[0]) throw new DomainError('NOT_FOUND', `Product ${productId} not found`);

  await tx.execute(sql`
    UPDATE products SET
      title = ${title},
      subtitle = ${patch.subtitle?.trim() || null},
      description = ${patch.description?.trim() || null},
      -- Replaced wholesale, like subtitle and description above: the edit form
      -- submits the full set every time, so an omitted line is a deletion the
      -- merchant just made rather than a field the caller forgot.
      highlights = ${JSON.stringify(normaliseHighlights(patch.highlights))}::jsonb,
      translations = ${JSON.stringify(normaliseTranslations(patch.translations))}::jsonb,
      brand_id = ${patch.brandId ?? null},
      category_id = ${patch.categoryId ?? null},
      condition = ${(patch.condition ?? 'new')}::product_condition,
      warranty_months = ${patch.warrantyMonths ?? null},
      updated_at = now()
    WHERE tenant_id = ${ctx.tenantId} AND id = ${productId}
  `);
}

/**
 * Publishes or unpublishes a product.
 *
 * Publishing has preconditions; unpublishing has none, because removing
 * something from sale must never be blocked — if a product is wrong or unsafe,
 * a merchant needs it gone in one click and an argument about validation is
 * the last thing they want.
 */
export async function setProductStatus(
  tx: Tx,
  ctx: TenantContext,
  _actor: ActorContext,
  productId: string,
  status: 'draft' | 'active' | 'archived',
): Promise<void> {
  const rows = await tx.execute<{ id: string; title: string }>(sql`
    SELECT id, title FROM products
    WHERE tenant_id = ${ctx.tenantId} AND id = ${productId} AND deleted_at IS NULL
    FOR UPDATE
  `);
  const product = rows.rows[0];
  if (!product) throw new DomainError('NOT_FOUND', `Product ${productId} not found`);

  if (status === 'active') {
    const sellable = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM variants
      WHERE tenant_id = ${ctx.tenantId} AND product_id = ${productId}
        AND deleted_at IS NULL AND is_active = true AND price > 0
    `);
    if (Number(sellable.rows[0]?.n ?? 0) === 0) {
      throw new DomainError('VALIDATION_FAILED', 'No sellable variant', {
        publicMessage:
          'This product needs at least one active variant with a price above zero before it can go live.',
      });
    }
  }

  await tx.execute(sql`
    UPDATE products SET
      status = ${status}::product_status,
      published_at = ${status === 'active' ? sql`coalesce(published_at, now())` : sql`published_at`},
      updated_at = now()
    WHERE tenant_id = ${ctx.tenantId} AND id = ${productId}
  `);
}

/**
 * Adjusts stock and records why.
 *
 * The `reason` is required and constrained to the movement enum, because
 * "the count changed and nobody knows why" is the exact condition that makes a
 * stocktake dispute unresolvable. This is the only sanctioned way for a human
 * to change `on_hand`.
 */
export async function adjustStock(
  tx: Tx,
  ctx: TenantContext,
  actor: ActorContext,
  input: {
    variantId: string;
    warehouseId?: string | undefined;
    /** Signed. Negative removes units. */
    delta: number;
    reason: 'stocktake' | 'damage' | 'theft' | 'manual_adjustment' | 'purchase_received';
    note?: string | undefined;
  },
): Promise<{ balanceAfter: number }> {
  if (!Number.isInteger(input.delta) || input.delta === 0) {
    throw new DomainError('VALIDATION_FAILED', 'Adjustment must be a non-zero whole number', {
      publicMessage: 'Enter a whole number of units to add or remove.',
    });
  }

  const levels = await tx.execute<{ id: string; warehouse_id: string; on_hand: number }>(sql`
    SELECT id, warehouse_id, on_hand FROM stock_levels
    WHERE tenant_id = ${ctx.tenantId} AND variant_id = ${input.variantId}
      ${input.warehouseId ? sql`AND warehouse_id = ${input.warehouseId}` : sql``}
    ORDER BY on_hand DESC
    LIMIT 1
    FOR UPDATE
  `);
  const level = levels.rows[0];
  if (!level) {
    throw new DomainError('NOT_FOUND', 'No stock record for this variant', {
      publicMessage: 'This variant is not stocked at any warehouse yet.',
    });
  }

  const balanceAfter = Number(level.on_hand) + input.delta;
  if (balanceAfter < 0) {
    // Negative stock is never a fact about the world. It is always an error,
    // and letting it through corrupts every downstream count and forecast.
    throw new DomainError('VALIDATION_FAILED', 'Adjustment would make stock negative', {
      publicMessage: `Only ${level.on_hand} in stock — you cannot remove ${Math.abs(input.delta)}.`,
    });
  }

  await tx.execute(sql`
    UPDATE stock_levels
    SET on_hand = ${balanceAfter}, version = version + 1, updated_at = now()
    WHERE id = ${level.id}
  `);

  await tx.execute(sql`
    INSERT INTO stock_movements
      (id, tenant_id, variant_id, warehouse_id, delta, balance_after, reason,
       reference_type, note, actor_user_id, created_at)
    VALUES (${uuidv7()}, ${ctx.tenantId}, ${input.variantId}, ${level.warehouse_id},
            ${input.delta}, ${balanceAfter}, ${input.reason}::stock_movement_reason,
            'manual', ${input.note?.trim() || null},
            ${actor.type === 'staff' ? (actor.id ?? null) : null}, now())
  `);

  return { balanceAfter };
}
