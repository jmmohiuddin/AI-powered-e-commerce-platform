import { describe, expect, it } from 'vitest';
import {
  directionFor,
  discountPercent,
  formatCount,
  formatPrice,
  formatRating,
  relativeTime,
  splitVatInclusive,
} from './format';

/**
 * These cover the presentation decisions that are wrong to get wrong: the
 * digits a shopper reads, the fraction rule that keeps a product grid legible,
 * and the VAT split a tax invoice has to reconcile against.
 *
 * The Arabic assertions are the load-bearing ones. `ar-AE` resolves to the
 * `latn` numbering system on its own, so a test written only against `ar-AE`
 * would pass with the pinning removed — which is exactly how this drifted in
 * the first place. Every case therefore also runs an Arabic tag that resolves
 * to `arab` by default.
 */

const ARABIC_INDIC = /[٠-٩]/;
/** Arabic tags whose CLDR default numbering system is `arab`, not `latn`. */
const DEFAULTS_TO_ARABIC_INDIC = ['ar', 'ar-EG', 'ar-SA'];

describe('formatPrice', () => {
  it('renders AED the English way', () => {
    expect(formatPrice(419_900, 'AED', 'en-AE')).toMatch(/AED\s?4,199/);
  });

  it('drops the fraction on a whole amount and keeps it on a broken one', () => {
    // A grid of "AED 4,199.00" tiles spends horizontal space the title needs.
    expect(formatPrice(419_900, 'AED', 'en-AE')).not.toContain('.00');
    expect(formatPrice(419_950, 'AED', 'en-AE')).toContain('.50');
  });

  it('uses Western digits in Arabic, whichever Arabic tag arrives', () => {
    for (const locale of ['ar-AE', ...DEFAULTS_TO_ARABIC_INDIC]) {
      const formatted = formatPrice(419_900, 'AED', locale);
      expect(formatted, locale).not.toMatch(ARABIC_INDIC);
      expect(formatted, locale).toContain('4,199');
    }
  });

  it('still lets Arabic differ from English in every way except the digits', () => {
    // Pinning the numbering system must not flatten the locale into English:
    // the currency symbol is Arabic and sits on the other side of the amount.
    const ar = formatPrice(419_900, 'AED', 'ar-AE');
    expect(ar).toContain('د.إ');
    expect(ar).not.toContain('AED');
  });

  it('honours a numbering system the caller pinned explicitly', () => {
    expect(formatPrice(419_900, 'AED', 'ar-AE-u-nu-arab')).toMatch(ARABIC_INDIC);
  });

  it('respects the currency exponent', () => {
    expect(formatPrice(4_199_500, 'KWD', 'en-AE')).toContain('4,199.5'); // 3 minor units
    expect(formatPrice(419_900, 'JPY', 'en-AE')).toContain('419,900'); // 0 minor units
  });

  it('falls back to a plain string rather than throwing on a bad currency code', () => {
    // Intl requires a three-letter code and throws on anything else. A product
    // page must not 500 because one row carries a malformed currency.
    expect(formatPrice(419_900, 'XX', 'en-AE')).toBe('XX 4199.00');
  });
});

describe('formatRating and formatCount', () => {
  it('keep Western digits across Arabic tags', () => {
    for (const locale of ['ar-AE', ...DEFAULTS_TO_ARABIC_INDIC]) {
      expect(formatRating(437, locale), locale).not.toMatch(ARABIC_INDIC);
      expect(formatCount(12_500, locale), locale).not.toMatch(ARABIC_INDIC);
    }
    expect(formatRating(437, 'en-AE')).toBe('4.4');
    expect(formatRating(null)).toBeNull();
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-08-14T12:00:00Z');

  it('is relative inside a week and an absolute date beyond it', () => {
    expect(relativeTime(new Date('2026-08-12T12:00:00Z'), now, 'en-AE')).toContain('2 days ago');
    expect(relativeTime(new Date('2026-06-01T12:00:00Z'), now, 'en-AE')).toContain('2026');
  });

  it('keeps Western digits in Arabic, in both the relative and absolute forms', () => {
    for (const locale of ['ar-AE', ...DEFAULTS_TO_ARABIC_INDIC]) {
      expect(relativeTime(new Date('2026-08-12T12:00:00Z'), now, locale), locale).not.toMatch(ARABIC_INDIC);
      expect(relativeTime(new Date('2026-06-01T12:00:00Z'), now, locale), locale).not.toMatch(ARABIC_INDIC);
    }
  });
});

describe('splitVatInclusive', () => {
  it('splits a gross amount so the parts add back to it exactly', () => {
    // A tax invoice that does not reconcile to the fils is a rejected invoice.
    const { net, vat, gross } = splitVatInclusive(419_900, 500);
    expect(net + vat).toBe(gross);
    expect(vat).toBe(19_995);
  });
});

describe('discountPercent and directionFor', () => {
  it('reports a saving only when there is one', () => {
    expect(discountPercent(400_000, 500_000)).toBe(20);
    expect(discountPercent(500_000, 500_000)).toBeNull();
    expect(discountPercent(500_000, null)).toBeNull();
  });

  it('drives the page direction from the language, not the region', () => {
    expect(directionFor('ar-AE')).toBe('rtl');
    expect(directionFor('en-AE')).toBe('ltr');
  });
});
