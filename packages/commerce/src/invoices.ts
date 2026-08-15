import { sql } from 'drizzle-orm';
import { uuidv7 } from '@voltix/db';
import { DomainError } from '@voltix/core';
import { buildTaxDocument, InvoiceError, type TaxDocument } from '@voltix/invoicing';
import { nextNumber } from './numbering';
import type { TenantContext, Tx } from './types';

/**
 * ISSUING A TAX DOCUMENT
 *
 * The database side of invoicing: read the frozen order facts, ask
 * `@voltix/invoicing` what document they require, allocate a number, and store
 * the result. The rules with legal consequences live in that package and are
 * pure; this file only supplies facts and durability.
 *
 * ISSUED ONCE, EVER
 * An invoice number is a position in a sequence a tax authority expects to be
 * continuous, so the two ways to get this wrong are both serious: issuing two
 * numbers for one order (a duplicate the customer may claim twice) and burning
 * a number on an attempt that rolls back (a gap that reads as a suppressed
 * sale). Both are prevented the same way — the order row is locked first, so
 * issuance for a given order is serialised, and the check for an existing
 * invoice therefore cannot race the insert. The counter increment lives in the
 * caller's transaction, so a rollback takes the number back with it.
 */

interface OrderFacts extends Record<string, unknown> {
  id: string;
  number: string;
  currency: string;
  subtotal: number;
  discount_total: number;
  shipping_total: number;
  tax_total: number;
  total: number;
  paid_total: number;
  recipient_trn: string | null;
  email: string | null;
  shipping_address: Record<string, unknown> | null;
  billing_address: Record<string, unknown> | null;
  placed_at: string | Date | null;
  provider: string | null;
  legal_name: string | null;
  legal_address: string | null;
  tax_registration_number: string | null;
  trade_licence_number: string | null;
  vat_rate_bps: number;
}

/** Renders a stored UAE address object as the block that goes on the document. */
function addressLines(address: Record<string, unknown> | null): string | null {
  if (!address) return null;
  const parts = [
    address.buildingName,
    address.flatOrVilla ? `Flat/Villa ${String(address.flatOrVilla)}` : null,
    address.street,
    address.area,
    EMIRATE_NAMES[String(address.emirate ?? '')] ?? address.emirate,
    address.makani ? `Makani ${String(address.makani)}` : null,
    address.poBox ? `PO Box ${String(address.poBox)}` : null,
    'United Arab Emirates',
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  return parts.length > 0 ? parts.join('\n') : null;
}

const EMIRATE_NAMES: Record<string, string> = {
  AZ: 'Abu Dhabi',
  DU: 'Dubai',
  SH: 'Sharjah',
  AJ: 'Ajman',
  UQ: 'Umm Al Quwain',
  RK: 'Ras Al Khaimah',
  FU: 'Fujairah',
};

const PAYMENT_LABELS: Record<string, string> = {
  cod: 'Cash on delivery',
  stripe: 'Card',
  network: 'Card',
  paytabs: 'Card',
  tabby: 'Tabby (buy now, pay later)',
};

export interface IssuedInvoice {
  readonly id: string;
  readonly number: string;
  readonly kind: 'tax' | 'simplified';
  readonly document: TaxDocument;
  /** False when an invoice already existed — the caller issued nothing. */
  readonly created: boolean;
}

/**
 * Issues the invoice for an order, or returns the one already issued.
 *
 * Idempotent by design rather than by retry: calling it a hundred times
 * produces one number, one row and one document.
 */
export async function issueInvoice(
  tx: Tx,
  ctx: TenantContext,
  orderId: string,
): Promise<IssuedInvoice> {
  // Lock the order first. Everything below depends on there being exactly one
  // issuance in flight for this order at a time.
  const locked = await tx.execute<{ id: string }>(sql`
    SELECT id FROM orders WHERE tenant_id = ${ctx.tenantId} AND id = ${orderId} FOR UPDATE
  `);
  if (!locked.rows[0]) throw new DomainError('NOT_FOUND', `Order ${orderId} not found`);

  const existing = await tx.execute<{ id: string; number: string; kind: 'tax' | 'simplified'; document: TaxDocument }>(sql`
    SELECT id, number, kind, document FROM invoices
    WHERE tenant_id = ${ctx.tenantId} AND order_id = ${orderId}
  `);
  const already = existing.rows[0];
  if (already) {
    return { id: already.id, number: already.number, kind: already.kind, document: already.document, created: false };
  }

  const facts = await loadOrderFacts(tx, ctx.tenantId, orderId);
  const items = await tx.execute<{
    title: string;
    variant_title: string | null;
    sku: string;
    quantity: number;
    unit_price: number;
    line_total: number;
    tax_total: number;
  }>(sql`
    SELECT title, variant_title, sku, quantity, unit_price, line_total, tax_total
    FROM order_items WHERE tenant_id = ${ctx.tenantId} AND order_id = ${orderId}
    ORDER BY created_at
  `);

  if (items.rows.length === 0) {
    throw new DomainError('CONFLICT', 'An order with no lines cannot be invoiced', {
      publicMessage: 'This order has nothing to invoice.',
    });
  }

  const issuedAt = new Date();
  const year = issuedAt.getUTCFullYear();
  // Per-year sequences, which is what a merchant's accountant expects to see
  // and what makes a gap in one year explicable without reading every other.
  const number = await nextNumber(tx, ctx.tenantId, 'invoice', {
    period: String(year),
    prefix: `INV-${year}-`,
    pad: 6,
    start: 0,
  });

  const billing = facts.billing_address ?? facts.shipping_address;

  let document: TaxDocument;
  try {
    document = buildTaxDocument({
      number,
      orderNumber: facts.number,
      issuedAt,
      // The tax point is when the goods were supplied, which for a web order is
      // when it was placed — not when someone got round to downloading it.
      // Coerced explicitly: `tx.execute` returns raw driver values, so a
      // timestamptz arrives as a string however the column is declared.
      suppliedAt: facts.placed_at ? new Date(facts.placed_at) : issuedAt,
      currency: facts.currency,
      supplier: {
        legalName: facts.legal_name,
        address: facts.legal_address,
        trn: facts.tax_registration_number,
        tradeLicence: facts.trade_licence_number,
      },
      recipient: {
        name: (billing?.recipientName as string) ?? null,
        address: addressLines(billing),
        trn: facts.recipient_trn,
      },
      lines: items.rows.map((item) => ({
        title: item.title,
        variantTitle: item.variant_title,
        sku: item.sku,
        quantity: Number(item.quantity),
        unitPrice: Number(item.unit_price),
        lineTotal: Number(item.line_total),
        taxTotal: Number(item.tax_total),
      })),
      discountTotal: Number(facts.discount_total),
      shippingTotal: Number(facts.shipping_total),
      grossTotal: Number(facts.total),
      vatRateBps: Number(facts.vat_rate_bps),
      paymentMethod: PAYMENT_LABELS[facts.provider ?? ''] ?? facts.provider ?? 'Unknown',
      paidTotal: Number(facts.paid_total),
    });
  } catch (error) {
    // A merchant who has not filled in their tax identity gets a clear,
    // actionable failure. Rendering an invoice-shaped document without a TRN
    // would hand the customer paper their accountant has to reject.
    if (error instanceof InvoiceError) {
      throw new DomainError('CONFLICT', error.message, {
        publicMessage:
          error.code === 'SUPPLIER_INCOMPLETE'
            ? 'This store has not finished its tax settings, so an invoice cannot be issued yet.'
            : 'The tax registration number on this order is not valid.',
      });
    }
    throw error;
  }

  const id = uuidv7();
  await tx.execute(sql`
    INSERT INTO invoices
      (id, tenant_id, order_id, kind, number, issued_at, supplied_at, currency,
       net_total, vat_total, gross_total, recipient_trn, document, created_at, updated_at)
    VALUES (
      ${id}, ${ctx.tenantId}, ${orderId}, ${document.kind}, ${number}, ${issuedAt},
      ${document.suppliedAt}, ${document.currency}, ${document.netTotal}, ${document.vatTotal},
      ${document.grossTotal}, ${document.recipient.trn}, ${JSON.stringify(document)}::jsonb,
      now(), now()
    )
  `);

  return { id, number, kind: document.kind, document, created: true };
}

/**
 * Reads the invoice for an order without issuing one.
 *
 * The read path for a customer downloading their copy a second time. It must
 * not issue: a GET that allocates a number means a crawler following links
 * consumes the merchant's invoice sequence.
 */
export async function getInvoiceForOrder(
  tx: Tx,
  ctx: TenantContext,
  orderId: string,
): Promise<IssuedInvoice | null> {
  const rows = await tx.execute<{ id: string; number: string; kind: 'tax' | 'simplified'; document: TaxDocument }>(sql`
    SELECT id, number, kind, document FROM invoices
    WHERE tenant_id = ${ctx.tenantId} AND order_id = ${orderId}
  `);
  const row = rows.rows[0];
  return row ? { id: row.id, number: row.number, kind: row.kind, document: row.document, created: false } : null;
}

async function loadOrderFacts(tx: Tx, tenantId: string, orderId: string): Promise<OrderFacts> {
  const rows = await tx.execute<OrderFacts>(sql`
    SELECT o.id, o.number, o.currency, o.subtotal, o.discount_total, o.shipping_total,
           o.tax_total, o.total, o.paid_total, o.recipient_trn, o.email,
           o.shipping_address, o.billing_address, o.placed_at,
           pi.provider,
           t.legal_name, t.legal_address, t.tax_registration_number,
           t.trade_licence_number, t.vat_rate_bps
    FROM orders o
    JOIN tenants t ON t.id = o.tenant_id
    LEFT JOIN LATERAL (
      SELECT provider FROM payment_intents
      WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1
    ) pi ON true
    WHERE o.tenant_id = ${tenantId} AND o.id = ${orderId}
  `);
  const row = rows.rows[0];
  if (!row) throw new DomainError('NOT_FOUND', `Order ${orderId} not found`);
  return row;
}
