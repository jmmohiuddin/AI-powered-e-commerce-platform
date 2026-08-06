/**
 * Money.
 *
 * Every monetary value in the system is an integer count of minor units plus a
 * currency code. There is no float anywhere in the price path, and there is no
 * bare `number` passed between pricing functions — mixing a "price in dirhams"
 * with a "price in fils" is the kind of bug that ships to production and is only
 * noticed when a customer is charged 100× too much.
 *
 * ROUNDING
 * Percentage discounts and tax produce fractions. The rule here is
 * round-half-away-from-zero at the point of *each* line calculation, then sum —
 * not sum-then-round. Summing rounded lines is what makes an invoice's lines add
 * up to its total, which is what an accountant and a customer both check first.
 *
 * ALLOCATION
 * Order-level discounts must be split across lines (for per-line refunds, tax,
 * and margin). Naive proportional splitting loses or invents minor units;
 * `allocate` uses largest-remainder so the parts always sum exactly to the whole.
 */

export interface Money {
  /** Integer minor units. 1050 fils = AED 10.50. */
  readonly amount: number;
  /** ISO-4217, uppercase. */
  readonly currency: string;
}

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Cannot combine ${a} with ${b}`);
    this.name = 'CurrencyMismatchError';
  }
}

/** Minor-unit exponent per ISO-4217. Most currencies are 2; some are 0 or 3. */
const MINOR_UNITS: Record<string, number> = {
  // GCC — the trading region. KWD, BHD and OMR are three-decimal currencies,
  // which is precisely why the exponent is looked up rather than assumed to be
  // two: a 1,000-fils Kuwaiti dinar treated as 100 is a 10× pricing error.
  AED: 2,
  SAR: 2,
  QAR: 2,
  KWD: 3,
  BHD: 3,
  OMR: 3,
  // Common cross-border settlement currencies.
  USD: 2,
  EUR: 2,
  GBP: 2,
  INR: 2,
  JPY: 0,
  KRW: 0,
};

export function minorUnitExponent(currency: string): number {
  return MINOR_UNITS[currency.toUpperCase()] ?? 2;
}

export function money(amount: number, currency: string): Money {
  if (!Number.isInteger(amount)) {
    throw new TypeError(`Money must be an integer number of minor units, got ${amount}`);
  }
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError(`Money amount ${amount} exceeds safe integer range`);
  }
  return { amount, currency: currency.toUpperCase() };
}

export function zero(currency: string): Money {
  return { amount: 0, currency: currency.toUpperCase() };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function sum(values: readonly Money[], currency: string): Money {
  return values.reduce<Money>((acc, v) => add(acc, v), zero(currency));
}

export function negate(a: Money): Money {
  return money(-a.amount, a.currency);
}

export function multiply(a: Money, factor: number): Money {
  return money(roundHalfAwayFromZero(a.amount * factor), a.currency);
}

/** Basis points: 1500 bps = 15%. Integer bps avoids float percentages entirely. */
export function percentage(a: Money, basisPoints: number): Money {
  return money(roundHalfAwayFromZero((a.amount * basisPoints) / 10_000), a.currency);
}

export function compare(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.amount === b.amount ? 0 : a.amount < b.amount ? -1 : 1;
}

export const isZero = (a: Money): boolean => a.amount === 0;
export const isPositive = (a: Money): boolean => a.amount > 0;
export const isNegative = (a: Money): boolean => a.amount < 0;
export const equals = (a: Money, b: Money): boolean =>
  a.currency === b.currency && a.amount === b.amount;

export function max(a: Money, b: Money): Money {
  return compare(a, b) >= 0 ? a : b;
}

export function min(a: Money, b: Money): Money {
  return compare(a, b) <= 0 ? a : b;
}

/** Clamps to >= 0. A discount must never turn an order into a payout. */
export function clampNonNegative(a: Money): Money {
  return a.amount < 0 ? zero(a.currency) : a;
}

/**
 * Banker's rounding is the wrong default here. Commerce invoices are read by
 * humans who expect 0.5 to round up, and tax authorities in most of the target
 * markets specify round-half-up. `Math.round` is round-half-*up*, which is
 * asymmetric for negatives (-0.5 → -0) and breaks refund symmetry, hence this.
 */
function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Splits `total` across `weights` so the parts sum *exactly* to the total.
 *
 * Largest-remainder method: floor each share, then hand the leftover minor
 * units one at a time to the lines with the largest fractional remainders.
 * Ties break toward the earlier line, which keeps the result deterministic —
 * important because an order recalculated on a retry must produce identical
 * line amounts or the reconciliation job will flag a phantom discrepancy.
 *
 * Example: allocate AED 10.00 across weights [1,1,1] → [334, 333, 333], not
 * [333,333,333] (loses a fils) or [334,334,334] (invents two).
 */
export function allocate(total: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) return [];
  if (weights.some((w) => w < 0)) throw new RangeError('Allocation weights must be non-negative');

  const weightTotal = weights.reduce((a, b) => a + b, 0);
  if (weightTotal === 0) {
    // Degenerate case: nothing to weight by. Put everything on the first line
    // rather than silently dropping it.
    return weights.map((_, i) =>
      i === 0 ? money(total.amount, total.currency) : zero(total.currency),
    );
  }

  const sign = total.amount < 0 ? -1 : 1;
  const magnitude = Math.abs(total.amount);

  const exact = weights.map((w) => (magnitude * w) / weightTotal);
  const floored = exact.map(Math.floor);
  let remainder = magnitude - floored.reduce((a, b) => a + b, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  const result = [...floored];
  for (const { index } of order) {
    if (remainder <= 0) break;
    result[index] = result[index]! + 1;
    remainder -= 1;
  }

  return result.map((amount) => money(sign * amount, total.currency));
}

/* ─────────────────────────── Presentation ───────────────────────────── */

export function toDecimalString(m: Money): string {
  const exponent = minorUnitExponent(m.currency);
  if (exponent === 0) return String(m.amount);
  const sign = m.amount < 0 ? '-' : '';
  const abs = Math.abs(m.amount).toString().padStart(exponent + 1, '0');
  return `${sign}${abs.slice(0, -exponent)}.${abs.slice(-exponent)}`;
}

export function fromDecimalString(value: string, currency: string): Money {
  const exponent = minorUnitExponent(currency);
  const cleaned = value.replace(/[^\d.-]/g, '');
  const negative = cleaned.startsWith('-');
  const [whole = '0', fraction = ''] = cleaned.replace('-', '').split('.');
  const padded = fraction.padEnd(exponent, '0').slice(0, exponent);
  const amount = Number(whole) * 10 ** exponent + (exponent > 0 ? Number(padded || '0') : 0);
  return money(negative ? -amount : amount, currency);
}

/**
 * Locale-aware display. Uses Intl, so the same amount renders as
 * "AED 4,199.00" under `en-AE` and "‏4,199.00 د.إ.‏" under `ar-AE` — symbol on
 * the other side, and wrapped in the RTL marks the bidi algorithm needs to keep
 * the number and symbol together inside Arabic text. Hand-rolled currency
 * formatting cannot do that, which is why it is banned here.
 */
export function format(m: Money, locale = 'en-AE'): string {
  const exponent = minorUnitExponent(m.currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: m.currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(m.amount / 10 ** exponent);
  } catch {
    // Unknown currency code — degrade to a readable form rather than throw
    // inside a render path.
    return `${m.currency} ${toDecimalString(m)}`;
  }
}
