import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from 'drizzle-orm/pg-core';
import { currency, money, softDeleteTimestamps, tenantId, timestamps } from './_shared';
import { stores } from './tenancy';

export const productStatus = pgEnum('product_status', ['draft', 'active', 'archived']);
export const productCondition = pgEnum('product_condition', [
  'new',
  'refurbished',
  'open_box',
  'used',
]);
export const mediaKind = pgEnum('media_kind', ['image', 'video', 'model_3d', 'document']);

/* ───────────────────────────── Taxonomy ─────────────────────────────── */

export const brands = pgTable(
  'brands',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    slug: varchar('slug', { length: 128 }).notNull(),
    name: text('name').notNull(),
    logoUrl: text('logo_url'),
    description: text('description'),
    /** Manufacturer warranty default in months, inherited by products. */
    defaultWarrantyMonths: smallint('default_warranty_months'),
    ...softDeleteTimestamps(),
  },
  (t) => [uniqueIndex('brands_tenant_slug_key').on(t.tenantId, t.slug)],
);

/**
 * Categories use an adjacency list (`parentId`) plus a materialised `path`.
 *
 * Why both: adjacency alone needs a recursive CTE for every breadcrumb and
 * every "all descendants" filter, which is the hottest query on a category
 * listing page. A closure table is the textbook answer but costs a join table
 * with O(depth × nodes) rows and a lot of write bookkeeping. Electronics
 * taxonomies are shallow (rarely past 4 levels) and change rarely, so a
 * denormalised `path` of ancestor slugs — indexed, rewritten on the rare move —
 * gives single-index-scan descendant queries for a fraction of the complexity.
 */
export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    parentId: uuid('parent_id'),
    slug: varchar('slug', { length: 128 }).notNull(),
    name: text('name').notNull(),
    description: text('description'),
    imageUrl: text('image_url'),
    /** '/mobiles/smartphones/android' — ltree-shaped, prefix-indexed. */
    path: text('path').notNull(),
    depth: smallint('depth').notNull().default(0),
    position: integer('position').notNull().default(0),
    isVisible: boolean('is_visible').notNull().default(true),

    /** SEO/AEO surface. See docs/06-ai-platform.md for how these are generated. */
    metaTitle: text('meta_title'),
    metaDescription: text('meta_description'),

    /** { "ar-AE": { name, description, metaTitle, metaDescription } } */
    translations: jsonb('translations').notNull().default({}),

    ...softDeleteTimestamps(),
  },
  (t) => [
    uniqueIndex('categories_tenant_slug_key').on(t.tenantId, t.slug),
    index('categories_tenant_path_idx').on(t.tenantId, t.path),
    index('categories_parent_idx').on(t.parentId),
  ],
);

/**
 * Attribute definitions — the spec sheet backbone.
 *
 * Electronics live or die on filterable specs (RAM, storage, refresh rate,
 * battery mAh, charging watts). Storing them as free-text JSON on the product
 * makes "8 GB RAM" and "8GB RAM" different facets and destroys filtering, so
 * attributes are first-class rows with a declared datatype and unit. The
 * product↔value join lives in `productAttributeValues`.
 */
export const attributeType = pgEnum('attribute_type', [
  'text',
  'number',
  'boolean',
  'enum',
  'measurement',
]);

export const attributes = pgTable(
  'attributes',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    key: varchar('key', { length: 64 }).notNull(),
    name: text('name').notNull(),
    type: attributeType('type').notNull().default('text'),
    unit: varchar('unit', { length: 16 }),
    /** Allowed values for `enum` attributes, ordered for facet display. */
    options: jsonb('options').notNull().default([]),
    isFilterable: boolean('is_filterable').notNull().default(true),
    isComparable: boolean('is_comparable').notNull().default(true),
    /** Shown in the collapsed spec summary on the product page. */
    isKeySpec: boolean('is_key_spec').notNull().default(false),
    position: integer('position').notNull().default(0),
    ...timestamps(),
  },
  (t) => [uniqueIndex('attributes_tenant_key_key').on(t.tenantId, t.key)],
);

/* ────────────────────────────── Products ────────────────────────────── */

/**
 * A product is the *marketing* entity (one page, one title, one review stream).
 * Everything sellable is a `variant`. A phone sold in 3 colours × 2 storage
 * tiers is one product and six variants, each with its own SKU, price and
 * stock. Modelling the variant as the unit of sale from day one avoids the
 * migration every store eventually faces when "one SKU per product" collapses.
 */
export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'cascade' }),

    slug: varchar('slug', { length: 200 }).notNull(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    description: text('description'),
    /** Bullet highlights rendered above the fold. */
    highlights: jsonb('highlights').notNull().default([]),

    brandId: uuid('brand_id').references(() => brands.id, { onDelete: 'set null' }),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),

    status: productStatus('status').notNull().default('draft'),
    condition: productCondition('condition').notNull().default('new'),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),

    warrantyMonths: smallint('warranty_months'),
    warrantyTerms: text('warranty_terms'),

    /** Denormalised review rollup. Recomputed on review write, not on read. */
    ratingAverage: smallint('rating_average'), // 0–500, i.e. 4.37★ stored as 437
    ratingCount: integer('rating_count').notNull().default(0),

    /** Denormalised from the cheapest active variant, for list pages & sorting. */
    priceFrom: money('price_from'),
    compareAtPriceFrom: money('compare_at_price_from'),
    currency: currency().notNull().default('AED'),

    metaTitle: text('meta_title'),
    metaDescription: text('meta_description'),
    /** Machine-readable answers for AI shopping agents. See ADR-0007. */
    aeoFacts: jsonb('aeo_facts'),

    tags: jsonb('tags').notNull().default([]),

    /**
     * Locale overrides: { "ar-AE": { title, subtitle, description, highlights } }.
     *
     * A sidecar JSONB column rather than a `product_translations` table. The
     * store serves two locales, a product is edited as one object, and every
     * read wants the translation alongside the base row — a join table would
     * add a join to the hottest query in the catalogue to model a cardinality
     * that is realistically two. If this grows past a handful of locales, or
     * translations need independent workflow state, promote it to a table.
     *
     * Missing translations fall back to the base fields rather than rendering
     * empty: a half-translated catalogue should read as partly English, not as
     * a broken page.
     */
    translations: jsonb('translations').notNull().default({}),

    /**
     * Generated tsvector over title/subtitle/brand/tags. Generated rather than
     * trigger-maintained so it can never drift from the source columns.
     */
    searchVector: text('search_vector'),

    ...softDeleteTimestamps(),
  },
  (t) => [
    uniqueIndex('products_tenant_slug_key').on(t.tenantId, t.slug),
    index('products_tenant_status_idx').on(t.tenantId, t.status),
    index('products_category_idx').on(t.tenantId, t.categoryId),
    index('products_brand_idx').on(t.tenantId, t.brandId),
    index('products_price_idx').on(t.tenantId, t.priceFrom),
    index('products_rating_idx').on(t.tenantId, t.ratingAverage),
    // Typo-tolerant matching on model names: "redmi note 13" ~ "Redmi Note 13".
    index('products_title_trgm_idx').using('gin', sql`${t.title} gin_trgm_ops`),
  ],
);

export const variants = pgTable(
  'variants',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),

    sku: varchar('sku', { length: 64 }).notNull(),
    barcode: varchar('barcode', { length: 64 }),
    /** Manufacturer part number — how suppliers and price feeds identify it. */
    mpn: varchar('mpn', { length: 64 }),
    title: text('title').notNull(),

    /** {"Colour":"Midnight","Storage":"256GB"} — the axes that define it. */
    options: jsonb('options').notNull().default({}),

    price: money('price').notNull(),
    /** Struck-through reference price. Must be > price or it is not shown. */
    compareAtPrice: money('compare_at_price'),
    /** Landed cost. Powers margin reporting; never exposed to the storefront. */
    costPrice: money('cost_price'),
    currency: currency().notNull().default('AED'),

    weightGrams: integer('weight_grams'),
    dimensionsMm: jsonb('dimensions_mm'),

    /**
     * Phones and laptops are serialised goods: warranty claims, IMEI
     * registration and theft recovery all need per-unit identity. Accessories
     * are not. This flag switches the inventory engine between quantity mode
     * and per-unit mode (see inventory.ts / serialUnits).
     */
    isSerialised: boolean('is_serialised').notNull().default(false),
    requiresShipping: boolean('requires_shipping').notNull().default(true),

    position: integer('position').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),

    ...softDeleteTimestamps(),
  },
  (t) => [
    uniqueIndex('variants_tenant_sku_key').on(t.tenantId, t.sku),
    index('variants_product_idx').on(t.productId),
    index('variants_barcode_idx').on(t.tenantId, t.barcode),
  ],
);

export const productAttributeValues = pgTable(
  'product_attribute_values',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    attributeId: uuid('attribute_id')
      .notNull()
      .references(() => attributes.id, { onDelete: 'cascade' }),
    /** One of these is populated according to the attribute's declared type. */
    valueText: text('value_text'),
    valueNumber: integer('value_number'),
    valueBoolean: boolean('value_boolean'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('pav_product_attribute_key').on(t.productId, t.attributeId),
    // Facet queries filter by (attribute, value) then intersect on product.
    index('pav_tenant_attr_text_idx').on(t.tenantId, t.attributeId, t.valueText),
    index('pav_tenant_attr_num_idx').on(t.tenantId, t.attributeId, t.valueNumber),
  ],
);

/* ─────────────────────────────── Media ──────────────────────────────── */

export const media = pgTable(
  'media',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').references(() => variants.id, { onDelete: 'cascade' }),

    kind: mediaKind('kind').notNull().default('image'),
    url: text('url').notNull(),
    /** Explicit dimensions let the storefront reserve space and keep CLS at 0. */
    width: integer('width'),
    height: integer('height'),
    /** Tiny base64 LQIP rendered while the real asset loads. */
    blurDataUrl: text('blur_data_url'),
    /** Required for images. Generated by AI vision when the merchant skips it. */
    altText: text('alt_text'),
    durationSeconds: integer('duration_seconds'),
    position: integer('position').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index('media_product_idx').on(t.productId, t.position),
    index('media_variant_idx').on(t.variantId, t.position),
  ],
);

/* ──────────────────────── Semantic search index ─────────────────────── */

/**
 * Product embeddings for semantic retrieval and "more like this".
 *
 * Kept in a sidecar table rather than a column on `products` because the
 * embedding is ~6 KB of the row: inlining it would bloat every product read
 * with data that only the search path uses, and would force a rewrite of the
 * entire heap tuple on every price change. The sidecar also lets us version
 * the embedding model and backfill without touching the catalogue.
 *
 * HNSW over IVFFlat: HNSW builds slower but is dramatically better at high
 * recall on the small-to-medium catalogues (<500k SKUs) this platform targets,
 * and needs no retraining when the catalogue grows.
 */
export const productEmbeddings = pgTable(
  'product_embeddings',
  {
    productId: uuid('product_id')
      .primaryKey()
      .references(() => products.id, { onDelete: 'cascade' }),
    tenantId: tenantId(),
    /** voyage-3-large / text-embedding-3-large are both 1024-dim at this setting. */
    embedding: vector('embedding', { dimensions: 1024 }).notNull(),
    model: varchar('model', { length: 64 }).notNull(),
    /** Hash of the text that produced it — lets a backfill skip unchanged rows. */
    sourceHash: varchar('source_hash', { length: 64 }).notNull(),
    ...timestamps(),
  },
  (t) => [
    index('product_embeddings_hnsw_idx').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
    index('product_embeddings_tenant_idx').on(t.tenantId),
  ],
);

/* ────────────────────────────── Reviews ─────────────────────────────── */

export const reviewStatus = pgEnum('review_status', ['pending', 'published', 'rejected']);

export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').references(() => variants.id, { onDelete: 'set null' }),
    customerId: uuid('customer_id'),
    orderId: uuid('order_id'),

    rating: smallint('rating').notNull(),
    title: text('title'),
    body: text('body'),
    mediaUrls: jsonb('media_urls').notNull().default([]),

    /** Only true when the reviewer actually bought it. Displayed as a badge. */
    isVerifiedPurchase: boolean('is_verified_purchase').notNull().default(false),
    helpfulCount: integer('helpful_count').notNull().default(0),

    status: reviewStatus('status').notNull().default('pending'),
    /** AI moderation verdict + score; a human confirms anything borderline. */
    moderationResult: jsonb('moderation_result'),
    merchantReply: text('merchant_reply'),
    merchantRepliedAt: timestamp('merchant_replied_at', { withTimezone: true, mode: 'date' }),

    ...softDeleteTimestamps(),
  },
  (t) => [
    index('reviews_product_status_idx').on(t.productId, t.status),
    index('reviews_tenant_created_idx').on(t.tenantId, t.createdAt),
    // One review per customer per product; edits update the existing row.
    uniqueIndex('reviews_customer_product_key').on(t.customerId, t.productId),
  ],
);

/**
 * Cached AI summary of a product's reviews ("what buyers say"). Regenerated on
 * a debounce when review count crosses a threshold, never on page render —
 * summarising 400 reviews inside a request would blow the LCP budget and the
 * AI bill simultaneously.
 */
export const reviewSummaries = pgTable('review_summaries', {
  productId: uuid('product_id')
    .primaryKey()
    .references(() => products.id, { onDelete: 'cascade' }),
  tenantId: tenantId(),
  summary: text('summary').notNull(),
  pros: jsonb('pros').notNull().default([]),
  cons: jsonb('cons').notNull().default([]),
  /** Review count at generation time; drives the regeneration decision. */
  basedOnReviewCount: integer('based_on_review_count').notNull(),
  model: varchar('model', { length: 64 }).notNull(),
  ...timestamps(),
});

/* ─────────────────── Merchandising relationships ────────────────────── */

export const productLinkType = pgEnum('product_link_type', [
  'related',
  'accessory',
  'upsell',
  'cross_sell',
  'compatible_with',
  'replacement_for',
]);

/**
 * Explicit product relationships. `compatible_with` is the one that earns its
 * keep in this vertical: "does this case fit a Galaxy S25?" is the single most
 * common accessory pre-sale question, and answering it in the UI removes a
 * support conversation per order.
 */
export const productLinks = pgTable(
  'product_links',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    linkedProductId: uuid('linked_product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    type: productLinkType('type').notNull().default('related'),
    position: integer('position').notNull().default(0),
    /** true when a recommender created it, false when a merchant curated it. */
    isAutomatic: boolean('is_automatic').notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('product_links_key').on(t.productId, t.linkedProductId, t.type),
    index('product_links_lookup_idx').on(t.tenantId, t.productId, t.type),
  ],
);

/* ───────────────────────────── Relations ────────────────────────────── */

export const productsRelations = relations(products, ({ one, many }) => ({
  brand: one(brands, { fields: [products.brandId], references: [brands.id] }),
  category: one(categories, { fields: [products.categoryId], references: [categories.id] }),
  variants: many(variants),
  media: many(media),
  reviews: many(reviews),
  attributeValues: many(productAttributeValues),
}));

export const variantsRelations = relations(variants, ({ one, many }) => ({
  product: one(products, { fields: [variants.productId], references: [products.id] }),
  media: many(media),
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  parent: one(categories, { fields: [categories.parentId], references: [categories.id] }),
  products: many(products),
}));

export const reviewsRelations = relations(reviews, ({ one }) => ({
  product: one(products, { fields: [reviews.productId], references: [products.id] }),
}));
