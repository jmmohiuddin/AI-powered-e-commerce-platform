import { money, type Money } from '../money';
import type { TaxRule } from '../pricing/types';

/**
 * UNITED ARAB EMIRATES — market configuration
 *
 * Everything in this file encodes a rule that differs from the generic
 * commerce defaults and that gets a store in trouble if it is wrong. The
 * differences are not cosmetic: UAE has no postal-code system, consumer prices
 * are legally required to be VAT-inclusive, and a compliant tax invoice must
 * carry a TRN. A platform localised only by swapping the currency symbol fails
 * all three.
 *
 * ⚠️ VAT rates, registration thresholds and invoice requirements are set by the
 * Federal Tax Authority and do change. The values here are the position as
 * built and are wired as *configuration*, not constants baked into logic — the
 * merchant's accountant confirms them, and changing one is a settings edit.
 */

export const UAE = {
  countryCode: 'AE',
  currency: 'AED',
  /** Fils. 100 fils = 1 dirham. */
  minorUnitExponent: 2,
  timezone: 'Asia/Dubai',
  /** UTC+4 year-round — no daylight saving, which simplifies every schedule. */
  utcOffsetMinutes: 240,
  defaultLocale: 'en-AE',
  supportedLocales: ['en-AE', 'ar-AE'] as const,
  callingCode: '+971',
  /**
   * The working week moved to Monday–Friday with a Saturday–Sunday weekend in
   * January 2022. This matters operationally, not trivially: courier pickup
   * windows, supplier lead times and "dispatched today" cut-offs are all
   * calculated against it, and a system assuming a Friday–Saturday weekend
   * quietly promises deliveries that cannot happen.
   */
  weekendDays: [6, 0] as const,
} as const;

/* ──────────────────────────────── VAT ───────────────────────────────── */

/**
 * UAE VAT is 5%, and consumer-facing displayed prices must be **inclusive** of
 * it. This is the single most consequential difference from a US-style
 * sales-tax model, and getting it backwards is a silent 5% margin error in one
 * direction or a consumer-protection breach in the other.
 *
 * Concretely: a phone displayed at AED 4,199 is AED 3,999.05 net plus AED
 * 199.95 VAT — the tax is *extracted* from the shelf price, never added at
 * checkout. The pricing engine already implements both modes; this rule
 * selects the correct one.
 */
export const UAE_VAT_RATE_BPS = 500;

export const UAE_STANDARD_VAT: TaxRule = {
  id: 'ae-vat-standard',
  name: 'UAE VAT 5%',
  rateBps: UAE_VAT_RATE_BPS,
  isInclusive: true,
  appliesToShipping: true,
};

/**
 * Zero-rated exports. A sale shipped outside the GCC VAT territory is zero-rated
 * rather than exempt — the distinction matters because zero-rated sales still
 * allow input-VAT recovery and still appear on the return.
 *
 * Applying this correctly requires evidence of export, which is an operational
 * requirement on the merchant, not something software can assert. Flagged here
 * so the fulfilment flow captures it rather than discovering it at audit.
 */
export const UAE_ZERO_RATED: TaxRule = {
  id: 'ae-vat-zero',
  name: 'Zero-rated export',
  rateBps: 0,
  isInclusive: true,
  appliesToShipping: false,
};

/** Mandatory VAT registration threshold: AED 375,000 taxable supplies / 12 months. */
export const VAT_MANDATORY_THRESHOLD = money(37_500_000, 'AED');
/** Voluntary registration threshold: AED 187,500. */
export const VAT_VOLUNTARY_THRESHOLD = money(18_750_000, 'AED');

/**
 * Extracts the VAT component from a VAT-inclusive amount.
 *
 *   vat = gross × rate / (10000 + rate)
 *
 * Needed on every tax invoice, because a compliant invoice must state the
 * taxable amount and the VAT amount separately even though the customer only
 * ever saw one number.
 */
export function extractVat(grossAmount: Money, rateBps = UAE_VAT_RATE_BPS): Money {
  return money(
    Math.round((grossAmount.amount * rateBps) / (10_000 + rateBps)),
    grossAmount.currency,
  );
}

export function netOfVat(grossAmount: Money, rateBps = UAE_VAT_RATE_BPS): Money {
  return money(grossAmount.amount - extractVat(grossAmount, rateBps).amount, grossAmount.currency);
}

/**
 * A UAE Tax Registration Number is 15 digits. Validating the format prevents
 * the most common invoice defect — a typo'd or absent TRN makes the document
 * non-compliant and unusable by a business customer claiming input VAT.
 *
 * Format only. Confirming the TRN belongs to the merchant requires the FTA's
 * verification service and is a onboarding step, not a request-time check.
 */
export function isValidTrn(trn: string): boolean {
  return /^\d{15}$/.test(trn.replace(/[\s-]/g, ''));
}

export function formatTrn(trn: string): string {
  const digits = trn.replace(/\D/g, '');
  return digits.replace(/(\d{3})(?=\d)/g, '$1 ').trim();
}

/**
 * Fields a UAE tax invoice must carry. Encoded as a checklist so the invoice
 * template cannot silently drop one — an invoice missing the supplier TRN or
 * the VAT amount is not a tax invoice, and a B2B customer will reject it.
 */
export const TAX_INVOICE_REQUIRED_FIELDS = [
  'supplierName',
  'supplierAddress',
  'supplierTrn',
  'invoiceNumber',
  'invoiceDate',
  'lineDescription',
  'taxableAmount',
  'vatRate',
  'vatAmount',
  'grossTotal',
] as const;

/**
 * Above this consideration, a supply requires a FULL tax invoice even to a
 * consumer. Below it, and only when the buyer is not a business, a simplified
 * invoice is permitted (Art. 59(5) of the VAT Executive Regulations).
 *
 * AED 10,000, in fils. A threshold, not a rounding — a supply *at* 10,000 is
 * not above it.
 */
export const FULL_TAX_INVOICE_THRESHOLD = money(1_000_000, 'AED');

/**
 * Which document a supply legally requires.
 *
 * Two triggers, either of which forces the full form: the buyer is a business
 * (they gave a TRN, and they cannot reclaim input VAT without a full invoice),
 * or the consideration exceeds the threshold above.
 *
 * Deliberately a pure function of the facts rather than a caller's choice —
 * `packages/invoicing` builds every document through it, so nothing in the
 * system is able to decide for itself that it is a tax invoice.
 */
export function requiredInvoiceKind(input: {
  grossTotal: Money;
  recipientTrn?: string | null;
}): 'tax' | 'simplified' {
  if (input.recipientTrn && isValidTrn(input.recipientTrn)) return 'tax';
  return input.grossTotal.amount > FULL_TAX_INVOICE_THRESHOLD.amount ? 'tax' : 'simplified';
}

/* ───────────────────────────── Addresses ────────────────────────────── */

/**
 * THE UAE HAS NO POSTAL CODE SYSTEM.
 *
 * This is the localisation detail that breaks more imported checkout flows than
 * anything else. A required postal-code field either blocks the order or
 * trains every customer to type "00000", which then defeats address
 * validation, courier zone lookup and fraud scoring simultaneously.
 *
 * What UAE addresses actually use:
 *   • Emirate (mandatory — drives courier zone and delivery fee)
 *   • Area / community (Al Barsha, Jumeirah, Dubai Marina…)
 *   • Building name + flat/villa number
 *   • Makani — a 10-digit Dubai geo-address that resolves to a building
 *     entrance. Where present it is more reliable than any written address,
 *     and couriers use it directly.
 *   • PO Box — for business deliveries; never sufficient for a courier drop.
 */
export const EMIRATES = [
  { code: 'AZ', name: 'Abu Dhabi', nameAr: 'أبو ظبي' },
  { code: 'DU', name: 'Dubai', nameAr: 'دبي' },
  { code: 'SH', name: 'Sharjah', nameAr: 'الشارقة' },
  { code: 'AJ', name: 'Ajman', nameAr: 'عجمان' },
  { code: 'UQ', name: 'Umm Al Quwain', nameAr: 'أم القيوين' },
  { code: 'RK', name: 'Ras Al Khaimah', nameAr: 'رأس الخيمة' },
  { code: 'FU', name: 'Fujairah', nameAr: 'الفجيرة' },
] as const;

export type EmirateCode = (typeof EMIRATES)[number]['code'];

export function isEmirateCode(value: string): value is EmirateCode {
  return EMIRATES.some((e) => e.code === value);
}

/** Makani is exactly 10 digits, conventionally shown as 5 + 5. */
export function isValidMakani(value: string): boolean {
  return /^\d{10}$/.test(value.replace(/[\s-]/g, ''));
}

export function formatMakani(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length === 10 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : digits;
}

export interface UaeAddress {
  readonly recipientName: string;
  readonly phone: string;
  readonly emirate: EmirateCode;
  readonly area: string;
  readonly buildingName?: string;
  readonly flatOrVilla?: string;
  readonly street?: string;
  readonly makani?: string;
  readonly poBox?: string;
  readonly landmark?: string;
}

/**
 * Validates deliverability, not form completeness.
 *
 * The question this answers is "can a courier find this", which is different
 * from "are the required fields filled". A Makani number alone is deliverable;
 * a PO Box alone is not, however complete the rest of the form looks.
 */
export function validateAddress(address: Partial<UaeAddress>): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!address.recipientName?.trim()) errors.push('Recipient name is required');
  if (!address.phone || !isValidUaePhone(address.phone)) {
    errors.push('A valid UAE mobile number is required');
  }
  if (!address.emirate || !isEmirateCode(address.emirate)) errors.push('Select an emirate');
  if (!address.area?.trim()) errors.push('Area or community is required');

  const hasMakani = Boolean(address.makani && isValidMakani(address.makani));
  const hasBuilding = Boolean(address.buildingName?.trim());

  if (!hasMakani && !hasBuilding) {
    errors.push('Enter a building name or a Makani number so the courier can find you');
  }
  if (address.makani && !isValidMakani(address.makani)) {
    errors.push('A Makani number is 10 digits');
  }
  if (!hasMakani && address.emirate === 'DU') {
    // Advisory, not blocking: Makani measurably reduces failed first-attempt
    // deliveries in Dubai, and a failed attempt costs the merchant a redelivery.
    warnings.push('Adding a Makani number makes delivery faster and more reliable');
  }
  if (address.poBox && !hasBuilding && !hasMakani) {
    warnings.push('A PO Box cannot be used for courier delivery — add a physical address');
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * UAE mobile numbers. Accepts the formats customers actually type:
 * 0501234567, 501234567, +971501234567, 00971 50 123 4567.
 *
 * Mobile prefixes in service: 50, 52, 54, 55, 56, 58.
 */
export function isValidUaePhone(input: string): boolean {
  return normaliseUaePhone(input) !== null;
}

/** Returns E.164 (+9715XXXXXXXX) or null. E.164 is what gateways and SMS want. */
export function normaliseUaePhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, '').replace(/^\+/, '').replace(/^00/, '');
  const national = digits.startsWith('971')
    ? digits.slice(3)
    : digits.startsWith('0')
      ? digits.slice(1)
      : digits;

  if (!/^5[024568]\d{7}$/.test(national)) return null;
  return `+971${national}`;
}

export function formatUaePhone(input: string): string {
  const e164 = normaliseUaePhone(input);
  if (!e164) return input;
  const n = e164.slice(4);
  return `+971 ${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5)}`;
}

/* ─────────────────────────── Delivery zones ─────────────────────────── */

/**
 * Delivery expectations by emirate.
 *
 * These drive the promise shown at checkout, and a promise the courier cannot
 * meet is worse than a longer honest one — a missed delivery date is the
 * single largest driver of "where is my order" contacts.
 *
 * `sameDayCutoffHour` is local time. Set conservatively: the cost of promising
 * same-day and missing it exceeds the conversion gained by an optimistic
 * cut-off.
 */
export const DELIVERY_ZONES: Record<
  EmirateCode,
  { standardDays: number; expressAvailable: boolean; sameDayCutoffHour: number | null }
> = {
  DU: { standardDays: 1, expressAvailable: true, sameDayCutoffHour: 14 },
  AZ: { standardDays: 2, expressAvailable: true, sameDayCutoffHour: 12 },
  SH: { standardDays: 1, expressAvailable: true, sameDayCutoffHour: 12 },
  AJ: { standardDays: 2, expressAvailable: false, sameDayCutoffHour: null },
  UQ: { standardDays: 2, expressAvailable: false, sameDayCutoffHour: null },
  RK: { standardDays: 3, expressAvailable: false, sameDayCutoffHour: null },
  FU: { standardDays: 3, expressAvailable: false, sameDayCutoffHour: null },
};

/**
 * Working-day aware delivery estimate.
 *
 * Skips Saturday and Sunday, because a courier that does not collect on the
 * weekend makes a Thursday-evening order a Tuesday delivery, not a Saturday
 * one. Public holidays (Eid, National Day) shift by the lunar calendar and are
 * supplied as configuration rather than hardcoded — a hardcoded Eid date is
 * wrong within a year.
 */
export function estimateDelivery(
  emirate: EmirateCode,
  orderedAt: Date,
  options: { express?: boolean; holidays?: readonly string[] } = {},
): { estimatedAt: Date; sameDay: boolean; workingDays: number } {
  const zone = DELIVERY_ZONES[emirate];
  const holidays = new Set(options.holidays ?? []);

  const localHour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: UAE.timezone,
      hour: '2-digit',
      hour12: false,
    }).format(orderedAt),
  );

  const sameDay =
    zone.sameDayCutoffHour != null &&
    localHour < zone.sameDayCutoffHour &&
    !isNonWorkingDay(orderedAt, holidays);

  if (sameDay) return { estimatedAt: orderedAt, sameDay: true, workingDays: 0 };

  const targetDays = options.express && zone.expressAvailable ? 1 : zone.standardDays;
  const cursor = new Date(orderedAt);
  let counted = 0;

  while (counted < targetDays) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (!isNonWorkingDay(cursor, holidays)) counted += 1;
  }

  return { estimatedAt: cursor, sameDay: false, workingDays: counted };
}

function isNonWorkingDay(date: Date, holidays: ReadonlySet<string>): boolean {
  const iso = date.toISOString().slice(0, 10);
  if (holidays.has(iso)) return true;
  const day = date.getUTCDay();
  return day === 6 || day === 0;
}

/* ─────────────────────────── Consumer rights ────────────────────────── */

/**
 * UAE Federal Law No. 15 of 2020 on Consumer Protection gives buyers repair,
 * replacement or refund rights on defective goods. It does not mandate a
 * blanket cooling-off return window for all e-commerce, so the window below is
 * a *merchant policy* — set generously because in this market return policy is
 * a competitive signal, and stated plainly because an ambiguous policy
 * generates disputes.
 *
 * Not legal advice; the merchant's own terms govern.
 */

/** The window as shipped, and the value used whenever the override is absent or unusable. */
export const DEFAULT_CHANGE_OF_MIND_DAYS = 14;

/**
 * The change-of-mind window, in days.
 *
 * CONFIGURATION, NOT A CONSTANT — and the reason is specific rather than
 * stylistic. The 14-day cooling-off right for online purchases is widely
 * reported but was **not found in the primary text** of the sources reviewed
 * (PRD requirement L-06, open question Q-08). Counsel has to confirm it against
 * Cabinet Decision 66/2023, and when they do the answer may be a different
 * number or none at all.
 *
 * A number that legal may correct must not require a code change to correct.
 * `RETURNS_CHANGE_OF_MIND_DAYS` is read on every access rather than captured at
 * module load, so the deployed window follows the environment across a restart
 * with nothing rebuilt and nothing redeployed.
 *
 * A malformed value falls back to the default rather than throwing. This number
 * renders the published returns policy and gates the returns workflow: a typo
 * in an env file should quietly mean "the policy we shipped", not take the
 * storefront down or — far worse — silently publish a nonsense window like
 * `NaN` or `-3` days to customers.
 */
export function changeOfMindWindowDays(): number {
  const raw = process.env.RETURNS_CHANGE_OF_MIND_DAYS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_CHANGE_OF_MIND_DAYS;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.warn(
      '[uae] RETURNS_CHANGE_OF_MIND_DAYS=%s is not a whole number of days; using %d',
      raw,
      DEFAULT_CHANGE_OF_MIND_DAYS,
    );
    return DEFAULT_CHANGE_OF_MIND_DAYS;
  }
  return parsed;
}

export const RETURN_POLICY = {
  /**
   * A getter, so every reader — the published policy page and the returns
   * workflow alike — resolves the configured window at the moment it is read.
   * A plain property would freeze whatever the environment said when this
   * module was first imported, which is the failure this requirement exists to
   * prevent: a policy page and a workflow that disagree about the same number.
   */
  get changeOfMindDays(): number {
    return changeOfMindWindowDays();
  },
  /**
   * Not configurable. This one tracks the statutory defective-goods right under
   * Federal Law 15/2020 rather than a merchant choice, so it is not an env knob
   * somebody can shorten to save money.
   */
  defectiveGoodsDays: 30,
  /** Sealed software, personalised items, and opened earphones on hygiene grounds. */
  nonReturnableCategories: ['software', 'personalised', 'in-ear-audio-opened'] as const,
  /** Who pays return shipping when the fault is the merchant's. */
  merchantPaysReturnShippingOnDefect: true,
} as const;
