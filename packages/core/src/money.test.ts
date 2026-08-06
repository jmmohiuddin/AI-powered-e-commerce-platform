import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  clampNonNegative,
  CurrencyMismatchError,
  format,
  fromDecimalString,
  money,
  percentage,
  subtract,
  sum,
  toDecimalString,
  zero,
} from './money';

describe('money construction', () => {
  it('rejects non-integer minor units', () => {
    expect(() => money(10.5, 'AED')).toThrow(TypeError);
  });

  it('normalises currency case', () => {
    expect(money(100, 'aed').currency).toBe('AED');
  });

  it('refuses to mix currencies', () => {
    expect(() => add(money(100, 'AED'), money(100, 'USD'))).toThrow(CurrencyMismatchError);
  });
});

describe('percentage', () => {
  it('computes basis points exactly', () => {
    // 15% of AED 1,999.00
    expect(percentage(money(199_900, 'AED'), 1500).amount).toBe(29_985);
  });

  it('rounds half away from zero in both directions', () => {
    // 0.5 minor units up
    expect(percentage(money(1, 'AED'), 5000).amount).toBe(1);
    expect(percentage(money(-1, 'AED'), 5000).amount).toBe(-1);
  });
});

describe('allocate', () => {
  it('never loses or invents minor units', () => {
    const parts = allocate(money(1000, 'AED'), [1, 1, 1]);
    expect(parts.map((p) => p.amount)).toEqual([334, 333, 333]);
    expect(sum(parts, 'AED').amount).toBe(1000);
  });

  it('weights proportionally', () => {
    const parts = allocate(money(10_000, 'AED'), [7000, 3000]);
    expect(parts.map((p) => p.amount)).toEqual([7000, 3000]);
  });

  it('is deterministic for equal remainders', () => {
    const a = allocate(money(101, 'AED'), [1, 1, 1, 1]);
    const b = allocate(money(101, 'AED'), [1, 1, 1, 1]);
    expect(a).toEqual(b);
    expect(sum(a, 'AED').amount).toBe(101);
  });

  it('handles negative totals (refund allocation) without drift', () => {
    const parts = allocate(money(-1000, 'AED'), [1, 1, 1]);
    expect(sum(parts, 'AED').amount).toBe(-1000);
  });

  it('puts everything on the first line when all weights are zero', () => {
    const parts = allocate(money(500, 'AED'), [0, 0]);
    expect(parts.map((p) => p.amount)).toEqual([500, 0]);
  });

  it('survives a fuzz of random splits', () => {
    for (let i = 0; i < 500; i += 1) {
      const total = Math.floor(Math.random() * 1_000_000);
      const weights = Array.from({ length: 2 + Math.floor(Math.random() * 8) }, () =>
        Math.floor(Math.random() * 1000),
      );
      const parts = allocate(money(total, 'AED'), weights);
      expect(sum(parts, 'AED').amount).toBe(total);
    }
  });
});

describe('clampNonNegative', () => {
  it('prevents a discount from producing a payout', () => {
    const afterDiscount = subtract(money(1000, 'AED'), money(1500, 'AED'));
    expect(clampNonNegative(afterDiscount)).toEqual(zero('AED'));
  });
});

describe('decimal conversion', () => {
  it('round-trips', () => {
    const m = fromDecimalString('1,234.56', 'AED');
    expect(m.amount).toBe(123_456);
    expect(toDecimalString(m)).toBe('1234.56');
  });

  it('handles zero-decimal currencies', () => {
    expect(toDecimalString(money(1500, 'JPY'))).toBe('1500');
  });

  it('handles three-decimal currencies', () => {
    expect(toDecimalString(money(1500, 'KWD'))).toBe('1.500');
  });
});

describe('format', () => {
  it('produces a currency string without throwing on odd locales', () => {
    expect(format(money(123_456, 'AED'), 'en-AE')).toContain('1,234.56');
  });

  it('degrades gracefully instead of throwing inside a render path', () => {
    // Intl rejects codes that are not three letters. A malformed currency in
    // the database must not take down the page that displays it.
    expect(format(money(100, 'X'))).toBe('X 1.00');
  });
});
