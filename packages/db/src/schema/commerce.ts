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
import { products, variants } from './catalog';
import { warehouses } from './inventory';
import { stores } from './tenancy';

/* ───────────────────────────── Customers ────────────────────────────── */

/**
 * Shoppers. Deliberately not the same table as staff `users` — see tenancy.ts.
 *
 * Both `email` and `phone` are nullable, and either can serve as the identity.
 * In the UAE a mobile number is the more reliable handle — it is what the
 * courier calls, what the OTP goes to, and what a WhatsApp order arrives from —
 * while email is what a card receipt needs. Requiring both at signup adds a
 * checkout step for no gain; requiring neither makes the order uncontactable.
 * The constraint is enforced at the application layer: at least one.
 */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    email: varchar('email', { length: 320 }),
    phone: varchar('phone', { length: 32 }),
    firstName: text('first_name'),
    lastName: text('last_name'),
    passwordHash: text('password_hash'),

    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true, mode: 'date' }),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true, mode: 'date' }),

    acceptsMarketingEmail: boolean('accepts_marketing_email').notNull().default(false),
    acceptsMarketingSms: boolean('accepts_marketing_sms').notNull().default(false),
    acceptsMarketingWhatsapp: boolean('accepts_marketing_whatsapp').notNull().default(false),

    /** Loyalty balance, in points. Ledger of record is `loyaltyTransactions`. */
    loyaltyPoints: integer('loyalty_points').notNull().default(0),
    loyaltyTier: varchar('loyalty_tier', { length: 24 }).notNull().default('bronze'),

    /** Rolling analytics, refreshed nightly: LTV, AOV, order count, RFM scores. */
    stats: jsonb('stats').notNull().default({}),
    /** AI-assigned segments, e.g. ["price_sensitive","accessory_buyer"]. */
    segments: jsonb('segments').notNull().default([]),

    /**
     * Running risk score 0–100 from the fraud model. Advisory, never a silent
     * block: it gates cash-on-delivery eligibility, decides whether 3-D Secure
     * is forced, and flags an order for review. In the UAE the model weighs
     * card-not-present fraud and COD refusal in parallel, because both are
     * live loss modes here — see packages/ai/src/risk.ts.
     */
    riskScore: smallint('risk_score').notNull().default(0),

    note: text('note'),
    lastOrderAt: timestamp('last_order_at', { withTimezone: true, mode: 'date' }),
    ...softDeleteTimestamps(),
  },
  (t) => [
    uniqueIndex('customers_tenant_email_key').on(t.tenantId, t.email),
    uniqueIndex('customers_tenant_phone_key').on(t.tenantId, t.phone),
    index('customers_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('customers_risk_idx').on(t.tenantId, t.riskScore),
  ],
);

export const addresses = pgTable(
  'addresses',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),

    label: varchar('label', { length: 32 }),
    recipientName: text('recipient_name').notNull(),
    /** E.164. UAE mobiles normalise to +9715XXXXXXXX. */
    phone: varchar('phone', { length: 32 }).notNull(),

    /**
     * UAE ADDRESSING — the detail that breaks imported checkout flows.
     *
     * The UAE has no postal-code system. `postalCode` is retained only so the
     * schema can hold an address from another country; it is never required.
     * A mandatory postal-code field either blocks the order or trains every
     * customer to type "00000", which then defeats address validation, courier
     * zone lookup and fraud scoring simultaneously.
     *
     * What a UAE courier actually needs: the emirate (which sets the delivery
     * zone and fee), the community, a building name, and ideally a Makani
     * number — a 10-digit geo-address resolving to a building entrance that
     * couriers navigate to directly. Where a Makani is present it is more
     * reliable than any written address.
     */
    /** DU, AZ, SH, AJ, UQ, RK, FU. Drives courier zone and delivery fee. */
    emirate: varchar('emirate', { length: 2 }),
    /** Community or district — Al Barsha, Dubai Marina, Al Nahda. */
    area: text('area'),
    buildingName: text('building_name'),
    flatOrVilla: varchar('flat_or_villa', { length: 32 }),
    street: text('street'),
    /** 10-digit Dubai geo-address. */
    makani: varchar('makani', { length: 10 }),
    /** Business deliveries only — never sufficient for a courier drop. */
    poBox: varchar('po_box', { length: 16 }),
    /** Free-form landmark. Still how many people describe where they live. */
    landmark: text('landmark'),

    line1: text('line1'),
    line2: text('line2'),
    city: text('city'),
    region: text('region'),
    /** Nullable by design — see the note above. */
    postalCode: varchar('postal_code', { length: 16 }),
    countryCode: varchar('country_code', { length: 2 }).notNull().default('AE'),

    latitude: varchar('latitude', { length: 24 }),
    longitude: varchar('longitude', { length: 24 }),

    isDefaultShipping: boolean('is_default_shipping').notNull().default(false),
    isDefaultBilling: boolean('is_default_billing').notNull().default(false),
    ...softDeleteTimestamps(),
  },
  (t) => [
    index('addresses_customer_idx').on(t.customerId),
    // Courier zone lookup and per-emirate delivery reporting.
    index('addresses_emirate_idx').on(t.tenantId, t.emirate),
  ],
);

/* ─────────────────────────────── Carts ──────────────────────────────── */

export const cartStatus = pgEnum('cart_status', ['active', 'converted', 'abandoned', 'merged']);

export const carts = pgTable(
  'carts',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    /** Anonymous cart key held in an httpOnly cookie; merged on login. */
    sessionToken: varchar('session_token', { length: 64 }),

    status: cartStatus('status').notNull().default('active'),
    currency: currency().notNull().default('AED'),

    /**
     * Totals are *cached*, not authoritative. The pricing engine in
     * @voltix/core recomputes from line items on every mutation and again at
     * order placement. Trusting a client-supplied or stale total is the single
     * most common way a store gets robbed.
     */
    subtotal: money('subtotal').notNull().default(0),
    discountTotal: money('discount_total').notNull().default(0),
    shippingTotal: money('shipping_total').notNull().default(0),
    taxTotal: money('tax_total').notNull().default(0),
    total: money('total').notNull().default(0),

    appliedCoupons: jsonb('applied_coupons').notNull().default([]),
    shippingAddressId: uuid('shipping_address_id'),

    /** Attribution captured at first touch, carried to the order. */
    attribution: jsonb('attribution').notNull().default({}),

    abandonedAt: timestamp('abandoned_at', { withTimezone: true, mode: 'date' }),
    recoveryEmailSentAt: timestamp('recovery_email_sent_at', { withTimezone: true, mode: 'date' }),
    convertedOrderId: uuid('converted_order_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    index('carts_session_idx').on(t.sessionToken),
    index('carts_customer_idx').on(t.customerId),
    // Powers the abandoned-cart sweep: active carts untouched for N hours.
    index('carts_abandonment_idx').on(t.tenantId, t.status, t.updatedAt),
  ],
);

export const cartItems = pgTable(
  'cart_items',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    cartId: uuid('cart_id')
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull().default(1),
    /** Price snapshot at add-to-cart; re-validated before payment. */
    unitPrice: money('unit_price').notNull(),
    currency: currency().notNull().default('AED'),
    /** Engraving, bundled screen protector, gift note. */
    customisations: jsonb('customisations'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('cart_items_cart_variant_key').on(t.cartId, t.variantId),
    index('cart_items_cart_idx').on(t.cartId),
  ],
);

/* ─────────────────────────────── Orders ─────────────────────────────── */

/**
 * Order lifecycle is modelled as three orthogonal statuses rather than one
 * enum. A single `status` column forces impossible questions like "is
 * `refunded` before or after `shipped`?" — real orders are paid *and* partially
 * shipped *and* partially refunded at the same time. Keeping payment,
 * fulfilment and the overall lifecycle separate makes every combination
 * representable and every transition independently guarded (see
 * @voltix/core/orders/state-machine.ts).
 */
export const orderStatus = pgEnum('order_status', [
  'pending',
  'confirmed',
  'processing',
  'completed',
  'cancelled',
]);
export const paymentStatus = pgEnum('payment_status', [
  'unpaid',
  'authorised',
  'partially_paid',
  'paid',
  'partially_refunded',
  'refunded',
  'failed',
]);
export const fulfilmentStatus = pgEnum('fulfilment_status', [
  'unfulfilled',
  'partially_fulfilled',
  'fulfilled',
  'partially_returned',
  'returned',
]);
export const orderChannel = pgEnum('order_channel', [
  'web',
  'mobile_app',
  'whatsapp',
  'phone',
  'pos',
  'marketplace',
]);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'set null' }),
    /** Per-tenant sequential human reference, e.g. #10428. */
    number: varchar('number', { length: 32 }).notNull(),

    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    /** Populated for guest checkout, where customerId may be null. */
    email: varchar('email', { length: 320 }),
    phone: varchar('phone', { length: 32 }),

    status: orderStatus('status').notNull().default('pending'),
    paymentStatus: paymentStatus('payment_status').notNull().default('unpaid'),
    fulfilmentStatus: fulfilmentStatus('fulfilment_status').notNull().default('unfulfilled'),
    channel: orderChannel('channel').notNull().default('web'),

    currency: currency().notNull().default('AED'),
    subtotal: money('subtotal').notNull().default(0),
    discountTotal: money('discount_total').notNull().default(0),
    shippingTotal: money('shipping_total').notNull().default(0),
    taxTotal: money('tax_total').notNull().default(0),
    total: money('total').notNull().default(0),
    /** Sum of captured payments. Invariant: paidTotal ≤ total. */
    paidTotal: money('paid_total').notNull().default(0),
    refundedTotal: money('refunded_total').notNull().default(0),
    /** Snapshot of COGS at placement, so margin reports survive cost changes. */
    costTotal: money('cost_total').notNull().default(0),

    /**
     * Addresses are embedded copies, not foreign keys. An invoice must render
     * the address as it was when the order shipped; if the customer later edits
     * their saved address, historical orders must not silently change. This is
     * the one place denormalisation is not a shortcut but a correctness
     * requirement.
     */
    shippingAddress: jsonb('shipping_address'),
    billingAddress: jsonb('billing_address'),

    appliedDiscounts: jsonb('applied_discounts').notNull().default([]),
    attribution: jsonb('attribution').notNull().default({}),

    riskScore: smallint('risk_score').notNull().default(0),
    riskSignals: jsonb('risk_signals'),

    customerNote: text('customer_note'),
    internalNote: text('internal_note'),
    tags: jsonb('tags').notNull().default([]),

    placedAt: timestamp('placed_at', { withTimezone: true, mode: 'date' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    cancelReason: text('cancel_reason'),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('orders_tenant_number_key').on(t.tenantId, t.number),
    index('orders_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('orders_customer_idx').on(t.customerId, t.createdAt),
    index('orders_status_idx').on(t.tenantId, t.status),
    index('orders_payment_status_idx').on(t.tenantId, t.paymentStatus),
    index('orders_fulfilment_idx').on(t.tenantId, t.fulfilmentStatus),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /** Kept as `set null`: deleting a product must never orphan order history. */
    variantId: uuid('variant_id').references(() => variants.id, { onDelete: 'set null' }),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),

    /** Immutable snapshot — the invoice must survive catalogue edits. */
    sku: varchar('sku', { length: 64 }).notNull(),
    title: text('title').notNull(),
    variantTitle: text('variant_title'),
    imageUrl: text('image_url'),

    quantity: integer('quantity').notNull(),
    unitPrice: money('unit_price').notNull(),
    unitCost: money('unit_cost'),
    discountTotal: money('discount_total').notNull().default(0),
    taxTotal: money('tax_total').notNull().default(0),
    lineTotal: money('line_total').notNull(),
    currency: currency().notNull().default('AED'),

    quantityFulfilled: integer('quantity_fulfilled').notNull().default(0),
    quantityReturned: integer('quantity_returned').notNull().default(0),
    quantityRefunded: integer('quantity_refunded').notNull().default(0),

    warrantyMonths: smallint('warranty_months'),
    ...timestamps(),
  },
  (t) => [index('order_items_order_idx').on(t.orderId), index('order_items_variant_idx').on(t.variantId)],
);

/** Append-only order timeline. Powers the customer tracking page and support. */
export const orderEvents = pgTable(
  'order_events',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 48 }).notNull(),
    /** Shown to the customer when true; internal-only otherwise. */
    isPublic: boolean('is_public').notNull().default(false),
    message: text('message'),
    data: jsonb('data'),
    actorType: varchar('actor_type', { length: 24 }).notNull().default('system'),
    actorId: uuid('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('order_events_order_idx').on(t.orderId, t.createdAt)],
);

/* ──────────────────────────── Fulfilment ────────────────────────────── */

export const shipmentStatus = pgEnum('shipment_status', [
  'pending',
  'picked',
  'packed',
  'handed_over',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'failed',
  'returned_to_sender',
]);

export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    warehouseId: uuid('warehouse_id').references(() => warehouses.id, { onDelete: 'set null' }),

    carrierCode: varchar('carrier_code', { length: 32 }),
    serviceLevel: varchar('service_level', { length: 32 }),
    trackingNumber: varchar('tracking_number', { length: 64 }),
    trackingUrl: text('tracking_url'),

    status: shipmentStatus('status').notNull().default('pending'),
    /** Normalised carrier scan history: [{status, location, at}]. */
    trackingEvents: jsonb('tracking_events').notNull().default([]),

    /** Amount the courier must collect for a cash-on-delivery consignment. */
    codAmount: money('cod_amount'),
    codCollectedAt: timestamp('cod_collected_at', { withTimezone: true, mode: 'date' }),
    codRemittedAt: timestamp('cod_remitted_at', { withTimezone: true, mode: 'date' }),

    shippingCost: money('shipping_cost'),
    currency: currency().default('AED'),
    weightGrams: integer('weight_grams'),

    estimatedDeliveryAt: timestamp('estimated_delivery_at', { withTimezone: true, mode: 'date' }),
    shippedAt: timestamp('shipped_at', { withTimezone: true, mode: 'date' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    failureReason: text('failure_reason'),
    ...timestamps(),
  },
  (t) => [
    index('shipments_order_idx').on(t.orderId),
    index('shipments_tracking_idx').on(t.trackingNumber),
    index('shipments_status_idx').on(t.tenantId, t.status),
  ],
);

export const shipmentItems = pgTable(
  'shipment_items',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id, { onDelete: 'cascade' }),
    quantity: integer('quantity').notNull(),
    ...timestamps(),
  },
  (t) => [index('shipment_items_shipment_idx').on(t.shipmentId)],
);

/* ─────────────────────── Returns & aftersales ───────────────────────── */

export const returnStatus = pgEnum('return_status', [
  'requested',
  'approved',
  'rejected',
  'in_transit',
  'received',
  'inspected',
  'completed',
  'cancelled',
]);
export const returnReason = pgEnum('return_reason', [
  'damaged',
  'defective',
  'wrong_item',
  'not_as_described',
  'changed_mind',
  'better_price',
  'late_delivery',
  'other',
]);
export const returnResolution = pgEnum('return_resolution', [
  'refund',
  'exchange',
  'store_credit',
  'repair',
  'warranty_replacement',
]);

export const returns = pgTable(
  'returns',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    number: varchar('number', { length: 32 }).notNull(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),

    status: returnStatus('status').notNull().default('requested'),
    reason: returnReason('reason').notNull(),
    resolution: returnResolution('resolution').notNull().default('refund'),
    customerComment: text('customer_comment'),
    /** Photos the customer uploads with the claim. */
    evidenceUrls: jsonb('evidence_urls').notNull().default([]),

    inspectionNote: text('inspection_note'),
    /** Whether the returned unit can go back on the shelf. */
    restockable: boolean('restockable'),

    refundAmount: money('refund_amount'),
    currency: currency().default('AED'),

    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('returns_tenant_number_key').on(t.tenantId, t.number),
    index('returns_order_idx').on(t.orderId),
    index('returns_status_idx').on(t.tenantId, t.status),
  ],
);

export const returnItems = pgTable(
  'return_items',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    returnId: uuid('return_id')
      .notNull()
      .references(() => returns.id, { onDelete: 'cascade' }),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
    serialUnitId: uuid('serial_unit_id'),
    condition: varchar('condition', { length: 32 }),
    ...timestamps(),
  },
  (t) => [index('return_items_return_idx').on(t.returnId)],
);

/* ───────────────────────────── Relations ────────────────────────────── */

export const ordersRelations = relations(orders, ({ one, many }) => ({
  customer: one(customers, { fields: [orders.customerId], references: [customers.id] }),
  store: one(stores, { fields: [orders.storeId], references: [stores.id] }),
  items: many(orderItems),
  events: many(orderEvents),
  shipments: many(shipments),
  returns: many(returns),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  variant: one(variants, { fields: [orderItems.variantId], references: [variants.id] }),
  product: one(products, { fields: [orderItems.productId], references: [products.id] }),
}));

export const cartsRelations = relations(carts, ({ one, many }) => ({
  customer: one(customers, { fields: [carts.customerId], references: [customers.id] }),
  items: many(cartItems),
}));

export const cartItemsRelations = relations(cartItems, ({ one }) => ({
  cart: one(carts, { fields: [cartItems.cartId], references: [carts.id] }),
  variant: one(variants, { fields: [cartItems.variantId], references: [variants.id] }),
}));

export const customersRelations = relations(customers, ({ many }) => ({
  addresses: many(addresses),
  orders: many(orders),
}));

export const shipmentsRelations = relations(shipments, ({ one, many }) => ({
  order: one(orders, { fields: [shipments.orderId], references: [orders.id] }),
  items: many(shipmentItems),
}));

export const returnsRelations = relations(returns, ({ one, many }) => ({
  order: one(orders, { fields: [returns.orderId], references: [orders.id] }),
  items: many(returnItems),
}));
