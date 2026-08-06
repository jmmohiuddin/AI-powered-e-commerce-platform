import { describe, expect, it } from 'vitest';
import { money, sum, zero } from '../money';
import { calculatePricing } from './engine';
import type { DiscountInput, PricingContext, PricingLineInput, TaxRule } from './types';

const AED = 'AED';

/** AED 1,999.00 phone case, AED 124,999.00 handset. Realistic magnitudes matter: */
/** rounding bugs hide at AED 10 and appear at AED 124,999.                        */
const phone: PricingLineInput = {
  id: 'l1',
  variantId: 'v-phone',
  productId: 'p-phone',
  categoryIds: ['c-smartphones'],
  brandId: 'b-samsung',
  quantity: 1,
  unitPrice: money(12_499_900, AED),
  unitCost: money(11_000_000, AED),
  requiresShipping: true,
};

const caseLine: PricingLineInput = {
  id: 'l2',
  variantId: 'v-case',
  productId: 'p-case',
  categoryIds: ['c-accessories'],
  brandId: 'b-generic',
  quantity: 3,
  unitPrice: money(199_900, AED),
  unitCost: money(80_000, AED),
  requiresShipping: true,
};

function ctx(overrides: Partial<PricingContext> = {}): PricingContext {
  return {
    currency: AED,
    now: new Date('2026-08-06T10:00:00Z'),
    channel: 'web',
    customerSegments: [],
    isFirstOrder: false,
    shippingCost: money(12_000, AED),
    taxRules: [],
    ...overrides,
  };
}

describe('calculatePricing — baseline', () => {
  it('sums lines and shipping with no discounts or tax', () => {
    const r = calculatePricing([phone, caseLine], [], ctx());
    expect(r.subtotal.amount).toBe(12_499_900 + 3 * 199_900);
    expect(r.discountTotal.amount).toBe(0);
    expect(r.total.amount).toBe(r.subtotal.amount + 12_000);
    expect(r.amountDue.amount).toBe(r.total.amount);
  });

  it('reports gross margin in basis points', () => {
    const r = calculatePricing([phone], [], ctx());
    // (12,499,900 − 11,000,000) / 12,499,900 ≈ 12.00%
    expect(r.marginBps).toBeGreaterThan(1150);
    expect(r.marginBps).toBeLessThan(1250);
  });

  it('leaves margin null when cost is unknown', () => {
    const { unitCost: _drop, ...noCost } = phone;
    const r = calculatePricing([noCost as PricingLineInput], [], ctx());
    expect(r.marginBps).toBeNull();
  });
});

describe('discount eligibility', () => {
  const percentOff: DiscountInput = {
    id: 'd1',
    code: 'SAVE15',
    name: '15% off',
    type: 'percentage',
    scope: 'order',
    value: 1500,
    conditions: { minSubtotal: 500_000 },
    isStackable: false,
    priority: 10,
  };

  it('applies a qualifying order-level percentage', () => {
    const r = calculatePricing([phone], [percentOff], ctx());
    expect(r.appliedDiscounts).toHaveLength(1);
    expect(r.discountTotal.amount).toBe(Math.round(12_499_900 * 0.15));
  });

  it('rejects with an actionable message below the minimum', () => {
    const r = calculatePricing([caseLine], [{ ...percentOff, conditions: { minSubtotal: 99_999_999 } }], ctx());
    expect(r.appliedDiscounts).toHaveLength(0);
    expect(r.rejectedDiscounts[0]?.reason).toMatch(/Add .* more to qualify/);
  });

  it('rejects an expired offer', () => {
    const r = calculatePricing(
      [phone],
      [{ ...percentOff, endsAt: new Date('2026-01-01T00:00:00Z') }],
      ctx(),
    );
    expect(r.rejectedDiscounts[0]?.reason).toBe('This offer has expired');
  });

  it('rejects a first-order-only offer for a returning customer', () => {
    const r = calculatePricing(
      [phone],
      [{ ...percentOff, conditions: { firstOrderOnly: true } }],
      ctx({ isFirstOrder: false }),
    );
    expect(r.rejectedDiscounts[0]?.reason).toBe('Valid on your first order only');
  });

  it('honours a usage limit', () => {
    const r = calculatePricing([phone], [{ ...percentOff, usageLimit: 5, usageCount: 5 }], ctx());
    expect(r.rejectedDiscounts[0]?.reason).toMatch(/usage limit/);
  });
});

describe('discount stacking', () => {
  const exclusiveA: DiscountInput = {
    id: 'a',
    code: 'A',
    name: 'A',
    type: 'percentage',
    scope: 'order',
    value: 1000,
    conditions: {},
    isStackable: false,
    priority: 20,
  };
  const exclusiveB: DiscountInput = { ...exclusiveA, id: 'b', code: 'B', name: 'B', priority: 10 };

  it('lets only the highest-priority exclusive discount apply', () => {
    const r = calculatePricing([phone], [exclusiveB, exclusiveA], ctx());
    expect(r.appliedDiscounts.map((d) => d.discountId)).toEqual(['a']);
    expect(r.rejectedDiscounts[0]?.discountId).toBe('b');
  });

  it('never lets stacked discounts push a line below zero', () => {
    const huge: DiscountInput = {
      id: 'h1',
      name: '90% off',
      type: 'percentage',
      scope: 'order',
      value: 9000,
      conditions: {},
      isStackable: true,
      priority: 5,
    };
    const r = calculatePricing([caseLine], [huge, { ...huge, id: 'h2' }, { ...huge, id: 'h3' }], ctx());
    expect(r.total.amount).toBeGreaterThanOrEqual(0);
    expect(r.discountTotal.amount).toBeLessThanOrEqual(caseLine.unitPrice.amount * 3);
    for (const line of r.lines) {
      expect(line.lineTotal.amount).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('discount allocation', () => {
  it('splits an order discount across lines so parts sum to the whole', () => {
    const d: DiscountInput = {
      id: 'd',
      name: '฿ off',
      type: 'fixed_amount',
      scope: 'order',
      value: 100_001, // deliberately indivisible by 2
      conditions: {},
      isStackable: false,
      priority: 1,
    };
    const r = calculatePricing([phone, caseLine], [d], ctx());
    const allocations = [...r.appliedDiscounts[0]!.lineAllocations.values()];
    expect(sum(allocations, AED).amount).toBe(100_001);
  });

  it('targets only matching lines for a category-scoped discount', () => {
    const d: DiscountInput = {
      id: 'd',
      name: 'Accessories 20%',
      type: 'percentage',
      scope: 'category',
      value: 2000,
      conditions: { categoryIds: ['c-accessories'] },
      isStackable: false,
      priority: 1,
    };
    const r = calculatePricing([phone, caseLine], [d], ctx());
    const alloc = r.appliedDiscounts[0]!.lineAllocations;
    expect(alloc.has('l1')).toBe(false);
    expect(alloc.get('l2')!.amount).toBe(Math.round(3 * 199_900 * 0.2));
  });

  it('refuses to apply a scoped discount that specifies no targets', () => {
    const d: DiscountInput = {
      id: 'd',
      name: 'Broken config',
      type: 'percentage',
      scope: 'product',
      value: 5000,
      conditions: {},
      isStackable: false,
      priority: 1,
    };
    const r = calculatePricing([phone], [d], ctx());
    expect(r.appliedDiscounts).toHaveLength(0);
    expect(r.rejectedDiscounts[0]?.reason).toMatch(/No items/);
  });

  it('caps a percentage discount at maxDiscountAmount', () => {
    const d: DiscountInput = {
      id: 'd',
      name: '50% up to AED 500',
      type: 'percentage',
      scope: 'order',
      value: 5000,
      maxDiscountAmount: 50_000,
      conditions: {},
      isStackable: false,
      priority: 1,
    };
    const r = calculatePricing([phone], [d], ctx());
    expect(r.discountTotal.amount).toBe(50_000);
  });
});

describe('buy X get Y', () => {
  it('discounts the cheapest qualifying units', () => {
    const line: PricingLineInput = { ...caseLine, quantity: 3 };
    const d: DiscountInput = {
      id: 'bxgy',
      name: 'Buy 2 get 1 free',
      type: 'buy_x_get_y',
      scope: 'product',
      value: 0,
      conditions: { productIds: ['p-case'], buyQuantity: 2, getQuantity: 1, getDiscountBps: 10_000 },
      isStackable: false,
      priority: 1,
    };
    const r = calculatePricing([line], [d], ctx());
    expect(r.discountTotal.amount).toBe(199_900);
  });

  it('gives nothing when the cart is short of a full set', () => {
    const line: PricingLineInput = { ...caseLine, quantity: 2 };
    const d: DiscountInput = {
      id: 'bxgy',
      name: 'Buy 2 get 1 free',
      type: 'buy_x_get_y',
      scope: 'product',
      value: 0,
      conditions: { productIds: ['p-case'], buyQuantity: 2, getQuantity: 1 },
      isStackable: false,
      priority: 1,
    };
    const r = calculatePricing([line], [d], ctx());
    expect(r.appliedDiscounts).toHaveLength(0);
  });
});

describe('shipping', () => {
  it('zeroes shipping for a free-shipping discount', () => {
    const d: DiscountInput = {
      id: 'fs',
      code: 'FREESHIP',
      name: 'Free delivery',
      type: 'free_shipping',
      scope: 'shipping',
      value: 0,
      conditions: {},
      isStackable: true,
      priority: 1,
    };
    const r = calculatePricing([phone], [d], ctx());
    expect(r.shippingTotal.amount).toBe(0);
    expect(r.total.amount).toBe(phone.unitPrice.amount);
  });
});

describe('tax', () => {
  const exclusiveVat: TaxRule = {
    id: 't1',
    name: 'VAT 15%',
    rateBps: 1500,
    isInclusive: false,
    appliesToShipping: false,
  };
  const inclusiveVat: TaxRule = { ...exclusiveVat, isInclusive: true };

  it('adds exclusive tax on the post-discount amount, not the list price', () => {
    const d: DiscountInput = {
      id: 'd',
      name: '10% off',
      type: 'percentage',
      scope: 'order',
      value: 1000,
      conditions: {},
      isStackable: false,
      priority: 1,
    };
    const r = calculatePricing([phone], [d], ctx({ taxRules: [exclusiveVat], shippingCost: zero(AED) }));
    const net = 12_499_900 - Math.round(12_499_900 * 0.1);
    expect(r.taxTotal.amount).toBe(Math.round(net * 0.15));
    expect(r.total.amount).toBe(net + r.taxTotal.amount);
  });

  it('extracts rather than adds tax when prices are VAT-inclusive', () => {
    const r = calculatePricing([phone], [], ctx({ taxRules: [inclusiveVat], shippingCost: zero(AED) }));
    // Total must stay at the shelf price; tax is a component of it.
    expect(r.total.amount).toBe(12_499_900);
    expect(r.taxTotal.amount).toBe(Math.round((12_499_900 * 1500) / 11_500));
  });

  it('prefers a category-specific rule over the catch-all', () => {
    const catchAll: TaxRule = { ...exclusiveVat, id: 'all', rateBps: 1500 };
    const accessories: TaxRule = {
      id: 'acc',
      name: 'Accessories 5%',
      rateBps: 500,
      isInclusive: false,
      appliesToShipping: false,
      categoryIds: ['c-accessories'],
    };
    const r = calculatePricing(
      [caseLine],
      [],
      ctx({ taxRules: [accessories, catchAll], shippingCost: zero(AED) }),
    );
    expect(r.taxTotal.amount).toBe(Math.round(3 * 199_900 * 0.05));
  });
});

describe('stored value is tender, not discount', () => {
  it('reduces amountDue but leaves total and revenue intact', () => {
    const r = calculatePricing(
      [caseLine],
      [],
      ctx({ shippingCost: zero(AED), giftCardApplied: money(100_000, AED) }),
    );
    expect(r.total.amount).toBe(3 * 199_900);
    expect(r.discountTotal.amount).toBe(0);
    expect(r.amountDue.amount).toBe(3 * 199_900 - 100_000);
  });

  it('never produces a negative amount due', () => {
    const r = calculatePricing(
      [caseLine],
      [],
      ctx({ shippingCost: zero(AED), giftCardApplied: money(99_999_999, AED) }),
    );
    expect(r.amountDue.amount).toBe(0);
  });
});

describe('determinism', () => {
  it('produces identical output for identical input', () => {
    const discounts: DiscountInput[] = [
      {
        id: 'x',
        name: '12%',
        type: 'percentage',
        scope: 'order',
        value: 1234,
        conditions: {},
        isStackable: false,
        priority: 3,
      },
    ];
    const a = calculatePricing([phone, caseLine], discounts, ctx());
    const b = calculatePricing([phone, caseLine], discounts, ctx());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('keeps line totals summing to the order total', () => {
    const r = calculatePricing(
      [phone, caseLine],
      [
        {
          id: 'x',
          name: '7%',
          type: 'percentage',
          scope: 'order',
          value: 700,
          conditions: {},
          isStackable: false,
          priority: 1,
        },
      ],
      ctx({ shippingCost: zero(AED) }),
    );
    const lineSum = sum(
      r.lines.map((l) => l.lineTotal),
      AED,
    );
    expect(lineSum.amount).toBe(r.total.amount);
  });
});
