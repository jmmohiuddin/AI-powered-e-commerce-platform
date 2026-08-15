import { afterEach, describe, expect, it } from 'vitest';
import { money } from '../money';
import { calculatePricing } from '../pricing/engine';
import type { PricingLineInput } from '../pricing/types';
import {
  changeOfMindWindowDays,
  DEFAULT_CHANGE_OF_MIND_DAYS,
  DELIVERY_ZONES,
  estimateDelivery,
  extractVat,
  formatMakani,
  formatUaePhone,
  isValidMakani,
  isValidTrn,
  isValidUaePhone,
  netOfVat,
  normaliseUaePhone,
  RETURN_POLICY,
  UAE_STANDARD_VAT,
  validateAddress,
} from './uae';

describe('VAT', () => {
  it('extracts rather than adds — UAE prices are displayed VAT-inclusive', () => {
    // A phone on the shelf at AED 4,699 is AED 4,475.24 net + AED 223.76 VAT.
    const shelf = money(469_900, 'AED');
    const vat = extractVat(shelf);
    const net = netOfVat(shelf);

    expect(vat.amount).toBe(22_376);
    expect(net.amount + vat.amount).toBe(shelf.amount);
  });

  it('keeps the shelf price intact through the pricing engine', () => {
    // The bug this guards against is a 5% overcharge: adding VAT on top of a
    // price that already contains it.
    const line: PricingLineInput = {
      id: 'l1',
      variantId: 'v1',
      productId: 'p1',
      categoryIds: [],
      quantity: 1,
      unitPrice: money(469_900, 'AED'),
      requiresShipping: true,
    };

    const result = calculatePricing([line], [], {
      currency: 'AED',
      now: new Date('2026-08-06T10:00:00Z'),
      channel: 'web',
      customerSegments: [],
      isFirstOrder: false,
      shippingCost: money(0, 'AED'),
      taxRules: [UAE_STANDARD_VAT],
    });

    expect(result.total.amount).toBe(469_900);
    expect(result.taxTotal.amount).toBe(22_376);
  });

  it('handles a fils-level rounding boundary without drift', () => {
    for (const gross of [1, 99, 100, 101, 12_345, 999_999]) {
      const m = money(gross, 'AED');
      expect(netOfVat(m).amount + extractVat(m).amount).toBe(gross);
    }
  });
});

describe('TRN', () => {
  it('accepts a 15-digit number, with or without spacing', () => {
    expect(isValidTrn('100123456700003')).toBe(true);
    expect(isValidTrn('100 123 456 700 003')).toBe(true);
  });

  it('rejects the wrong length — a malformed TRN voids the tax invoice', () => {
    expect(isValidTrn('10012345670000')).toBe(false);
    expect(isValidTrn('1001234567000034')).toBe(false);
    expect(isValidTrn('abc123456700003')).toBe(false);
  });

  it('formats in readable groups', () => {
    expect(formatMakani('2648870219')).toBe('26488 70219');
  });
});

describe('phone numbers', () => {
  it('accepts every format a UAE customer actually types', () => {
    for (const input of [
      '0501234567',
      '501234567',
      '+971501234567',
      '00971 50 123 4567',
      '+971 50 123 45 67',
    ]) {
      expect(isValidUaePhone(input), input).toBe(true);
      expect(normaliseUaePhone(input)).toBe('+971501234567');
    }
  });

  it('accepts all live mobile prefixes', () => {
    for (const prefix of ['50', '52', '54', '55', '56', '58']) {
      expect(isValidUaePhone(`0${prefix}1234567`), prefix).toBe(true);
    }
  });

  it('rejects landlines and malformed numbers', () => {
    // 04 is a Dubai landline — valid to call, useless for an OTP or a courier.
    expect(isValidUaePhone('045550000')).toBe(false);
    expect(isValidUaePhone('0511234567')).toBe(false);
    expect(isValidUaePhone('05012345')).toBe(false);
    expect(normaliseUaePhone('nonsense')).toBeNull();
  });

  it('formats for display without losing the original on failure', () => {
    expect(formatUaePhone('0501234567')).toBe('+971 50 123 4567');
    expect(formatUaePhone('not a number')).toBe('not a number');
  });
});

describe('Makani', () => {
  it('accepts exactly ten digits', () => {
    expect(isValidMakani('2648870219')).toBe(true);
    expect(isValidMakani('26488 70219')).toBe(true);
    expect(isValidMakani('264887021')).toBe(false);
  });
});

describe('address validation', () => {
  const base = {
    recipientName: 'Aisha Al Mansoori',
    phone: '+971501234567',
    emirate: 'DU' as const,
    area: 'Dubai Marina',
  };

  it('never requires a postal code — the UAE has no postal code system', () => {
    const result = validateAddress({ ...base, buildingName: 'Marina Heights' });
    expect(result.valid).toBe(true);
    expect(result.errors.join(' ')).not.toMatch(/postal/i);
  });

  it('accepts a Makani number alone as deliverable', () => {
    const result = validateAddress({ ...base, makani: '2648870219' });
    expect(result.valid).toBe(true);
  });

  it('rejects an address a courier could not find', () => {
    const result = validateAddress(base);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/building name or a Makani/);
  });

  it('warns rather than blocks when a Dubai address has no Makani', () => {
    const result = validateAddress({ ...base, buildingName: 'Marina Heights' });
    expect(result.valid).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/Makani/);
  });

  it('rejects a PO Box as the only address — it is not a courier destination', () => {
    const result = validateAddress({ ...base, poBox: '12345' });
    expect(result.valid).toBe(false);
  });

  it('requires an emirate and a valid mobile number', () => {
    expect(validateAddress({ ...base, emirate: undefined }).valid).toBe(false);
    expect(validateAddress({ ...base, phone: '045550000' }).valid).toBe(false);
  });
});

describe('delivery estimates', () => {
  // 2026-08-06 is a Thursday; 08-08 a Saturday, 08-09 a Sunday.
  const thursdayMorning = new Date('2026-08-06T06:00:00Z'); // 10:00 Dubai
  const thursdayEvening = new Date('2026-08-06T16:00:00Z'); // 20:00 Dubai

  it('offers same-day in Dubai before the cut-off', () => {
    const result = estimateDelivery('DU', thursdayMorning);
    expect(result.sameDay).toBe(true);
  });

  it('does not promise same-day after the cut-off', () => {
    const result = estimateDelivery('DU', thursdayEvening);
    expect(result.sameDay).toBe(false);
  });

  it('never lands a delivery on the Saturday–Sunday weekend', () => {
    // The UAE weekend moved to Sat–Sun in January 2022. A courier that does not
    // collect at the weekend turns a Friday-evening order into a mid-week
    // delivery, and a system that promises Saturday is promising something that
    // cannot happen.
    const friday = new Date('2026-08-07T16:00:00Z');
    for (const emirate of ['DU', 'AZ', 'SH', 'RK', 'FU'] as const) {
      const day = estimateDelivery(emirate, friday).estimatedAt.getUTCDay();
      expect([6, 0], `${emirate} landed on a weekend`).not.toContain(day);
    }
  });

  it('honours configured public holidays', () => {
    const before = estimateDelivery('SH', thursdayEvening);
    const withHoliday = estimateDelivery('SH', thursdayEvening, {
      holidays: [before.estimatedAt.toISOString().slice(0, 10)],
    });
    expect(withHoliday.estimatedAt.getTime()).toBeGreaterThan(before.estimatedAt.getTime());
  });

  it('gives every emirate a delivery zone', () => {
    for (const code of ['AZ', 'DU', 'SH', 'AJ', 'UQ', 'RK', 'FU'] as const) {
      expect(DELIVERY_ZONES[code]).toBeDefined();
      expect(DELIVERY_ZONES[code].standardDays).toBeGreaterThan(0);
    }
  });
});

describe('return window configuration', () => {
  /**
   * The change-of-mind window is configuration rather than a constant because
   * the 14-day cooling-off right is REPORTED, not confirmed in the primary
   * sources reviewed (PRD L-06 / Q-08). What these tests protect is the
   * property that makes that useful: the published policy page and the returns
   * workflow read the same number, at the moment they read it, so counsel can
   * change it without a deploy and the two cannot end up disagreeing.
   */
  const original = process.env.RETURNS_CHANGE_OF_MIND_DAYS;

  afterEach(() => {
    if (original === undefined) delete process.env.RETURNS_CHANGE_OF_MIND_DAYS;
    else process.env.RETURNS_CHANGE_OF_MIND_DAYS = original;
  });

  it('defaults to 14 days when unset', () => {
    delete process.env.RETURNS_CHANGE_OF_MIND_DAYS;
    expect(changeOfMindWindowDays()).toBe(DEFAULT_CHANGE_OF_MIND_DAYS);
    expect(RETURN_POLICY.changeOfMindDays).toBe(14);
  });

  it('takes the configured window', () => {
    process.env.RETURNS_CHANGE_OF_MIND_DAYS = '7';
    expect(RETURN_POLICY.changeOfMindDays).toBe(7);
  });

  it('re-reads on every access, so a restart is enough to change the policy', () => {
    // The point of the getter. A property captured at module load would still
    // be reporting the first value read here, which is how a policy page and a
    // workflow drift apart.
    process.env.RETURNS_CHANGE_OF_MIND_DAYS = '30';
    expect(RETURN_POLICY.changeOfMindDays).toBe(30);
    process.env.RETURNS_CHANGE_OF_MIND_DAYS = '3';
    expect(RETURN_POLICY.changeOfMindDays).toBe(3);
  });

  it('accepts zero — "no cooling-off window" is a legitimate ruling', () => {
    process.env.RETURNS_CHANGE_OF_MIND_DAYS = '0';
    expect(RETURN_POLICY.changeOfMindDays).toBe(0);
  });

  it.each(['', '  ', 'fourteen', '14.5', '-3', 'NaN'])(
    'falls back to the default rather than publishing %o to customers',
    (value) => {
      process.env.RETURNS_CHANGE_OF_MIND_DAYS = value;
      expect(RETURN_POLICY.changeOfMindDays).toBe(DEFAULT_CHANGE_OF_MIND_DAYS);
    },
  );

  it('leaves the defective-goods window alone — it tracks a statutory right', () => {
    process.env.RETURNS_CHANGE_OF_MIND_DAYS = '1';
    expect(RETURN_POLICY.defectiveGoodsDays).toBe(30);
  });
});
