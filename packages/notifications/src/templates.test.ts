import { describe, expect, it } from 'vitest';
import {
  renderCartRecovery,
  renderOpsAlert,
  renderOrderConfirmation,
  type OrderConfirmationData,
} from './templates';

/**
 * Template tests assert the things that are *wrong to get wrong* — the money is
 * formatted for the locale, cash-on-delivery never reads as paid, and the
 * Arabic render is actually Arabic. They are not golden-string snapshots: the
 * exact wording is meant to change, and a test that breaks on every copy edit
 * teaches people to stop reading test failures.
 */

const base: OrderConfirmationData = {
  orderNumber: '10042',
  customerName: 'Aisha',
  total: 469900, // AED 4,699.00 in fils
  currency: 'AED',
  emirate: 'Dubai',
  deliveryDays: 1,
  payment: 'paid',
  itemCount: 2,
  trackUrl: 'https://shop.ae/orders?number=10042',
  storeName: 'Voltix',
};

/** Strips the bidi isolate marks the Arabic render adds, for readable asserts. */
const plain = (value: string): string => value.replace(/[⁦-⁩]/g, '');

describe('order confirmation', () => {
  it('formats the total in the order currency', () => {
    const r = renderOrderConfirmation({ ...base, payment: 'paid' }, 'en-AE');
    // AED with no fraction when the amount is whole thousands.
    expect(r.text).toMatch(/AED\s?4,699/);
    expect(r.subject).toBe('Order #10042 confirmed');
  });

  it('never tells a cash-on-delivery customer they have paid', () => {
    const paid = renderOrderConfirmation({ ...base, payment: 'paid' }, 'en-AE');
    const cod = renderOrderConfirmation({ ...base, payment: 'cod' }, 'en-AE');

    expect(paid.text.toLowerCase()).toContain('received your payment');
    // The COD copy must say pay-on-delivery and must NOT claim receipt.
    expect(cod.text.toLowerCase()).toContain('cash on delivery');
    expect(cod.text.toLowerCase()).not.toContain('received your payment');
  });

  it('says an amount is due, in both languages, when payment has not landed', () => {
    // Neither COD nor settled: the copy must claim no receipt and must not
    // send the customer to find cash for an order they put on a card.
    const en = renderOrderConfirmation({ ...base, payment: 'awaiting' }, 'en-AE');
    expect(en.text.toLowerCase()).toContain('amount due');
    expect(en.text.toLowerCase()).not.toContain('received your payment');
    expect(en.text.toLowerCase()).not.toContain('cash on delivery');

    const ar = renderOrderConfirmation({ ...base, payment: 'awaiting' }, 'ar-AE');
    expect(plain(ar.text)).toContain('المبلغ المستحق');
    expect(plain(ar.text)).not.toContain('تم استلام دفعتك');
    expect(plain(ar.text)).not.toContain('الدفع عند الاستلام');
  });

  it('keeps the Arabic COD line unpaid too', () => {
    const cod = renderOrderConfirmation({ ...base, payment: 'cod' }, 'ar-AE');
    expect(plain(cod.text)).toContain('الدفع عند الاستلام');
    expect(plain(cod.text)).not.toContain('تم استلام دفعتك');
  });

  it('renders Arabic when the locale is Arabic', () => {
    const r = renderOrderConfirmation(base, 'ar-AE');
    // Contains Arabic script and the RTL HTML direction.
    expect(r.text).toMatch(/[؀-ۿ]/);
    expect(r.subject).toContain('10042');
    expect(r.html).toContain('dir="rtl"');
  });

  it('uses Western digits for ar-AE, not Eastern Arabic numerals', () => {
    // ar-AE renders Western digits (0-9); ar-EG would render ٠-٩. The order
    // number and any money must stay legible to a courier reading the label.
    const r = renderOrderConfirmation(base, 'ar-AE');
    expect(r.text).toContain('10042');
    expect(r.text).not.toMatch(/[٠-٩]/); // no Eastern Arabic-Indic digits
  });

  it('uses Western digits for every Arabic locale, not just ar-AE', () => {
    // ar-AE resolves to the latn numbering system on its own; ar-EG and ar-SA
    // resolve to arab and would print "٤٬٦٩٩ د.إ." in a receipt. The decision is
    // Western digits throughout, so it must not depend on which Arabic locale
    // a customer record happens to carry.
    for (const locale of ['ar-AE', 'ar', 'ar-EG', 'ar-SA']) {
      const r = renderOrderConfirmation(base, locale);
      expect(r.text, locale).not.toMatch(/[٠-٩]/);
      expect(r.text, locale).toContain('4,699');
    }
  });

  it('isolates the order number and the tracking URL from the Arabic around them', () => {
    // Bare "#10042" inside RTL copy renders as "10042#" — the neutral '#' takes
    // the paragraph direction and detaches. The isolate marks fence the Latin
    // run so the number a customer reads back to support is the one we sent.
    const r = renderOrderConfirmation(base, 'ar-AE');
    expect(r.text).toContain('⁦#10042⁩');
    expect(r.text).toContain(`⁦${base.trackUrl}⁩`);
    expect(r.subject).toContain('⁦#10042⁩');
    // English copy is already LTR and gets no marks.
    expect(renderOrderConfirmation(base, 'en-AE').text).not.toMatch(/[⁦-⁩]/);
  });

  it('agrees the Arabic day count with the number of days', () => {
    // Arabic is singular / dual / plural, not singular / plural. "2 أيام" is
    // the machine-translation tell a native reader spots at once.
    const one = renderOrderConfirmation({ ...base, deliveryDays: 1 }, 'ar-AE');
    const two = renderOrderConfirmation({ ...base, deliveryDays: 2 }, 'ar-AE');
    const four = renderOrderConfirmation({ ...base, deliveryDays: 4 }, 'ar-AE');

    expect(plain(one.text)).toContain('يوم عمل واحد');
    expect(plain(two.text)).toContain('يومي عمل');
    expect(plain(four.text)).toContain('4 أيام عمل');
  });

  it('omits the delivery line when no estimate is known', () => {
    const r = renderOrderConfirmation({ ...base, deliveryDays: null, emirate: null }, 'en-AE');
    expect(r.text.toLowerCase()).not.toContain('working day');
  });

  it('carries an HTML body for email and none for WhatsApp', () => {
    expect(renderOrderConfirmation(base, 'en-AE', 'email').html).toContain('<!doctype html>');
    const wa = renderOrderConfirmation(base, 'en-AE', 'whatsapp');
    expect(wa.html).toBeNull();
    expect(wa.subject).toBeNull(); // WhatsApp has no subject line
    expect(wa.text).toContain('10042');
  });

  it('greets a nameless guest without an empty name', () => {
    const r = renderOrderConfirmation({ ...base, customerName: null }, 'en-AE');
    expect(r.text).not.toMatch(/Hi\s*,/); // never "Hi ," with a hole where the name was
  });
});

describe('cart recovery', () => {
  it('renders review-ready copy with a link back to the cart', () => {
    const r = renderCartRecovery(
      { customerName: 'Omar', itemCount: 3, cartUrl: 'https://shop.ae/cart', storeName: 'Voltix' },
      'en-AE',
    );
    expect(r.text).toContain('3 items');
    expect(r.text).toContain('https://shop.ae/cart');
  });
});

describe('ops alert', () => {
  it('is always English and clearly internal', () => {
    const r = renderOpsAlert({ headline: 'Payment did not reconcile', detail: 'Intent x is stuck.' });
    expect(r.subject).toContain('[Voltix ops]');
    expect(r.html).toBeNull();
  });
});
