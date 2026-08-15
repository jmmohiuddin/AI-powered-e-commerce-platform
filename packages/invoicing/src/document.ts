import {
  extractVat,
  isValidTrn,
  money,
  requiredInvoiceKind,
  UAE_VAT_RATE_BPS,
  type Money,
} from '@voltix/core';

/**
 * THE TAX DOCUMENT
 *
 * One resolved object that the PDF, the printed receipt and the emailed copy
 * all render from, so the three cannot drift apart. That is a design principle
 * here rather than a convenience: three templates that each re-derive the VAT
 * split are three chances to state a different tax figure for the same sale,
 * and only one of them can be right.
 *
 * Everything is resolved before it arrives — the emirate as a name, the money
 * as integers in fils, the dates as instants. No lookups, no live catalogue
 * reads. An invoice must render identically in five years' time, after the
 * product has been renamed and the merchant has changed their trade licence,
 * which is why the whole object is frozen into `invoices.document` at issue.
 */

export type InvoiceKind = 'tax' | 'simplified';

export interface InvoiceSupplier {
  readonly legalName: string;
  readonly address: string;
  readonly trn: string;
  readonly tradeLicence?: string | null;
}

export interface InvoiceRecipient {
  readonly name: string;
  readonly address?: string | null;
  /** Present only on a B2B supply; its presence is what makes it one. */
  readonly trn?: string | null;
}

export interface InvoiceLine {
  readonly description: string;
  readonly sku: string;
  readonly quantity: number;
  /** VAT-inclusive unit price, in minor units. What the customer saw. */
  readonly unitPriceGross: number;
  readonly lineGross: number;
  readonly lineNet: number;
  readonly lineVat: number;
  readonly vatRateBps: number;
}

export interface TaxDocument {
  readonly kind: InvoiceKind;
  readonly number: string;
  readonly orderNumber: string;
  /** ISO instants. Date of issue and date of supply are separate requirements. */
  readonly issuedAt: string;
  readonly suppliedAt: string;
  readonly currency: string;
  readonly supplier: InvoiceSupplier;
  readonly recipient: InvoiceRecipient;
  readonly lines: readonly InvoiceLine[];
  /** Order-level discount, VAT-inclusive, as a positive number. */
  readonly discountTotal: number;
  readonly shippingGross: number;
  readonly shippingVat: number;
  readonly netTotal: number;
  readonly vatTotal: number;
  readonly grossTotal: number;
  readonly vatRateBps: number;
  readonly paymentMethod: string;
  readonly paid: boolean;
  readonly amountDue: number;
}

/** Thrown when the facts do not permit issuing a document at all. */
export class InvoiceError extends Error {
  constructor(
    message: string,
    readonly code: 'SUPPLIER_INCOMPLETE' | 'RECIPIENT_INCOMPLETE' | 'NOT_INVOICEABLE',
  ) {
    super(message);
    this.name = 'InvoiceError';
  }
}

export interface BuildInvoiceInput {
  readonly number: string;
  readonly orderNumber: string;
  readonly issuedAt: Date;
  /** When the goods were supplied. Falls back to the issue date. */
  readonly suppliedAt?: Date | null;
  readonly currency: string;
  readonly supplier: {
    readonly legalName?: string | null;
    readonly address?: string | null;
    readonly trn?: string | null;
    readonly tradeLicence?: string | null;
  };
  readonly recipient: {
    readonly name?: string | null;
    readonly address?: string | null;
    readonly trn?: string | null;
  };
  readonly lines: readonly {
    readonly title: string;
    readonly variantTitle?: string | null;
    readonly sku: string;
    readonly quantity: number;
    readonly unitPrice: number;
    readonly lineTotal: number;
    /** Per-line VAT as snapshotted at checkout. Recomputed when absent. */
    readonly taxTotal?: number | null;
  }[];
  readonly discountTotal: number;
  readonly shippingTotal: number;
  readonly grossTotal: number;
  readonly vatRateBps?: number;
  readonly paymentMethod: string;
  readonly paidTotal: number;
}

/**
 * Builds the document, and decides for itself what kind of document it is.
 *
 * **`kind` is not a parameter.** It is computed from the facts by
 * `requiredInvoiceKind`, because the project principle is that a document never
 * calls itself a tax invoice unless it legally is one — and a `kind` argument
 * is precisely the hole through which a caller, a test fixture or a future
 * refactor puts those words on a document that has not earned them. The
 * renderer takes its heading from `kind` and has no other way to produce them.
 *
 * The supplier check throws rather than degrading. A merchant with no TRN on
 * file cannot issue any VAT document — not a full one and not a simplified
 * one, both of which require the supplier's name, address and TRN under Art.
 * 59. Rendering something invoice-shaped without them would hand the customer
 * a document their accountant must reject, which is worse than a clear failure
 * telling the merchant to complete their tax settings.
 */
export function buildTaxDocument(input: BuildInvoiceInput): TaxDocument {
  const supplierTrn = (input.supplier.trn ?? '').trim();
  if (!input.supplier.legalName?.trim() || !input.supplier.address?.trim() || !supplierTrn) {
    throw new InvoiceError(
      'Cannot issue a VAT document without the supplier legal name, address and TRN',
      'SUPPLIER_INCOMPLETE',
    );
  }
  if (!isValidTrn(supplierTrn)) {
    throw new InvoiceError('The supplier TRN is not a 15-digit number', 'SUPPLIER_INCOMPLETE');
  }

  const vatRateBps = input.vatRateBps ?? UAE_VAT_RATE_BPS;
  const currency = input.currency;
  const recipientTrn = input.recipient.trn?.trim() || null;

  // A malformed buyer TRN is refused rather than silently dropped: dropping it
  // downgrades the document to simplified and the business customer discovers
  // at their own filing that they cannot reclaim the VAT.
  if (recipientTrn && !isValidTrn(recipientTrn)) {
    throw new InvoiceError('The recipient TRN is not a 15-digit number', 'RECIPIENT_INCOMPLETE');
  }

  const kind = requiredInvoiceKind({
    grossTotal: money(input.grossTotal, currency),
    recipientTrn,
  });

  const lines = input.lines.map((line) => {
    const lineGross = line.lineTotal;
    // The snapshot is authoritative where it exists — it is what was charged.
    // Recomputing is the fallback for older rows, and it must not silently
    // disagree with the order total, which is why it uses the same extraction
    // the pricing engine used rather than a second formula.
    const lineVat =
      line.taxTotal != null && line.taxTotal > 0
        ? line.taxTotal
        : extractVat(money(lineGross, currency), vatRateBps).amount;

    return {
      description: [line.title, line.variantTitle].filter(Boolean).join(' — '),
      sku: line.sku,
      quantity: line.quantity,
      unitPriceGross: line.unitPrice,
      lineGross,
      lineNet: lineGross - lineVat,
      lineVat,
      vatRateBps,
    } satisfies InvoiceLine;
  });

  const shippingVat =
    input.shippingTotal > 0 ? extractVat(money(input.shippingTotal, currency), vatRateBps).amount : 0;

  // The VAT total is the sum of the parts, not a fresh extraction from the
  // order total. Extracting again would round once more and can land a fils
  // away from the sum of the lines — and a tax invoice whose VAT column does
  // not add up to its VAT total is the first thing an auditor notices.
  const vatTotal = lines.reduce((sum, l) => sum + l.lineVat, 0) + shippingVat;
  const netTotal = input.grossTotal - vatTotal;

  return {
    kind,
    number: input.number,
    orderNumber: input.orderNumber,
    issuedAt: input.issuedAt.toISOString(),
    suppliedAt: (input.suppliedAt ?? input.issuedAt).toISOString(),
    currency,
    supplier: {
      legalName: input.supplier.legalName.trim(),
      address: input.supplier.address.trim(),
      trn: supplierTrn,
      tradeLicence: input.supplier.tradeLicence ?? null,
    },
    recipient: {
      name: input.recipient.name?.trim() || 'Customer',
      address: input.recipient.address ?? null,
      trn: recipientTrn,
    },
    lines,
    discountTotal: input.discountTotal,
    shippingGross: input.shippingTotal,
    shippingVat,
    netTotal,
    vatTotal,
    grossTotal: input.grossTotal,
    vatRateBps,
    paymentMethod: input.paymentMethod,
    paid: input.paidTotal >= input.grossTotal,
    amountDue: Math.max(input.grossTotal - input.paidTotal, 0),
  };
}

/**
 * Re-checks a document against the legal field list before it is rendered.
 *
 * `buildTaxDocument` already refuses to construct an incomplete one, so this is
 * the second fence — it also guards documents read back out of
 * `invoices.document`, which were written by whatever version of the code was
 * deployed when they were issued. A field list that grows later should surface
 * old documents that no longer satisfy it, not render them silently.
 */
export function missingRequiredFields(doc: TaxDocument): string[] {
  const missing: string[] = [];
  if (!doc.supplier.legalName) missing.push('supplierName');
  if (!doc.supplier.address) missing.push('supplierAddress');
  if (!doc.supplier.trn) missing.push('supplierTrn');
  if (!doc.number) missing.push('invoiceNumber');
  if (!doc.issuedAt) missing.push('invoiceDate');
  if (doc.lines.length === 0 || doc.lines.some((l) => !l.description)) {
    missing.push('lineDescription');
  }
  if (doc.lines.some((l) => l.lineNet == null)) missing.push('taxableAmount');
  if (doc.lines.some((l) => l.vatRateBps == null)) missing.push('vatRate');
  if (doc.vatTotal == null) missing.push('vatAmount');
  if (doc.grossTotal == null) missing.push('grossTotal');
  // A full tax invoice additionally names the recipient and, for B2B, carries
  // their TRN. A simplified invoice needs neither.
  if (doc.kind === 'tax') {
    if (!doc.recipient.name) missing.push('recipientName');
    if (doc.recipient.trn && !isValidTrn(doc.recipient.trn)) missing.push('recipientTrn');
  }
  return missing;
}

/**
 * The document's own heading, in both languages.
 *
 * The single place in the codebase that can produce the words "Tax Invoice".
 * A simplified document gets "Simplified Tax Invoice" — which is the FTA's own
 * term for it and is not a claim to be the full document — and nothing can
 * reach the full heading without `kind` being 'tax', which nothing can set
 * directly.
 */
export function documentHeading(kind: InvoiceKind): { en: string; ar: string } {
  return kind === 'tax'
    ? { en: 'Tax Invoice', ar: 'فاتورة ضريبية' }
    : { en: 'Simplified Tax Invoice', ar: 'فاتورة ضريبية مبسطة' };
}

export function isMoneyConsistent(doc: TaxDocument): boolean {
  const lineGross = doc.lines.reduce((sum, l) => sum + l.lineGross, 0);
  return (
    doc.netTotal + doc.vatTotal === doc.grossTotal &&
    lineGross + doc.shippingGross - doc.discountTotal === doc.grossTotal
  );
}
