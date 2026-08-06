import { relations } from 'drizzle-orm';
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
import { currency, money, softDeleteTimestamps, tenantId, timestamps } from './_shared';
import { variants } from './catalog';

export const warehouseKind = pgEnum('warehouse_kind', ['warehouse', 'retail_store', 'dropship']);

export const warehouses = pgTable(
  'warehouses',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    code: varchar('code', { length: 32 }).notNull(),
    name: text('name').notNull(),
    kind: warehouseKind('kind').notNull().default('warehouse'),
    address: jsonb('address').notNull().default({}),
    /** Lat/lng for nearest-location fulfilment and click-and-collect. */
    latitude: varchar('latitude', { length: 24 }),
    longitude: varchar('longitude', { length: 24 }),
    /** Lower number wins when allocating stock across locations. */
    priority: smallint('priority').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
    ...softDeleteTimestamps(),
  },
  (t) => [uniqueIndex('warehouses_tenant_code_key').on(t.tenantId, t.code)],
);

/**
 * Stock level per (variant, warehouse).
 *
 * THE OVERSELL PROBLEM
 * --------------------
 * A single `quantity` column is the classic mistake: two shoppers both read
 * "1 left", both check out, and one of them gets a phone call. This table
 * splits the truth three ways:
 *
 *   onHand      — units physically in the building
 *   reserved    — units promised to carts/orders but not yet picked
 *   available   — onHand − reserved  (generated column; never written directly)
 *
 * Reservations are rows in `stockReservations` with a TTL, created inside the
 * same transaction that validates availability, using `SELECT … FOR UPDATE` on
 * this row. Concurrency is therefore serialised per (variant, warehouse), which
 * is exactly the granularity that matters and costs nothing on unrelated SKUs.
 * `version` additionally guards optimistic-locking paths in bulk adjustments.
 */
export const stockLevels = pgTable(
  'stock_levels',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'cascade' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'cascade' }),

    onHand: integer('on_hand').notNull().default(0),
    reserved: integer('reserved').notNull().default(0),
    /** Ordered from the supplier, not yet received. Drives "back in stock" ETA. */
    incoming: integer('incoming').notNull().default(0),

    /** Restock trigger. Below this, the low-stock automation fires. */
    reorderPoint: integer('reorder_point').notNull().default(0),
    reorderQuantity: integer('reorder_quantity').notNull().default(0),
    /** Supplier lead time in days; feeds the demand forecast safety stock. */
    leadTimeDays: smallint('lead_time_days'),

    /** Allow selling below zero (pre-orders). Off by default, deliberately. */
    allowBackorder: boolean('allow_backorder').notNull().default(false),

    version: integer('version').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('stock_levels_variant_warehouse_key').on(t.variantId, t.warehouseId),
    index('stock_levels_tenant_idx').on(t.tenantId),
    index('stock_levels_reorder_idx').on(t.tenantId, t.reorderPoint),
  ],
);

export const reservationStatus = pgEnum('reservation_status', [
  'held',
  'committed',
  'released',
  'expired',
]);

/**
 * Time-boxed claim on stock. Created when a cart reaches checkout, committed
 * when payment succeeds, released on abandonment or expiry. A background sweep
 * expires stale holds, so a shopper who closes the tab does not freeze a unit
 * forever — the usual failure mode of naive "decrement on add-to-cart" designs.
 */
export const stockReservations = pgTable(
  'stock_reservations',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'cascade' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'cascade' }),
    quantity: integer('quantity').notNull(),

    cartId: uuid('cart_id'),
    orderId: uuid('order_id'),

    status: reservationStatus('status').notNull().default('held'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    index('stock_reservations_sweep_idx').on(t.status, t.expiresAt),
    index('stock_reservations_cart_idx').on(t.cartId),
    index('stock_reservations_order_idx').on(t.orderId),
  ],
);

export const stockMovementReason = pgEnum('stock_movement_reason', [
  'purchase_received',
  'sale',
  'return_restock',
  'damage',
  'theft',
  'transfer_in',
  'transfer_out',
  'manual_adjustment',
  'stocktake',
]);

/**
 * Append-only ledger of every quantity change. `stockLevels.onHand` is a
 * cached projection of this table; if the two ever disagree, this one is right
 * and the reconciliation job rebuilds the cache. Without a ledger, "we're
 * short three units and nobody knows why" is unanswerable.
 */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    /** Signed: +received, −sold. */
    delta: integer('delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    reason: stockMovementReason('reason').notNull(),
    /** Unit cost at the moment of the movement — the basis for COGS/margin. */
    unitCost: money('unit_cost'),
    currency: currency().default('AED'),
    referenceType: varchar('reference_type', { length: 32 }),
    referenceId: uuid('reference_id'),
    note: text('note'),
    actorUserId: uuid('actor_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('stock_movements_variant_idx').on(t.variantId, t.createdAt),
    index('stock_movements_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('stock_movements_reference_idx').on(t.referenceType, t.referenceId),
  ],
);

export const serialUnitStatus = pgEnum('serial_unit_status', [
  'in_stock',
  'reserved',
  'sold',
  'returned',
  'defective',
  'written_off',
]);

/**
 * Per-unit tracking for serialised goods (phones, laptops, tablets).
 *
 * This is the table that separates a real electronics platform from a generic
 * store template. IMEI capture is a legal requirement for handset sales in many
 * markets, warranty claims need the exact unit's purchase date, and a stolen
 * device is traced by serial. Accessories skip this entirely — `isSerialised`
 * on the variant decides.
 */
export const serialUnits = pgTable(
  'serial_units',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id').references(() => warehouses.id, { onDelete: 'set null' }),

    serialNumber: varchar('serial_number', { length: 64 }).notNull(),
    /** Dual-SIM handsets carry two IMEIs; stored as an array. */
    imei: jsonb('imei').notNull().default([]),

    status: serialUnitStatus('status').notNull().default('in_stock'),
    purchaseOrderId: uuid('purchase_order_id'),
    orderItemId: uuid('order_item_id'),

    unitCost: money('unit_cost'),
    currency: currency().default('AED'),

    warrantyStartsAt: timestamp('warranty_starts_at', { withTimezone: true, mode: 'date' }),
    warrantyEndsAt: timestamp('warranty_ends_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('serial_units_tenant_serial_key').on(t.tenantId, t.serialNumber),
    index('serial_units_variant_status_idx').on(t.variantId, t.status),
    index('serial_units_order_item_idx').on(t.orderItemId),
  ],
);

/* ───────────────────── Procurement / supply side ────────────────────── */

export const suppliers = pgTable(
  'suppliers',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    code: varchar('code', { length: 32 }).notNull(),
    name: text('name').notNull(),
    contactName: text('contact_name'),
    email: varchar('email', { length: 320 }),
    phone: varchar('phone', { length: 32 }),
    address: jsonb('address').notNull().default({}),
    /** "net_30", "advance", "on_delivery". */
    paymentTerms: varchar('payment_terms', { length: 32 }),
    defaultLeadTimeDays: smallint('default_lead_time_days'),
    currency: currency().notNull().default('AED'),

    /**
     * Rolling supplier scorecard, recomputed nightly from receipt history:
     * on-time %, quality (defect rate), price competitiveness. This is what
     * makes "recommend a supplier" an evidence-based answer instead of a guess.
     */
    scorecard: jsonb('scorecard').notNull().default({}),
    isActive: boolean('is_active').notNull().default(true),
    ...softDeleteTimestamps(),
  },
  (t) => [uniqueIndex('suppliers_tenant_code_key').on(t.tenantId, t.code)],
);

export const supplierProducts = pgTable(
  'supplier_products',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'cascade' }),
    supplierSku: varchar('supplier_sku', { length: 64 }),
    unitCost: money('unit_cost').notNull(),
    currency: currency().notNull().default('AED'),
    minOrderQuantity: integer('min_order_quantity').notNull().default(1),
    leadTimeDays: smallint('lead_time_days'),
    isPreferred: boolean('is_preferred').notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('supplier_products_key').on(t.supplierId, t.variantId),
    index('supplier_products_variant_idx').on(t.variantId),
  ],
);

export const purchaseOrderStatus = pgEnum('purchase_order_status', [
  'draft',
  'submitted',
  'confirmed',
  'partially_received',
  'received',
  'cancelled',
]);

export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    /** Human reference, e.g. PO-2026-0184. Unique per tenant. */
    number: varchar('number', { length: 32 }).notNull(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),

    status: purchaseOrderStatus('status').notNull().default('draft'),
    subtotal: money('subtotal').notNull().default(0),
    shippingCost: money('shipping_cost').notNull().default(0),
    taxTotal: money('tax_total').notNull().default(0),
    total: money('total').notNull().default(0),
    currency: currency().notNull().default('AED'),

    expectedAt: timestamp('expected_at', { withTimezone: true, mode: 'date' }),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' }),

    /** Set when the line items came from the demand forecast rather than a human. */
    generatedByForecastId: uuid('generated_by_forecast_id'),
    note: text('note'),
    createdByUserId: uuid('created_by_user_id'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('purchase_orders_tenant_number_key').on(t.tenantId, t.number),
    index('purchase_orders_status_idx').on(t.tenantId, t.status),
    index('purchase_orders_supplier_idx').on(t.supplierId),
  ],
);

export const purchaseOrderItems = pgTable(
  'purchase_order_items',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'restrict' }),
    quantityOrdered: integer('quantity_ordered').notNull(),
    quantityReceived: integer('quantity_received').notNull().default(0),
    unitCost: money('unit_cost').notNull(),
    currency: currency().notNull().default('AED'),
    ...timestamps(),
  },
  (t) => [index('purchase_order_items_po_idx').on(t.purchaseOrderId)],
);

/* ───────────────────────────── Relations ────────────────────────────── */

export const stockLevelsRelations = relations(stockLevels, ({ one }) => ({
  variant: one(variants, { fields: [stockLevels.variantId], references: [variants.id] }),
  warehouse: one(warehouses, { fields: [stockLevels.warehouseId], references: [warehouses.id] }),
}));

export const purchaseOrdersRelations = relations(purchaseOrders, ({ one, many }) => ({
  supplier: one(suppliers, { fields: [purchaseOrders.supplierId], references: [suppliers.id] }),
  warehouse: one(warehouses, { fields: [purchaseOrders.warehouseId], references: [warehouses.id] }),
  items: many(purchaseOrderItems),
}));

export const purchaseOrderItemsRelations = relations(purchaseOrderItems, ({ one }) => ({
  purchaseOrder: one(purchaseOrders, {
    fields: [purchaseOrderItems.purchaseOrderId],
    references: [purchaseOrders.id],
  }),
  variant: one(variants, { fields: [purchaseOrderItems.variantId], references: [variants.id] }),
}));
