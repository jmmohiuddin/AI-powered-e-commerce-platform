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
  isCod: false,
  itemCount: 2,
  trackUrl: 'https://shop.ae/orders?number=10042',
  storeName: 'Voltix',
};

describe('order confirmation', () => {
  it('formats the total in the order currency', () => {
    const r = renderOrderConfirmation({ ...base, isCod: false }, 'en-AE');
    // AED with no fraction when the amount is whole thousands.
    expect(r.text).toMatch(/AED\s?4,699/);
    expect(r.subject).toBe('Order #10042 confirmed');
  });

  it('never tells a cash-on-delivery customer they have paid', () => {
    const paid = renderOrderConfirmation({ ...base, isCod: false }, 'en-AE');
    const cod = renderOrderConfirmation({ ...base, isCod: true }, 'en-AE');

    expect(paid.text.toLowerCase()).toContain('received your payment');
    // The COD copy must say pay-on-delivery and must NOT claim receipt.
    expect(cod.text.toLowerCase()).toContain('cash on delivery');
    expect(cod.text.toLowerCase()).not.toContain('received your payment');
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
