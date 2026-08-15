/**
 * Presentation helpers shared by both apps.
 *
 * Kept out of the components so the storefront and the admin render a price the
 * same way. Nothing is more corrosive to a merchant's trust than the dashboard
 * and the storefront disagreeing about what something costs.
 */

const MINOR_UNITS: Record<string, number> = {
  AED: 2,
  SAR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  INR: 2,
  JPY: 0,
  KWD: 3,
  BHD: 3,
  OMR: 3,
};

export type SupportedLocale = 'en-AE' | 'ar-AE';

/**
 * Pins a locale to Western digits (0-9).
 *
 * Project decision: Western digits throughout, **including in Arabic**. It is
 * UAE commercial practice, and it keeps every identifier a customer might read
 * back — an order number, a price, a date — unambiguous across the two
 * languages the store serves.
 *
 * This is not defensive noise. `ar-AE` happens to resolve to the `latn`
 * numbering system already, but `ar`, `ar-EG` and `ar-SA` resolve to `arab` and
 * would render "٤٬١٩٩ د.إ." — so without pinning, whether a shopper sees 4,199
 * or ٤٬١٩٩ depends on which locale tag reaches the formatter rather than on any
 * decision anyone made.
 */
function westernDigits(locale: string): string {
  // A caller who pinned a numbering system deliberately keeps it; otherwise
  // extend an existing `-u-` extension rather than opening a second one, which
  // would produce an invalid tag.
  if (/-u-(.*-)?nu-/.test(locale)) return locale;
  return locale.includes('-u-') ? `${locale}-nu-latn` : `${locale}-u-nu-latn`;
}

/**
 * Formats a price for display.
 *
 * Always routed through `Intl` rather than string concatenation, because the
 * difference between the two locales this store serves is not a symbol swap:
 *
 *   en-AE → "AED 4,199"
 *   ar-AE → "‏4,199 د.إ.‏"
 *
 * A different thousands separator, a different decimal separator, the symbol on
 * the other side, and the bidi marks that keep the amount from merging into the
 * Arabic around it. Hand-rolled formatting gets every one of those wrong, and a
 * shopper reading Arabic notices immediately.
 *
 * The digits, and only the digits, are pinned — see `westernDigits`.
 *
 * Fractions are shown only when they exist. UAE electronics pricing is
 * overwhelmingly in whole dirhams, and "AED 4,199.00" on every tile in a grid
 * is noise that costs horizontal space the product title needs.
 */
export function formatPrice(
  minorUnits: number,
  currency = 'AED',
  locale: SupportedLocale | string = 'en-AE',
): string {
  const exponent = MINOR_UNITS[currency] ?? 2;
  const hasFraction = minorUnits % 10 ** exponent !== 0;

  try {
    return new Intl.NumberFormat(westernDigits(locale), {
      style: 'currency',
      currency,
      minimumFractionDigits: hasFraction ? exponent : 0,
      maximumFractionDigits: hasFraction ? exponent : 0,
    }).format(minorUnits / 10 ** exponent);
  } catch {
    return `${currency} ${(minorUnits / 10 ** exponent).toFixed(exponent)}`;
  }
}

/**
 * Splits a VAT-inclusive price into its net and tax parts.
 *
 * UAE consumer prices are displayed inclusive of 5% VAT, but a tax invoice must
 * state the taxable amount and the VAT amount separately. Both apps need the
 * same split, computed the same way, or the invoice will not reconcile with the
 * order.
 */
export function splitVatInclusive(
  grossMinorUnits: number,
  vatRateBps = 500,
): { net: number; vat: number; gross: number } {
  const vat = Math.round((grossMinorUnits * vatRateBps) / (10_000 + vatRateBps));
  return { net: grossMinorUnits - vat, vat, gross: grossMinorUnits };
}

/** Discount in whole percent, or null when there is no genuine saving. */
export function discountPercent(price: number, compareAt?: number | null): number | null {
  if (!compareAt || compareAt <= price) return null;
  return Math.round(((compareAt - price) / compareAt) * 100);
}

/** 437 → "4.4", with the locale's decimal separator and Western digits. */
export function formatRating(
  ratingAverage?: number | null,
  locale: SupportedLocale | string = 'en-AE',
): string | null {
  if (ratingAverage == null) return null;
  try {
    return new Intl.NumberFormat(westernDigits(locale), {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(ratingAverage / 100);
  } catch {
    return (ratingAverage / 100).toFixed(1);
  }
}

export function formatCount(value: number, locale: SupportedLocale | string = 'en-AE'): string {
  try {
    return new Intl.NumberFormat(westernDigits(locale)).format(value);
  } catch {
    return String(value);
  }
}

export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

/**
 * Relative time for order timelines. Falls back to an absolute date past a
 * week, because "23 days ago" is harder to act on than a date.
 *
 * Uses `Intl.RelativeTimeFormat` so Arabic gets correct dual and plural forms —
 * Arabic distinguishes one, two, and many, and a naive `${n} days ago` template
 * is wrong for two of the three. The digits stay Western either way.
 */
export function relativeTime(
  date: Date,
  now = new Date(),
  locale: SupportedLocale | string = 'en-AE',
): string {
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  const tag = westernDigits(locale);

  let rtf: Intl.RelativeTimeFormat;
  try {
    rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
  } catch {
    rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  }

  if (seconds < 60) return rtf.format(-seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  const days = Math.round(hours / 24);
  if (days <= 7) return rtf.format(-days, 'day');

  return new Intl.DateTimeFormat(tag, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Dubai',
  }).format(date);
}

/** Text direction for a locale. Drives `dir` on <html> and logical CSS. */
export function directionFor(locale: string): 'ltr' | 'rtl' {
  return locale.startsWith('ar') || locale.startsWith('he') || locale.startsWith('fa')
    ? 'rtl'
    : 'ltr';
}
