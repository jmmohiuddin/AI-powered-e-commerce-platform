import { formatTrn } from '@voltix/core';
import { documentHeading, missingRequiredFields, type TaxDocument } from './document';

/**
 * THE PRINTABLE INVOICE
 *
 * Rendered as self-contained, print-ready HTML rather than a generated PDF
 * binary, and the reason is Arabic.
 *
 * A tax invoice here must carry Arabic on the lines with legal weight. Writing
 * a PDF by hand is easy for Latin text — the base-14 fonts are built into every
 * reader — but Arabic needs an embedded font, contextual glyph shaping (each
 * letter has up to four forms depending on its neighbours) and bidirectional
 * reordering. No dependency-light PDF library does shaping; the ones that
 * embed fonts, `pdf-lib` included, lay Arabic out as isolated letters in
 * reversed order. That is not a cosmetic defect on a legal document.
 *
 * A browser already contains a complete text engine that does all three
 * correctly, and every browser prints to PDF. So the document is HTML with a
 * print stylesheet: correct Arabic, no dependencies, no binary format to get
 * subtly wrong, and it renders in any runtime including a serverless function.
 * The trade-off is that producing the PDF file is one keystroke on the reader's
 * side rather than a direct download.
 *
 * No JavaScript and no external requests — a document that needs the network to
 * render is a document that will one day render blank.
 */

const LRI = '⁦';
const PDI = '⁩';

/**
 * Isolates a Latin run inside Arabic copy.
 *
 * Without it the bidirectional algorithm resolves the neutral characters around
 * an identifier to the surrounding direction and "INV-2026-000184" renders with
 * its parts rearranged. On an invoice the reader quotes back to their
 * accountant, that is not a cosmetic problem.
 */
const ltr = (value: string): string => `${LRI}${value}${PDI}`;

/**
 * Money, always with both decimal places and always in Western digits.
 *
 * Two deliberate departures from the storefront's `formatPrice`. It hides a
 * `.00`, which is right in a product grid and wrong in a column an accountant
 * adds up; and the numbering system is pinned so an Arabic locale tag cannot
 * turn the VAT figure into Arabic-Indic digits, per the project decision.
 */
function amount(minorUnits: number, currency: string): string {
  const value = minorUnits / 100;
  return `${currency} ${new Intl.NumberFormat('en-AE-u-nu-latn', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)}`;
}

/** `12 Aug 2026`. Fixed to the UAE, because the tax point is a UAE date. */
function date(iso: string): string {
  return new Intl.DateTimeFormat('en-AE-u-nu-latn', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Dubai',
  }).format(new Date(iso));
}

function percent(bps: number): string {
  return `${bps / 100}%`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A label that carries legal weight, in both languages. */
function bilingual(en: string, ar: string): string {
  return `${escapeHtml(en)} <span class="ar">${escapeHtml(ar)}</span>`;
}

export interface RenderOptions {
  /** Shown in the footer. Never part of the legal content. */
  readonly storeUrl?: string | null;
}

/**
 * Renders the document.
 *
 * Refuses rather than degrades if a legally required field is missing. A
 * document that is invoice-shaped but incomplete is worse than an error,
 * because the customer files it and discovers the problem at their own audit.
 */
export function renderInvoiceHtml(doc: TaxDocument, options: RenderOptions = {}): string {
  const missing = missingRequiredFields(doc);
  if (missing.length > 0) {
    throw new Error(`Invoice ${doc.number} is missing required fields: ${missing.join(', ')}`);
  }

  const heading = documentHeading(doc.kind);
  const cur = doc.currency;

  const lines = doc.lines
    .map(
      (line) => `
        <tr>
          <td>
            <div class="line-title">${escapeHtml(line.description)}</div>
            <div class="line-sku">SKU ${escapeHtml(line.sku)}</div>
          </td>
          <td class="num">${line.quantity}</td>
          <td class="num">${amount(line.unitPriceGross, cur)}</td>
          <td class="num">${amount(line.lineNet, cur)}</td>
          <td class="num">${percent(line.vatRateBps)}</td>
          <td class="num">${amount(line.lineVat, cur)}</td>
          <td class="num">${amount(line.lineGross, cur)}</td>
        </tr>`,
    )
    .join('');

  const recipientTrn = doc.recipient.trn
    ? `<div class="trn">${bilingual('TRN', 'الرقم الضريبي')} ${ltr(formatTrn(doc.recipient.trn))}</div>`
    : '';

  const discountRow =
    doc.discountTotal > 0
      ? `<tr><th>Discount</th><td class="num">−${amount(doc.discountTotal, cur)}</td></tr>`
      : '';

  const shippingRow =
    doc.shippingGross > 0
      ? `<tr><th>Delivery (incl. VAT)</th><td class="num">${amount(doc.shippingGross, cur)}</td></tr>`
      : '';

  const dueRow =
    doc.amountDue > 0
      ? `<tr class="due"><th>${bilingual('Amount due', 'المبلغ المستحق')}</th><td class="num">${amount(
          doc.amountDue,
          cur,
        )}</td></tr>`
      : '';

  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading.en)} ${escapeHtml(doc.number)}</title>
<style>
  /* A4 with a printer-safe margin. The document is designed for paper first —
     it is filed, posted and audited on paper more often than it is read on a
     screen. */
  @page { size: A4; margin: 14mm; }

  :root {
    --ink: #14161a;
    --muted: #5b6472;
    --rule: #d7dbe2;
    --accent: #1f52e0;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    background: #f4f5f7;
    color: var(--ink);
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    /* Columns of figures that do not jitter or misalign between rows. */
    font-variant-numeric: tabular-nums;
  }
  .sheet {
    max-width: 794px; /* A4 at 96dpi */
    margin: 0 auto;
    background: #fff;
    padding: 32px 36px;
    border-radius: 6px;
  }

  /* Arabic sits beside its English label rather than in a mirrored column: the
     document is bilingual only on the lines that carry legal weight, and a
     second full layout would double the ways the two can disagree. */
  .ar {
    font-size: 0.92em;
    color: var(--muted);
    unicode-bidi: isolate;
    direction: rtl;
  }

  header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
  .brand { font-size: 18px; font-weight: 700; }
  .brand span { color: var(--accent); }

  h1 { font-size: 20px; margin: 0 0 2px; letter-spacing: 0.01em; }
  .doc-meta { text-align: right; }
  .doc-meta dl { margin: 8px 0 0; display: grid; grid-template-columns: auto auto; gap: 2px 12px; }
  .doc-meta dt { color: var(--muted); }
  .doc-meta dd { margin: 0; font-weight: 600; }

  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 24px 0; }
  .party h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 6px; }
  .party .name { font-weight: 600; }
  .party address { font-style: normal; color: var(--muted); white-space: pre-line; }
  .trn { margin-top: 6px; font-weight: 600; }

  table.lines { width: 100%; border-collapse: collapse; margin-top: 8px; }
  table.lines th, table.lines td { padding: 8px 6px; border-bottom: 1px solid var(--rule); vertical-align: top; }
  table.lines thead th {
    text-align: left; font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.04em; color: var(--muted); border-bottom: 2px solid var(--ink);
  }
  .num { text-align: right; white-space: nowrap; }
  .line-title { font-weight: 500; }
  .line-sku { color: var(--muted); font-size: 11px; }

  .totals { margin-top: 16px; margin-inline-start: auto; width: min(340px, 100%); border-collapse: collapse; }
  .totals th { text-align: left; font-weight: 400; color: var(--muted); padding: 5px 6px; }
  .totals td { padding: 5px 6px; }
  .totals tr.grand th, .totals tr.grand td {
    border-top: 2px solid var(--ink); font-weight: 700; font-size: 15px; color: var(--ink); padding-top: 9px;
  }
  .totals tr.due th, .totals tr.due td { font-weight: 700; }

  footer { margin-top: 28px; padding-top: 12px; border-top: 1px solid var(--rule); color: var(--muted); font-size: 11px; }

  @media print {
    body { background: #fff; padding: 0; }
    .sheet { max-width: none; padding: 0; border-radius: 0; }
    /* A line item must never be split across a page break — half a line on each
       page reads as two different quantities. */
    table.lines tr { break-inside: avoid; }
    thead { display: table-header-group; }
  }
</style>
</head>
<body>
  <div class="sheet">
    <header>
      <div>
        <div class="brand">volt<span>ix</span></div>
        <h1>${bilingual(heading.en, heading.ar)}</h1>
      </div>
      <div class="doc-meta">
        <dl>
          <dt>${bilingual('Invoice no.', 'رقم الفاتورة')}</dt>
          <dd>${escapeHtml(doc.number)}</dd>
          <dt>${bilingual('Date of issue', 'تاريخ الإصدار')}</dt>
          <dd>${date(doc.issuedAt)}</dd>
          <dt>${bilingual('Date of supply', 'تاريخ التوريد')}</dt>
          <dd>${date(doc.suppliedAt)}</dd>
          <dt>Order</dt>
          <dd>#${escapeHtml(doc.orderNumber)}</dd>
        </dl>
      </div>
    </header>

    <div class="parties">
      <section class="party">
        <h2>${bilingual('Supplier', 'المورّد')}</h2>
        <div class="name">${escapeHtml(doc.supplier.legalName)}</div>
        <address>${escapeHtml(doc.supplier.address)}</address>
        <div class="trn">${bilingual('TRN', 'الرقم الضريبي')} ${ltr(formatTrn(doc.supplier.trn))}</div>
        ${
          doc.supplier.tradeLicence
            ? `<div class="line-sku">Trade licence ${escapeHtml(doc.supplier.tradeLicence)}</div>`
            : ''
        }
      </section>
      <section class="party">
        <h2>${bilingual('Recipient', 'المستلم')}</h2>
        <div class="name">${escapeHtml(doc.recipient.name)}</div>
        ${doc.recipient.address ? `<address>${escapeHtml(doc.recipient.address)}</address>` : ''}
        ${recipientTrn}
      </section>
    </div>

    <table class="lines">
      <thead>
        <tr>
          <th>Description</th>
          <th class="num">Qty</th>
          <th class="num">Unit price</th>
          <th class="num">Taxable amount</th>
          <th class="num">VAT rate</th>
          <th class="num">VAT amount</th>
          <th class="num">Total</th>
        </tr>
      </thead>
      <tbody>${lines}
      </tbody>
    </table>

    <table class="totals">
      ${discountRow}
      ${shippingRow}
      <tr><th>${bilingual('Total excluding VAT', 'المجموع بدون ضريبة')}</th><td class="num">${amount(
        doc.netTotal,
        cur,
      )}</td></tr>
      <tr><th>${bilingual(`VAT ${percent(doc.vatRateBps)}`, 'ضريبة القيمة المضافة')}</th><td class="num">${amount(
        doc.vatTotal,
        cur,
      )}</td></tr>
      <tr class="grand"><th>${bilingual('Total payable', 'المجموع المستحق')}</th><td class="num">${amount(
        doc.grossTotal,
        cur,
      )}</td></tr>
      <tr><th>Payment method</th><td class="num">${escapeHtml(doc.paymentMethod)}</td></tr>
      ${dueRow}
    </table>

    <footer>
      <p>All amounts are in ${escapeHtml(cur)} and include VAT at ${percent(
        doc.vatRateBps,
      )} where applicable. This document is issued electronically and is valid without a signature.</p>
      ${options.storeUrl ? `<p>${escapeHtml(options.storeUrl)}</p>` : ''}
    </footer>
  </div>
</body>
</html>`;
}
