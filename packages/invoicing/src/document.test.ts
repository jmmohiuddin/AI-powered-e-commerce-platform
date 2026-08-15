import { describe, expect, it } from 'vitest';
import { TAX_INVOICE_REQUIRED_FIELDS } from '@voltix/core';
import {
  buildTaxDocument,
  documentHeading,
  InvoiceError,
  isMoneyConsistent,
  missingRequiredFields,
  type BuildInvoiceInput,
} from './document';
import { renderInvoiceHtml } from './render-html';

/**
 * These are compliance tests, not formatting tests.
 *
 * Each one corresponds to a way the document can be wrong in a manner a tax
 * authority or a business customer's accountant would reject: a missing legal
 * field, a VAT column that does not add up, a simplified receipt calling itself
 * a tax invoice, or a B2B supply issued without the buyer's TRN.
 */

const SUPPLIER = {
  legalName: 'Semul Miah Electronics Trading L.L.C',
  address: 'Shop 12, Naif, Deira\nDubai',
  trn: '100234567800003',
  tradeLicence: 'CN-1234567',
};

function input(overrides: Partial<BuildInvoiceInput> = {}): BuildInvoiceInput {
  return {
    number: 'INV-2026-000184',
    orderNumber: '10042',
    issuedAt: new Date('2026-08-12T10:34:00Z'),
    suppliedAt: new Date('2026-08-11T18:00:00Z'),
    currency: 'AED',
    supplier: SUPPLIER,
    recipient: { name: 'Aisha Al Mansoori', address: 'Dubai Marina\nDubai' },
    lines: [
      {
        title: 'iPhone 15 Pro',
        variantTitle: '256GB Natural Titanium',
        sku: 'IP15P-256-NT',
        quantity: 1,
        unitPrice: 419_900,
        lineTotal: 419_900,
        taxTotal: 19_995,
      },
    ],
    discountTotal: 0,
    shippingTotal: 0,
    grossTotal: 419_900,
    vatRateBps: 500,
    paymentMethod: 'Cash on delivery',
    paidTotal: 0,
    ...overrides,
  };
}

describe('which document the law requires', () => {
  it('issues a simplified invoice for a small consumer sale', () => {
    const doc = buildTaxDocument(input());
    expect(doc.kind).toBe('simplified');
  });

  it('issues a full tax invoice above the AED 10,000 threshold', () => {
    // The threshold is exclusive: exactly 10,000 is still a consumer sale.
    expect(buildTaxDocument(input({ grossTotal: 1_000_000, lines: [line(1_000_000)] })).kind).toBe(
      'simplified',
    );
    expect(buildTaxDocument(input({ grossTotal: 1_000_100, lines: [line(1_000_100)] })).kind).toBe(
      'tax',
    );
  });

  it('issues a full tax invoice at any value once the buyer gives a TRN', () => {
    const doc = buildTaxDocument(
      input({ recipient: { name: 'Al Noor Trading LLC', trn: '100987654300003' } }),
    );
    expect(doc.kind).toBe('tax');
    expect(doc.recipient.trn).toBe('100987654300003');
  });
});

describe('a document never claims to be what it is not', () => {
  it('never labels a simplified invoice as a tax invoice', () => {
    const doc = buildTaxDocument(input());
    expect(doc.kind).toBe('simplified');

    const html = renderInvoiceHtml(doc);
    // The FTA's own term for the short form. It must be visibly qualified, and
    // the bare words "Tax Invoice" must not appear as the document's claim.
    expect(html).toContain('Simplified Tax Invoice');
    expect(html).toContain('فاتورة ضريبية مبسطة');
    expect(html).not.toMatch(/>Tax Invoice</);
    expect(documentHeading('simplified').en).toBe('Simplified Tax Invoice');
  });

  it('gives the caller no way to declare the kind itself', () => {
    // The regression guard for the principle. `kind` is computed from the facts
    // inside buildTaxDocument; a caller that tries to assert it is ignored, so
    // no fixture, test or future refactor can put "Tax Invoice" on a document
    // that has not earned the words.
    const forged = buildTaxDocument({ ...input(), kind: 'tax' } as BuildInvoiceInput);
    expect(forged.kind).toBe('simplified');
  });
});

describe('the legally required field set', () => {
  it('is complete on a document that was built successfully', () => {
    const doc = buildTaxDocument(
      input({ recipient: { name: 'Al Noor Trading LLC', trn: '100987654300003' } }),
    );
    expect(missingRequiredFields(doc)).toEqual([]);

    // Every field Art. 59 names is actually present in the rendered document.
    const html = renderInvoiceHtml(doc);
    expect(html).toContain(SUPPLIER.legalName);
    expect(html).toContain('Naif, Deira');
    expect(html).toContain('100 234 567 800 003'); // supplier TRN, grouped
    expect(html).toContain('100 987 654 300 003'); // recipient TRN
    expect(html).toContain('INV-2026-000184');
    expect(html).toContain('12 Aug 2026'); // date of issue
    expect(html).toContain('11 Aug 2026'); // date of supply, a different day
    expect(html).toContain('iPhone 15 Pro');
    expect(html).toContain('5%'); // per-line VAT rate
    expect(html).toContain('Total excluding VAT');
    expect(html).toContain('Total payable');
    // The checklist in @voltix/core is the source of truth for what is
    // required; this asserts the two have not drifted apart.
    expect(TAX_INVOICE_REQUIRED_FIELDS.length).toBeGreaterThan(0);
    for (const field of TAX_INVOICE_REQUIRED_FIELDS) {
      expect(missingRequiredFields(doc)).not.toContain(field);
    }
  });

  it('refuses to render a document that has lost a required field', () => {
    const doc = buildTaxDocument(input());
    const damaged = { ...doc, supplier: { ...doc.supplier, trn: '' } };
    expect(missingRequiredFields(damaged)).toContain('supplierTrn');
    expect(() => renderInvoiceHtml(damaged)).toThrow(/missing required fields/);
  });
});

describe('a merchant who cannot legally invoice gets an error, not a document', () => {
  it('refuses without a supplier TRN', () => {
    expect(() => buildTaxDocument(input({ supplier: { ...SUPPLIER, trn: null } }))).toThrow(
      InvoiceError,
    );
  });

  it('refuses without a supplier address, which Art. 59 requires', () => {
    expect(() => buildTaxDocument(input({ supplier: { ...SUPPLIER, address: '  ' } }))).toThrow(
      /address/,
    );
  });

  it('refuses a malformed TRN rather than quietly dropping it', () => {
    // Dropping a bad buyer TRN downgrades the document to simplified, and the
    // business customer only finds out when they cannot reclaim the VAT.
    expect(() =>
      buildTaxDocument(input({ recipient: { name: 'Al Noor', trn: '12345' } })),
    ).toThrow(/recipient TRN/i);
    expect(() => buildTaxDocument(input({ supplier: { ...SUPPLIER, trn: '99' } }))).toThrow(
      /supplier TRN/i,
    );
  });
});

describe('the money on the document', () => {
  it('splits VAT out of the inclusive price and adds back exactly', () => {
    const doc = buildTaxDocument(input());
    expect(doc.grossTotal).toBe(419_900);
    expect(doc.vatTotal).toBe(19_995);
    expect(doc.netTotal).toBe(399_905);
    expect(doc.netTotal + doc.vatTotal).toBe(doc.grossTotal);
    expect(isMoneyConsistent(doc)).toBe(true);
  });

  it('totals VAT from the lines rather than re-extracting from the total', () => {
    // Three lines that each round; extracting once from the sum lands a fils
    // away from the sum of the lines, and an invoice whose VAT column does not
    // add up to its VAT total is the first thing an auditor queries.
    const lines = [line(33_333), line(33_333), line(33_334)];
    const doc = buildTaxDocument(input({ lines, grossTotal: 100_000, discountTotal: 0 }));

    const summed = doc.lines.reduce((sum, l) => sum + l.lineVat, 0);
    expect(doc.vatTotal).toBe(summed);
    // And the two genuinely differ here, so the test is not vacuous: extracting
    // once from 100,000 gives 4,762 while the three lines sum to 4,763.
    expect(Math.round((100_000 * 500) / 10_500)).not.toBe(summed);
  });

  it('uses the snapshotted per-line tax rather than recomputing it', () => {
    // The snapshot is what was actually charged. A later VAT-rate change must
    // not silently restate an old invoice.
    const doc = buildTaxDocument(
      input({ lines: [{ ...line(419_900), taxTotal: 12_345 }], grossTotal: 419_900 }),
    );
    expect(doc.lines[0]!.lineVat).toBe(12_345);
    expect(doc.lines[0]!.lineNet).toBe(419_900 - 12_345);
  });

  it('splits VAT out of the delivery charge too', () => {
    const doc = buildTaxDocument(
      input({ shippingTotal: 2_500, grossTotal: 422_400, discountTotal: 0 }),
    );
    expect(doc.shippingVat).toBe(119);
    expect(doc.vatTotal).toBe(19_995 + 119);
    expect(isMoneyConsistent(doc)).toBe(true);
  });

  it('reports what is still owed on a cash-on-delivery order', () => {
    const unpaid = buildTaxDocument(input({ paidTotal: 0 }));
    expect(unpaid.paid).toBe(false);
    expect(unpaid.amountDue).toBe(419_900);
    expect(renderInvoiceHtml(unpaid)).toContain('Amount due');

    const paid = buildTaxDocument(input({ paidTotal: 419_900 }));
    expect(paid.paid).toBe(true);
    expect(paid.amountDue).toBe(0);
  });
});

describe('bilingual rendering', () => {
  it('carries Arabic on the lines with legal weight', () => {
    const html = renderInvoiceHtml(
      buildTaxDocument(input({ recipient: { name: 'Al Noor Trading LLC', trn: '100987654300003' } })),
    );
    for (const arabic of [
      'فاتورة ضريبية',
      'الرقم الضريبي',
      'المورّد',
      'المستلم',
      'رقم الفاتورة',
      'تاريخ الإصدار',
      'تاريخ التوريد',
      'المجموع بدون ضريبة',
      'ضريبة القيمة المضافة',
      'المجموع المستحق',
    ]) {
      expect(html, arabic).toContain(arabic);
    }
  });

  it('uses Western digits everywhere and isolates identifiers from Arabic', () => {
    const html = renderInvoiceHtml(
      buildTaxDocument(input({ recipient: { name: 'Al Noor', trn: '100987654300003' } })),
    );
    expect(html).not.toMatch(/[٠-٩]/); // no Arabic-Indic digits
    expect(html).toContain('AED 4,199.00'); // two decimals always, unlike the storefront
    // The TRN sits next to Arabic text, so it is bidi-isolated.
    expect(html).toContain('⁦100 234 567 800 003⁩');
  });

  it('escapes a product title that contains markup', () => {
    const doc = buildTaxDocument(
      input({ lines: [{ ...line(419_900), title: '<script>alert(1)</script>' }] }),
    );
    const html = renderInvoiceHtml(doc);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('is self-contained — no scripts and no external requests', () => {
    const html = renderInvoiceHtml(buildTaxDocument(input()));
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/(src|href)=["']https?:/);
    expect(html).toContain('@page');
  });
});

function line(lineTotal: number) {
  return {
    title: 'Test item',
    variantTitle: null,
    sku: 'SKU-1',
    quantity: 1,
    unitPrice: lineTotal,
    lineTotal,
    taxTotal: null,
  };
}
