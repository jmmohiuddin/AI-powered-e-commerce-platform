import { index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { money, tenantId, timestamps } from './_shared';
import { orders } from './commerce';

/**
 * TAX DOCUMENTS
 *
 * A UAE tax invoice is a legal instrument, not a rendering of an order. Two
 * consequences shape this table.
 *
 * **The number is issued once and never reissued.** Article 59 of the VAT
 * Executive Regulations requires sequential numbering, and an auditor reads a
 * gap as a suppressed sale. The unique index on `order_id` is what makes "one
 * invoice per order" a database fact rather than an application intention — a
 * retried request, a double-clicked download, and two concurrent workers all
 * converge on the same row instead of burning a second number.
 *
 * **The document is frozen, not re-derived.** `document` holds the fully
 * resolved invoice as it was issued: the supplier's TRN and legal name at that
 * moment, the recipient's details, every line with its own VAT split. Orders
 * already snapshot prices, but the *supplier* side is on the tenant row and a
 * merchant who corrects their trade licence next year must not thereby alter a
 * document a customer has already filed with their own accountant. This is the
 * same reasoning as the frozen subject/body on `notifications`, and for a
 * document with legal weight it matters more.
 */
export const invoiceKind = pgEnum('invoice_kind', ['tax', 'simplified']);

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),

    /**
     * 'tax'        — a full tax invoice. Legally required for B2B and for any
     *                supply above AED 10,000, and it carries the words "Tax
     *                Invoice".
     * 'simplified' — permitted for B2C below that threshold. It must NOT call
     *                itself a tax invoice; saying so when it is not one is the
     *                failure this column exists to make impossible to fake.
     */
    kind: invoiceKind('kind').notNull(),

    /** Gapless, per tenant, allocated through `counters`. e.g. INV-2026-000184. */
    number: varchar('number', { length: 32 }).notNull(),

    /**
     * Date of issue and date of supply are separate fields on a compliant
     * invoice and are frequently different — goods supplied on the 30th and
     * invoiced on the 2nd fall in different tax periods.
     */
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    suppliedAt: timestamp('supplied_at', { withTimezone: true, mode: 'date' }),

    /** Denormalised for reporting; the authoritative copy is inside `document`. */
    currency: varchar('currency', { length: 3 }).notNull().default('AED'),
    netTotal: money('net_total').notNull(),
    vatTotal: money('vat_total').notNull(),
    grossTotal: money('gross_total').notNull(),

    /** The recipient's TRN, when this is a B2B supply. Null on a B2C invoice. */
    recipientTrn: varchar('recipient_trn', { length: 20 }),

    /** The frozen document. Shape: `TaxDocument` in @voltix/invoicing. */
    document: jsonb('document').notNull(),

    /**
     * Credit notes reference the invoice they reverse. Not issued yet — the
     * column exists so that when refunds start producing one, the link is
     * already modelled rather than bolted on beside a live numbering sequence.
     */
    creditNoteFor: uuid('credit_note_for'),
    voidedAt: timestamp('voided_at', { withTimezone: true, mode: 'date' }),
    voidReason: text('void_reason'),

    ...timestamps(),
  },
  (t) => [
    // One invoice per order, enforced by the database. See the note above.
    uniqueIndex('invoices_order_key').on(t.orderId),
    uniqueIndex('invoices_tenant_number_key').on(t.tenantId, t.number),
    index('invoices_tenant_issued_idx').on(t.tenantId, t.issuedAt),
  ],
);
