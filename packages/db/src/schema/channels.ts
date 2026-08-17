import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { currency, money, tenantId, timestamps } from './_shared';
import { variants } from './catalog';
import { warehouses } from './inventory';
import { orders } from './commerce';

/**
 * MARKETPLACE CHANNEL SYNC
 *
 * Voltix is the system of record; noon is a projection of it. Everything here
 * exists to answer two questions the sync engine asks constantly:
 *
 *   "What does noon call this variant?"   → noon_listings
 *   "What did we last successfully tell noon about it?"  → the pushed_* columns
 *
 * The second question is the one that makes this table more than a lookup.
 * A sync that only knows the desired state has to re-push the entire catalogue
 * on every run to be safe. Recording what actually landed — and when — turns
 * that into a diff, which is the difference between 12 API calls a day and
 * 12,000.
 *
 * WHY NOT A GENERIC "CHANNELS" ABSTRACTION
 * ----------------------------------------
 * There is exactly one marketplace integration. A `channel_listings` table
 * with a `channel_code` discriminator and a JSON blob of channel-specific
 * fields would be the same amount of work today and would model noon's
 * particulars — parent SKUs, per-country pricing rows, integration warehouse
 * codes — as untyped JSON. When a second marketplace arrives, the shape of
 * *its* differences will be known, and generalising from two real cases beats
 * guessing from one. See docs/00-decisions.md on the payments gateway port,
 * which earned its abstraction by having four adapters.
 */

/**
 * Where a listing stands in noon's own lifecycle.
 *
 * `pending_approval` is not decoration: noon reviews new catalogue content,
 * and a product sitting in review accepts neither stock nor price updates.
 * Pushing to it produces per-item rejections that look like bugs, so the sync
 * skips anything not yet `live`.
 */
export const noonListingStatus = pgEnum('noon_listing_status', [
  /** Mapped locally, never sent to noon. */
  'draft',
  /** Content submitted; noon is reviewing. Stock and price pushes are held. */
  'pending_approval',
  /** Approved and sellable. The only state the stock/price sync will touch. */
  'live',
  /** noon rejected the content. `last_error` holds their reason. */
  'rejected',
  /** Deliberately delisted by us. Retained so history and orders still resolve. */
  'archived',
]);

/**
 * The identity map between a Voltix variant and a noon listing.
 *
 * `partner_sku` is *our* identifier as noon stores it, and it is the join key
 * for every other API in this integration — stock, pricing and orders all
 * speak partner SKU and nothing else. It defaults to the variant's own SKU but
 * is stored separately because it cannot change once noon has seen it: renaming
 * a SKU in Voltix would otherwise orphan the listing and silently create a
 * second one on the next push.
 */
export const noonListings = pgTable(
  'noon_listings',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'cascade' }),

    /** Our SKU as noon knows it. Immutable after the first successful upsert. */
    partnerSku: varchar('partner_sku', { length: 64 }).notNull(),
    /** noon's generated parent, grouping the variants of one product. */
    skuParent: varchar('sku_parent', { length: 64 }),
    /** noon's own item code for this variant. */
    nsku: varchar('nsku', { length: 64 }),
    pskuCode: varchar('psku_code', { length: 64 }),

    /** noon category code. Determines which attributes are mandatory. */
    categoryCode: varchar('category_code', { length: 64 }),
    /** noon requires a brand string that matches their brand registry. */
    brandCode: varchar('brand_code', { length: 128 }),

    status: noonListingStatus('status').notNull().default('draft'),

    /**
     * Operator kill switch for one listing.
     *
     * Separate from `status` because the reasons differ: status is noon's view,
     * this is ours. A product being repriced manually on noon, or one whose
     * local stock figure is known to be wrong, needs to be excluded from the
     * sync without pretending it is archived.
     */
    syncEnabled: boolean('sync_enabled').notNull().default(true),

    // -- What we last successfully pushed ------------------------------------
    //
    // These are written only after noon accepts the item — never optimistically.
    // A push recorded before confirmation is a push that can be lost, and the
    // symptom is a listing stuck at a stale quantity that the diff thinks is
    // already correct.

    pushedQty: integer('pushed_qty'),
    pushedQtyAt: timestamp('pushed_qty_at', { withTimezone: true, mode: 'date' }),

    pushedPrice: money('pushed_price'),
    pushedMsrp: money('pushed_msrp'),
    pushedPriceCurrency: currency('pushed_price_currency'),
    pushedPriceAt: timestamp('pushed_price_at', { withTimezone: true, mode: 'date' }),

    /**
     * Hash of the content payload noon last accepted.
     *
     * Content upserts are the expensive call and the one that can send a live
     * listing back into review. Comparing a hash means an unchanged product is
     * skipped entirely rather than re-submitted on every sweep.
     */
    pushedContentHash: varchar('pushed_content_hash', { length: 64 }),
    pushedContentAt: timestamp('pushed_content_at', { withTimezone: true, mode: 'date' }),

    // -- Failure state -------------------------------------------------------

    /** noon's rejection message, verbatim. Shown to the operator in admin. */
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true, mode: 'date' }),
    /**
     * Consecutive failures. Drives back-off and, past a threshold, stops the
     * sync retrying a permanently malformed listing on every sweep forever.
     */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),

    ...timestamps(),
  },
  (t) => [
    // One listing per variant, and one partner SKU per tenant. Both are real
    // invariants on noon's side; enforcing them here means a double-create is
    // a constraint violation at the point of the bug rather than a duplicate
    // listing discovered by a customer.
    uniqueIndex('noon_listings_tenant_variant_key').on(t.tenantId, t.variantId),
    uniqueIndex('noon_listings_tenant_partner_sku_key').on(t.tenantId, t.partnerSku),
    index('noon_listings_status_idx').on(t.tenantId, t.status),
    // The reconcile sweep's driving query: live, enabled, ordered by staleness.
    index('noon_listings_sync_idx').on(t.tenantId, t.syncEnabled, t.pushedQtyAt),
  ],
);

/**
 * Maps a Voltix warehouse to a noon integration warehouse code.
 *
 * Every stock write and every order read is scoped to a `warehouse_code`, and
 * noon issues those codes — they cannot be derived from anything local. Without
 * this row the sync has no idea which of a merchant's warehouses a quantity
 * refers to, so `syncEnabled` on a listing is meaningless until at least one
 * warehouse is mapped.
 */
export const noonWarehouseMap = pgTable(
  'noon_warehouse_map',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'cascade' }),

    /** noon's integration warehouse code, e.g. "WH-DXB-01". */
    warehouseCode: varchar('warehouse_code', { length: 64 }).notNull(),
    /** noon's own label, cached from ListWarehouses so admin can show it. */
    displayName: varchar('display_name', { length: 255 }),
    fulfillmentSystemCode: varchar('fulfillment_system_code', { length: 64 }),

    /**
     * The marketplace country this warehouse serves: ae, sa, eg.
     *
     * Pricing is per country — the same partner SKU carries a different price
     * row for each — so this is what turns one local price into the right
     * number of pricing upserts.
     */
    countryCode: varchar('country_code', { length: 2 }).notNull().default('ae'),

    isActive: boolean('is_active').notNull().default(true),

    ...timestamps(),
  },
  (t) => [
    uniqueIndex('noon_warehouse_map_tenant_warehouse_key').on(t.tenantId, t.warehouseId),
    uniqueIndex('noon_warehouse_map_tenant_code_key').on(t.tenantId, t.warehouseCode),
  ],
);

/**
 * Imported noon orders, and the Voltix order each became.
 *
 * The unique index on `fbpi_order_nr` is the whole idempotency story for order
 * import. The pull job is at-least-once by construction — it re-reads a time
 * window that overlaps the previous run, because an order created during the
 * previous run's own execution would otherwise fall through the gap between
 * windows. Overlapping and deduplicating is correct; not overlapping loses
 * orders, and nobody notices until a customer asks where theirs went.
 */
export const noonOrderLinks = pgTable(
  'noon_order_links',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),

    /** noon's FBPI order number. The idempotency key for import. */
    fbpiOrderNr: varchar('fbpi_order_nr', { length: 64 }).notNull(),
    /** The marketplace-facing order number, shown to the customer. */
    mpOrderNr: varchar('mp_order_nr', { length: 64 }).notNull(),
    /** 'noon' or 'namshi' — the same integration serves both. */
    mpCode: varchar('mp_code', { length: 16 }).notNull().default('noon'),
    warehouseCode: varchar('warehouse_code', { length: 64 }).notNull(),

    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),

    /**
     * The order exactly as noon sent it.
     *
     * Kept because the import is lossy by design — Voltix's order model has no
     * place for `mp_item_nr`, and shipment confirmation needs it back. Storing
     * the payload means a mapping bug is repairable from local data instead of
     * requiring a re-fetch that may no longer return the same thing.
     */
    payload: jsonb('payload').notNull(),

    importedAt: timestamp('imported_at', { withTimezone: true, mode: 'date' }),
    /** Set when we have told noon the items shipped. */
    shipmentConfirmedAt: timestamp('shipment_confirmed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    lastError: text('last_error'),

    ...timestamps(),
  },
  (t) => [
    uniqueIndex('noon_order_links_tenant_fbpi_key').on(t.tenantId, t.fbpiOrderNr),
    index('noon_order_links_order_idx').on(t.orderId),
    // Drives "which imported orders still need a shipment pushed back".
    index('noon_order_links_pending_shipment_idx').on(t.tenantId, t.shipmentConfirmedAt),
  ],
);

export const noonListingsRelations = relations(noonListings, ({ one }) => ({
  variant: one(variants, {
    fields: [noonListings.variantId],
    references: [variants.id],
  }),
}));

export const noonWarehouseMapRelations = relations(noonWarehouseMap, ({ one }) => ({
  warehouse: one(warehouses, {
    fields: [noonWarehouseMap.warehouseId],
    references: [warehouses.id],
  }),
}));

export const noonOrderLinksRelations = relations(noonOrderLinks, ({ one }) => ({
  order: one(orders, {
    fields: [noonOrderLinks.orderId],
    references: [orders.id],
  }),
}));
