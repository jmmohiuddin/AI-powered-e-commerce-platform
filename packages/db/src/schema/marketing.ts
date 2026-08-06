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
} from 'drizzle-orm/pg-core';
import { currency, money, tenantId, timestamps } from './_shared';
import { customers, orders } from './commerce';

/* ──────────────────────── Discounts & coupons ───────────────────────── */

export const discountType = pgEnum('discount_type', [
  'percentage',
  'fixed_amount',
  'free_shipping',
  'buy_x_get_y',
  'bundle',
]);

export const discountScope = pgEnum('discount_scope', [
  'order',
  'product',
  'category',
  'brand',
  'shipping',
]);

/**
 * One table for both automatic promotions and code-based coupons; `code` is
 * simply null for automatic ones. Splitting them into two tables duplicates the
 * entire eligibility-rule engine, and every store eventually wants "this
 * automatic promo, but also as a shareable code".
 */
export const discounts = pgTable(
  'discounts',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    /** Null = automatic promotion applied without a code. */
    code: varchar('code', { length: 64 }),
    name: text('name').notNull(),
    description: text('description'),

    type: discountType('type').notNull(),
    scope: discountScope('scope').notNull().default('order'),
    /** Percentage in basis points (1500 = 15%), or minor units for fixed. */
    value: integer('value').notNull(),
    maxDiscountAmount: money('max_discount_amount'),
    currency: currency().default('AED'),

    /**
     * Declarative eligibility, evaluated by the pricing engine:
     * { minSubtotal, minQuantity, productIds, categoryIds, brandIds,
     *   customerSegments, firstOrderOnly, channels, paymentProviders }
     * Keeping this as data rather than code means a merchant can build
     * "10% off Xiaomi accessories over AED 200, Tabby only" with no deploy.
     */
    conditions: jsonb('conditions').notNull().default({}),

    usageLimit: integer('usage_limit'),
    usageLimitPerCustomer: integer('usage_limit_per_customer'),
    usageCount: integer('usage_count').notNull().default(0),

    /** Whether it may combine with other discounts; default is deliberately no. */
    isStackable: boolean('is_stackable').notNull().default(false),
    /** Higher priority wins when two exclusive discounts both qualify. */
    priority: smallint('priority').notNull().default(0),

    isActive: boolean('is_active').notNull().default(true),
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }),
    endsAt: timestamp('ends_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('discounts_tenant_code_key').on(t.tenantId, t.code),
    index('discounts_active_idx').on(t.tenantId, t.isActive, t.startsAt, t.endsAt),
  ],
);

/** One row per redemption. Enforces per-customer limits without a race. */
export const discountRedemptions = pgTable(
  'discount_redemptions',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    discountId: uuid('discount_id')
      .notNull()
      .references(() => discounts.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    amount: money('amount').notNull(),
    currency: currency().notNull().default('AED'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('discount_redemptions_order_key').on(t.discountId, t.orderId),
    index('discount_redemptions_customer_idx').on(t.discountId, t.customerId),
  ],
);

/* ────────────────────────────── Loyalty ─────────────────────────────── */

export const loyaltyTransactions = pgTable(
  'loyalty_transactions',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /** Signed points: earned positive, redeemed negative. */
    points: integer('points').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    reason: varchar('reason', { length: 48 }).notNull(),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    note: text('note'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('loyalty_transactions_customer_idx').on(t.customerId, t.createdAt)],
);

/* ───────────────────────────── Campaigns ────────────────────────────── */

export const campaignChannel = pgEnum('campaign_channel', [
  'email',
  'sms',
  'whatsapp',
  'push',
  'facebook',
  'instagram',
  'tiktok',
  'linkedin',
  'x',
  'onsite',
]);

export const campaignStatus = pgEnum('campaign_status', [
  'draft',
  'scheduled',
  'sending',
  'sent',
  'paused',
  'cancelled',
  'failed',
]);

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    channel: campaignChannel('channel').notNull(),
    status: campaignStatus('status').notNull().default('draft'),

    /** Segment query or explicit customer list. */
    audience: jsonb('audience').notNull().default({}),
    audienceSize: integer('audience_size'),

    /** Rendered content per channel: subject/body/mediaUrls/cta. */
    content: jsonb('content').notNull().default({}),

    /**
     * Provenance of AI-generated content: which task, model and prompt version
     * produced it, and whether a human edited it before sending. Required for
     * brand-safety review and for measuring whether AI copy actually converts
     * better than human copy — the only way the feature earns its cost.
     */
    aiProvenance: jsonb('ai_provenance'),
    approvedByUserId: uuid('approved_by_user_id'),
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),

    scheduledAt: timestamp('scheduled_at', { withTimezone: true, mode: 'date' }),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),

    /** Denormalised counters; the event stream in campaignEvents is the source. */
    stats: jsonb('stats').notNull().default({}),
    /** Attributed revenue, minor units, from campaignEvents → orders join. */
    attributedRevenue: money('attributed_revenue').notNull().default(0),
    spend: money('spend').notNull().default(0),
    currency: currency().notNull().default('AED'),
    ...timestamps(),
  },
  (t) => [
    index('campaigns_tenant_status_idx').on(t.tenantId, t.status),
    index('campaigns_scheduled_idx').on(t.status, t.scheduledAt),
  ],
);

export const campaignEvents = pgTable(
  'campaign_events',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    /** sent | delivered | opened | clicked | converted | bounced | unsubscribed */
    type: varchar('type', { length: 24 }).notNull(),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    revenue: money('revenue'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('campaign_events_campaign_idx').on(t.campaignId, t.type),
    index('campaign_events_customer_idx').on(t.customerId),
  ],
);

/**
 * Generated marketing assets awaiting review. AI output never publishes
 * itself — a merchant approves every post before it leaves the building.
 * Autonomous posting is a brand-damage incident waiting for a bad prompt.
 */
export const contentAssetStatus = pgEnum('content_asset_status', [
  'generated',
  'edited',
  'approved',
  'published',
  'rejected',
]);

export const contentAssets = pgTable(
  'content_assets',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    channel: campaignChannel('channel').notNull(),
    /** post | story | banner | email | ad_copy | caption | script */
    format: varchar('format', { length: 32 }).notNull(),
    status: contentAssetStatus('status').notNull().default('generated'),

    body: text('body'),
    headline: text('headline'),
    hashtags: jsonb('hashtags').notNull().default([]),
    mediaUrls: jsonb('media_urls').notNull().default([]),

    productIds: jsonb('product_ids').notNull().default([]),
    aiProvenance: jsonb('ai_provenance'),
    /** Set when a human changed the text, so we can measure edit distance. */
    editedByUserId: uuid('edited_by_user_id'),
    ...timestamps(),
  },
  (t) => [index('content_assets_tenant_status_idx').on(t.tenantId, t.status)],
);

/* ────────────────────── Behavioural / analytics ─────────────────────── */

/**
 * Clickstream. Written by a fire-and-forget queue, never in the request path —
 * analytics must not be able to slow down or fail a page render.
 *
 * Partitioned monthly (see migration 0003). Events are the highest-volume table
 * in the system by two orders of magnitude; partitioning turns retention from a
 * multi-hour DELETE into an instant DETACH PARTITION.
 */
export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    storeId: uuid('store_id'),
    sessionId: varchar('session_id', { length: 64 }).notNull(),
    customerId: uuid('customer_id'),

    /** page_view | product_view | search | add_to_cart | begin_checkout | purchase */
    type: varchar('type', { length: 32 }).notNull(),
    productId: uuid('product_id'),
    variantId: uuid('variant_id'),
    searchQuery: text('search_query'),
    value: money('value'),
    currency: currency().default('AED'),

    referrer: text('referrer'),
    utm: jsonb('utm'),
    deviceType: varchar('device_type', { length: 16 }),
    countryCode: varchar('country_code', { length: 2 }),
    properties: jsonb('properties'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('analytics_events_tenant_type_idx').on(t.tenantId, t.type, t.createdAt),
    index('analytics_events_session_idx').on(t.sessionId),
    index('analytics_events_product_idx').on(t.productId, t.type),
  ],
);

/**
 * Search query log with outcomes. The zero-result and zero-click queries here
 * are the single highest-ROI merchandising report a store has: they are
 * customers telling you, in their own words, what you failed to sell them.
 */
export const searchQueries = pgTable(
  'search_queries',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    sessionId: varchar('session_id', { length: 64 }),
    customerId: uuid('customer_id'),
    query: text('query').notNull(),
    normalisedQuery: text('normalised_query').notNull(),
    resultCount: integer('result_count').notNull().default(0),
    clickedProductId: uuid('clicked_product_id'),
    clickedPosition: smallint('clicked_position'),
    convertedOrderId: uuid('converted_order_id'),
    /** 'lexical' | 'semantic' | 'hybrid' — lets us A/B the retrieval strategy. */
    strategy: varchar('strategy', { length: 16 }),
    latencyMs: integer('latency_ms'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('search_queries_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('search_queries_zero_result_idx').on(t.tenantId, t.resultCount),
    index('search_queries_normalised_idx').on(t.tenantId, t.normalisedQuery),
  ],
);

export const recentlyViewed = pgTable(
  'recently_viewed',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    customerId: uuid('customer_id'),
    sessionId: varchar('session_id', { length: 64 }),
    productId: uuid('product_id').notNull(),
    viewCount: integer('view_count').notNull().default(1),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('recently_viewed_customer_key').on(t.customerId, t.productId),
    uniqueIndex('recently_viewed_session_key').on(t.sessionId, t.productId),
    index('recently_viewed_lookup_idx').on(t.customerId, t.lastViewedAt),
  ],
);

export const wishlists = pgTable(
  'wishlists',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id'),
    /** Price when saved; powers "price dropped AED 3,000 since you saved this". */
    priceAtSave: money('price_at_save'),
    currency: currency().default('AED'),
    notifyOnPriceDrop: boolean('notify_on_price_drop').notNull().default(true),
    notifyOnRestock: boolean('notify_on_restock').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('wishlists_customer_variant_key').on(t.customerId, t.productId, t.variantId),
    index('wishlists_product_idx').on(t.productId),
  ],
);
