import { describe, expect, it } from 'vitest';
import { assessOrderRisk, segmentCustomer, type RiskSignalInput } from './risk';

const clean: RiskSignalInput = {
  isFirstOrder: false,
  customerOrderCount: 8,
  customerRefusedDeliveries: 0,
  customerChargebacks: 0,
  phoneVerified: true,
  emailVerified: true,
  orderTotal: 300_000,
  averageOrderValue: 280_000,
  paymentProvider: 'network',
  accountAgeMinutes: 60 * 24 * 400,
  recentOrderVelocity: 1,
  distinctRecentAddresses: 1,
  addressMismatch: false,
  highResaleValueCart: false,
  shippingAddressIncomplete: false,
};

describe('assessOrderRisk', () => {
  it('allows an established customer placing a normal order', () => {
    const result = assessOrderRisk(clean);
    expect(result.decision).toBe('allow');
    expect(result.score).toBe(0);
  });

  it('blocks a customer with repeat chargebacks regardless of score', () => {
    const result = assessOrderRisk({ ...clean, customerChargebacks: 2 });
    expect(result.decision).toBe('block');
  });

  it('asks for advance payment rather than blocking a risky COD order', () => {
    const result = assessOrderRisk({
      ...clean,
      paymentProvider: 'cod',
      isFirstOrder: true,
      customerOrderCount: 0,
      phoneVerified: false,
      orderTotal: 12_000_000,
      averageOrderValue: null,
      highResaleValueCart: true,
      accountAgeMinutes: 5,
    });
    // Converting the sale with a deposit beats refusing it outright.
    expect(result.decision).toBe('require_advance_payment');
    expect(result.score).toBeGreaterThanOrEqual(50);
  });

  it('weights prior delivery refusals heavily — the real COD loss', () => {
    const result = assessOrderRisk({ ...clean, customerRefusedDeliveries: 2, customerOrderCount: 2 });
    expect(result.signals.map((s) => s.code)).toContain('prior_refusal');
    expect(result.score).toBeGreaterThan(30);
  });

  it('lets a clean history offset weaker negative signals', () => {
    const withHistory = assessOrderRisk({ ...clean, addressMismatch: true });
    const withoutHistory = assessOrderRisk({
      ...clean,
      customerOrderCount: 1,
      addressMismatch: true,
    });
    expect(withHistory.score).toBeLessThan(withoutHistory.score);
  });

  it('keeps the score inside 0–100 under extreme input', () => {
    const result = assessOrderRisk({
      ...clean,
      customerChargebacks: 9,
      customerRefusedDeliveries: 9,
      customerOrderCount: 0,
      isFirstOrder: true,
      phoneVerified: false,
      emailVerified: false,
      orderTotal: 99_000_000,
      averageOrderValue: 1000,
      paymentProvider: 'cod',
      accountAgeMinutes: 1,
      recentOrderVelocity: 20,
      distinctRecentAddresses: 12,
      addressMismatch: true,
      highResaleValueCart: true,
      shippingAddressIncomplete: true,
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('always explains itself', () => {
    const result = assessOrderRisk({ ...clean, recentOrderVelocity: 6 });
    expect(result.explanation).toContain('orders in the last hour');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('penalises an unverified phone more on COD than on a card', () => {
    const cod = assessOrderRisk({ ...clean, paymentProvider: 'cod', phoneVerified: false });
    const card = assessOrderRisk({ ...clean, paymentProvider: 'stripe', phoneVerified: false });
    const codWeight = cod.signals.find((s) => s.code === 'phone_unverified')!.weight;
    const cardWeight = card.signals.find((s) => s.code === 'phone_unverified')!.weight;
    expect(codWeight).toBeGreaterThan(cardWeight);
  });
});

describe('segmentCustomer', () => {
  it('identifies a loyal, active, high-value customer', () => {
    const segments = segmentCustomer({
      orderCount: 12,
      daysSinceLastOrder: 10,
      lifetimeValue: 30_000_000,
      averageOrderValue: 2_500_000,
      discountedOrderShare: 0.1,
      accessoryOrderShare: 0.2,
      returnRate: 0,
    });
    expect(segments).toEqual(expect.arrayContaining(['loyal', 'active', 'vip']));
  });

  it('flags a lapsed customer as at risk', () => {
    const segments = segmentCustomer({
      orderCount: 4,
      daysSinceLastOrder: 200,
      lifetimeValue: 1_000_000,
      averageOrderValue: 250_000,
      discountedOrderShare: 0.2,
      accessoryOrderShare: 0.1,
      returnRate: 0,
    });
    expect(segments).toContain('at_risk');
  });

  it('spots price sensitivity only with enough orders to be a pattern', () => {
    const oneOrder = segmentCustomer({
      orderCount: 1,
      daysSinceLastOrder: 5,
      lifetimeValue: 100_000,
      averageOrderValue: 100_000,
      discountedOrderShare: 1,
      accessoryOrderShare: 0,
      returnRate: 0,
    });
    expect(oneOrder).not.toContain('price_sensitive');

    const several = segmentCustomer({
      orderCount: 6,
      daysSinceLastOrder: 5,
      lifetimeValue: 600_000,
      averageOrderValue: 100_000,
      discountedOrderShare: 0.9,
      accessoryOrderShare: 0,
      returnRate: 0,
    });
    expect(several).toContain('price_sensitive');
  });

  it('classifies a customer with no orders as a prospect', () => {
    const segments = segmentCustomer({
      orderCount: 0,
      daysSinceLastOrder: null,
      lifetimeValue: 0,
      averageOrderValue: 0,
      discountedOrderShare: 0,
      accessoryOrderShare: 0,
      returnRate: 0,
    });
    expect(segments).toContain('prospect');
  });
});
