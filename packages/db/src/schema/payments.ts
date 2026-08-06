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
import { currency, money, tenantId, timestamps } from './_shared';
import { customers, orders } from './commerce';

/**
 * PAYMENTS DATA MODEL
 *
 * The design goal is that adding a gateway is a *data* change plus one adapter
 * file, never a schema migration. So nothing here is named after a provider:
 * there is no `stripe_charge_id` column and no `network_trx_id` column. Instead
 * every row carries `provider`, a provider-agnostic status, and a `raw` JSONB
 * blob holding the untouched provider payload for forensics.
 *
 * The ledger is double-entry-ish: `paymentIntents` express intent ("collect
 * AED 45,000 for order X"), `transactions` are the immutable financial facts
 * (authorise / capture / refund / void). Order.paidTotal is a projection of
 * captured transactions. Any disagreement is a reconciliation bug and the
 * transactions win.
 */

export const paymentProvider = pgEnum('payment_provider', [
  'cod',
  'paytabs',
  'network',
  'nagad',
  'stripe',
  'paypal',
  'bank_transfer',
  'store_credit',
  'gift_card',
  'manual',
]);

export const paymentIntentStatus = pgEnum('payment_intent_status', [
  'created',
  'requires_action',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
]);

export const transactionKind = pgEnum('transaction_kind', [
  'authorisation',
  'capture',
  'sale',
  'refund',
  'void',
  'chargeback',
  'chargeback_reversal',
  'payout',
]);

export const transactionStatus = pgEnum('transaction_status', [
  'pending',
  'succeeded',
  'failed',
  'cancelled',
]);

/** Merchant-configurable gateway credentials & display settings, per tenant. */
export const paymentMethodConfigs = pgTable(
  'payment_method_configs',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    provider: paymentProvider('provider').notNull(),
    displayName: text('display_name').notNull(),
    logoUrl: text('logo_url'),
    isEnabled: boolean('is_enabled').notNull().default(false),
    isTestMode: boolean('is_test_mode').notNull().default(true),
    position: integer('position').notNull().default(0),

    /**
     * Envelope-encrypted credentials (AES-256-GCM, key in KMS). The application
     * decrypts on use and never logs the plaintext. Storing these in the DB
     * rather than env vars is what makes multi-merchant SaaS possible.
     */
    credentialsEncrypted: text('credentials_encrypted'),

    /** e.g. { minOrderTotal, maxOrderTotal, allowedRegions, requiresVerifiedPhone } */
    rules: jsonb('rules').notNull().default({}),
    /** Gateway fee model, used to compute true net margin per order. */
    feeConfig: jsonb('fee_config').notNull().default({}),
    ...timestamps(),
  },
  (t) => [uniqueIndex('payment_method_configs_key').on(t.tenantId, t.provider)],
);

export const paymentIntents = pgTable(
  'payment_intents',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),

    provider: paymentProvider('provider').notNull(),
    /** The gateway's own identifier, whatever it calls it. */
    providerReference: varchar('provider_reference', { length: 128 }),

    amount: money('amount').notNull(),
    currency: currency().notNull().default('AED'),
    status: paymentIntentStatus('status').notNull().default('created'),

    /**
     * Client-supplied idempotency key. A double-tapped "Pay" button on a flaky
     * mobile connection must not create two charges; the unique index below is
     * the enforcement, not a code convention.
     */
    idempotencyKey: varchar('idempotency_key', { length: 64 }).notNull(),

    /** Where the gateway sends the shopper for 3-D Secure / OTP / wallet PIN. */
    redirectUrl: text('redirect_url'),
    returnUrl: text('return_url'),

    failureCode: varchar('failure_code', { length: 64 }),
    failureMessage: text('failure_message'),

    raw: jsonb('raw'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    succeededAt: timestamp('succeeded_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('payment_intents_idempotency_key').on(t.tenantId, t.idempotencyKey),
    index('payment_intents_order_idx').on(t.orderId),
    index('payment_intents_provider_ref_idx').on(t.provider, t.providerReference),
    index('payment_intents_status_idx').on(t.tenantId, t.status),
  ],
);

/** Immutable financial facts. Never updated except to move `pending`→terminal. */
export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'restrict' }),
    paymentIntentId: uuid('payment_intent_id').references(() => paymentIntents.id, {
      onDelete: 'set null',
    }),
    /** For refunds: the capture being refunded. */
    parentTransactionId: uuid('parent_transaction_id'),

    provider: paymentProvider('provider').notNull(),
    providerReference: varchar('provider_reference', { length: 128 }),
    kind: transactionKind('kind').notNull(),
    status: transactionStatus('status').notNull().default('pending'),

    amount: money('amount').notNull(),
    currency: currency().notNull().default('AED'),
    /** Gateway fee, so net settlement is knowable without a spreadsheet. */
    feeAmount: money('fee_amount'),

    reason: text('reason'),
    raw: jsonb('raw'),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    index('transactions_order_idx').on(t.orderId, t.createdAt),
    index('transactions_intent_idx').on(t.paymentIntentId),
    index('transactions_tenant_created_idx').on(t.tenantId, t.createdAt),
    uniqueIndex('transactions_provider_ref_key').on(t.provider, t.providerReference, t.kind),
  ],
);

/**
 * Raw inbound webhook envelope, persisted *before* processing.
 *
 * Gateways retry aggressively and deliver out of order. Recording the event
 * first (with a unique constraint on the provider's event id) gives exactly-once
 * processing, a replay tool for when a handler has a bug, and an audit trail for
 * "the gateway says they told us — did they?"
 */
export const paymentWebhookEvents = pgTable(
  'payment_webhook_events',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    provider: paymentProvider('provider').notNull(),
    providerEventId: varchar('provider_event_id', { length: 128 }).notNull(),
    eventType: varchar('event_type', { length: 64 }),
    signatureVerified: boolean('signature_verified').notNull().default(false),
    payload: jsonb('payload').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    processingError: text('processing_error'),
    attempts: smallint('attempts').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('payment_webhook_events_key').on(t.provider, t.providerEventId),
    index('payment_webhook_events_unprocessed_idx').on(t.processedAt),
  ],
);

/* ──────────────────── Stored value: credit & gift cards ─────────────── */

/**
 * Store credit ledger. Balance is derived by summing this table, never stored
 * as a mutable column — a mutable balance plus concurrent refunds is how stores
 * accidentally hand out free money.
 */
export const storeCreditEntries = pgTable(
  'store_credit_entries',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /** Signed minor units: positive = issued, negative = spent. */
    amount: money('amount').notNull(),
    currency: currency().notNull().default('AED'),
    reason: varchar('reason', { length: 48 }).notNull(),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    returnId: uuid('return_id'),
    note: text('note'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    actorUserId: uuid('actor_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('store_credit_entries_customer_idx').on(t.customerId, t.createdAt)],
);

export const giftCards = pgTable(
  'gift_cards',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    /** Only the hash is stored; the printable code exists once, at issue time. */
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    codeLast4: varchar('code_last4', { length: 4 }).notNull(),
    initialAmount: money('initial_amount').notNull(),
    balance: money('balance').notNull(),
    currency: currency().notNull().default('AED'),
    issuedToCustomerId: uuid('issued_to_customer_id'),
    issuedByOrderId: uuid('issued_by_order_id'),
    isActive: boolean('is_active').notNull().default(true),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [uniqueIndex('gift_cards_code_hash_key').on(t.codeHash)],
);

export const giftCardTransactions = pgTable(
  'gift_card_transactions',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    giftCardId: uuid('gift_card_id')
      .notNull()
      .references(() => giftCards.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    amount: money('amount').notNull(),
    balanceAfter: money('balance_after').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('gift_card_transactions_card_idx').on(t.giftCardId, t.createdAt)],
);

/**
 * Instalment plans (EMI). Common on handsets, where a AED 120,000 phone is
 * routinely sold as 12 monthly instalments through a bank partner.
 */
export const instalmentPlans = pgTable(
  'instalment_plans',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    provider: paymentProvider('provider').notNull(),
    termMonths: smallint('term_months').notNull(),
    /** Basis points, e.g. 950 = 9.50% APR. 0 for merchant-subsidised 0% EMI. */
    interestRateBps: integer('interest_rate_bps').notNull().default(0),
    downPayment: money('down_payment').notNull().default(0),
    instalmentAmount: money('instalment_amount').notNull(),
    totalPayable: money('total_payable').notNull(),
    currency: currency().notNull().default('AED'),
    schedule: jsonb('schedule').notNull().default([]),
    ...timestamps(),
  },
  (t) => [index('instalment_plans_order_idx').on(t.orderId)],
);

/* ───────────────────────────── Relations ────────────────────────────── */

export const paymentIntentsRelations = relations(paymentIntents, ({ one, many }) => ({
  order: one(orders, { fields: [paymentIntents.orderId], references: [orders.id] }),
  transactions: many(transactions),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  order: one(orders, { fields: [transactions.orderId], references: [orders.id] }),
  intent: one(paymentIntents, {
    fields: [transactions.paymentIntentId],
    references: [paymentIntents.id],
  }),
}));
