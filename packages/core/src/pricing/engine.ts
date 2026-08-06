import {
  add,
  allocate,
  clampNonNegative,
  min as minMoney,
  money,
  multiply,
  percentage,
  subtract,
  sum,
  zero,
  type Money,
} from '../money';
import type {
  AppliedDiscount,
  DiscountInput,
  PricedLine,
  PricingContext,
  PricingLineInput,
  PricingResult,
  RejectedDiscount,
  TaxRule,
} from './types';

/**
 * THE PRICING ENGINE
 *
 * One pure function is the single source of truth for what an order costs. It
 * runs on the server when the cart changes, again when the checkout renders,
 * and once more immediately before authorising payment. The client never
 * computes a total that is trusted for anything.
 *
 * Why one deterministic pure function rather than incremental mutation of a
 * cart row: incremental totals drift. A coupon applied, then a line removed,
 * then the coupon's minimum no longer met — an incremental design has to
 * remember to undo, and eventually forgets. Recomputing from scratch means the
 * result is a function of the inputs alone, which also makes it trivially
 * testable and safe to run inside a retry.
 *
 * ORDER OF OPERATIONS (deliberate, and the source of most commerce bugs):
 *   1. Line subtotals               (qty × unit price)
 *   2. Line-scoped discounts        (product / category / brand / BXGY)
 *   3. Order-scoped discounts       (on the already-line-discounted subtotal)
 *   4. Shipping, then shipping discounts
 *   5. Tax, computed per line on the *post-discount* amount
 *   6. Stored value (gift card / store credit / loyalty) as tender, not discount
 *
 * Step 5 matters: taxing the pre-discount amount overcharges the customer and
 * is unlawful in most VAT regimes. Step 6 matters because a gift card is a
 * payment, not a price reduction — treating it as a discount understates
 * revenue and corrupts every margin report downstream.
 */
export function calculatePricing(
  lines: readonly PricingLineInput[],
  discounts: readonly DiscountInput[],
  context: PricingContext,
): PricingResult {
  const { currency } = context;

  const lineSubtotals = new Map<string, Money>(
    lines.map((line) => [line.id, multiply(line.unitPrice, line.quantity)]),
  );
  const subtotal = sum([...lineSubtotals.values()], currency);

  const lineDiscounts = new Map<string, Money>(lines.map((l) => [l.id, zero(currency)]));
  const applied: AppliedDiscount[] = [];
  const rejected: RejectedDiscount[] = [];

  const { eligible, rejected: initiallyRejected } = partitionEligible(
    discounts,
    lines,
    subtotal,
    context,
  );
  rejected.push(...initiallyRejected);

  /**
   * Non-stackable discounts are exclusive: the highest-priority one wins, and
   * ties break on the larger customer benefit. Letting several exclusive
   * discounts co-apply is the classic "stacked coupon" exploit that turns a
   * promotion into a giveaway.
   */
  const ordered = [...eligible].sort((a, b) => b.priority - a.priority);
  let exclusiveApplied = false;

  const shippingDiscounts: DiscountInput[] = [];

  for (const discount of ordered) {
    if (exclusiveApplied && !discount.isStackable) {
      rejected.push({
        discountId: discount.id,
        code: discount.code,
        reason: 'Cannot combine with an already-applied exclusive discount',
      });
      continue;
    }

    if (discount.type === 'free_shipping' || discount.scope === 'shipping') {
      shippingDiscounts.push(discount);
      if (!discount.isStackable) exclusiveApplied = true;
      continue;
    }

    const targeted = lines.filter((line) => discountTargets(discount, line));
    if (targeted.length === 0) {
      rejected.push({
        discountId: discount.id,
        code: discount.code,
        reason: 'No items in the cart match this discount',
      });
      continue;
    }

    // Discountable base excludes what previous discounts already took off,
    // so two stacked 50% coupons cannot drive a line below zero.
    const base = sum(
      targeted.map((line) =>
        clampNonNegative(subtract(lineSubtotals.get(line.id)!, lineDiscounts.get(line.id)!)),
      ),
      currency,
    );
    if (base.amount <= 0) {
      rejected.push({
        discountId: discount.id,
        code: discount.code,
        reason: 'Matching items are already fully discounted',
      });
      continue;
    }

    let amount = computeDiscountAmount(discount, targeted, lineSubtotals, base, currency);
    if (discount.maxDiscountAmount != null) {
      amount = minMoney(amount, money(discount.maxDiscountAmount, currency));
    }
    amount = minMoney(amount, base);
    if (amount.amount <= 0) {
      rejected.push({
        discountId: discount.id,
        code: discount.code,
        reason: 'Discount evaluates to zero for this cart',
      });
      continue;
    }

    // Split across the targeted lines proportionally to their remaining value.
    const weights = targeted.map(
      (line) =>
        clampNonNegative(subtract(lineSubtotals.get(line.id)!, lineDiscounts.get(line.id)!)).amount,
    );
    const parts = allocate(amount, weights);
    const allocations = new Map<string, Money>();
    targeted.forEach((line, i) => {
      const part = parts[i]!;
      allocations.set(line.id, part);
      lineDiscounts.set(line.id, add(lineDiscounts.get(line.id)!, part));
    });

    applied.push({
      discountId: discount.id,
      code: discount.code,
      name: discount.name,
      amount,
      scope: discount.scope,
      lineAllocations: allocations,
    });

    if (!discount.isStackable) exclusiveApplied = true;
  }

  /* ── Shipping ──────────────────────────────────────────────────────── */

  let shippingTotal = context.shippingCost;
  for (const discount of shippingDiscounts) {
    const reduction =
      discount.type === 'free_shipping'
        ? shippingTotal
        : discount.type === 'percentage'
          ? percentage(shippingTotal, discount.value)
          : minMoney(money(discount.value, currency), shippingTotal);
    if (reduction.amount <= 0) continue;
    shippingTotal = clampNonNegative(subtract(shippingTotal, reduction));
    applied.push({
      discountId: discount.id,
      code: discount.code,
      name: discount.name,
      amount: reduction,
      scope: 'shipping',
      lineAllocations: new Map(),
    });
  }

  /* ── Tax ───────────────────────────────────────────────────────────── */

  const lineTaxes = new Map<string, Money>();
  for (const line of lines) {
    const net = clampNonNegative(subtract(lineSubtotals.get(line.id)!, lineDiscounts.get(line.id)!));
    lineTaxes.set(line.id, taxFor(net, line.categoryIds, context.taxRules, currency));
  }

  const shippingTaxRule = context.taxRules.find((r) => r.appliesToShipping);
  const shippingTax = shippingTaxRule
    ? taxAmount(shippingTotal, shippingTaxRule, currency)
    : zero(currency);

  const taxTotal = add(sum([...lineTaxes.values()], currency), shippingTax);

  /* ── Totals ────────────────────────────────────────────────────────── */

  const discountTotal = sum(
    applied.map((a) => a.amount),
    currency,
  );

  // Inclusive tax is already inside the listed price; adding it again would
  // double-charge. Exclusive tax is added on top.
  const taxIsInclusive = context.taxRules.some((r) => r.isInclusive);
  const netSubtotal = clampNonNegative(subtract(subtotal, sumLineDiscounts(lineDiscounts, currency)));
  const total = clampNonNegative(
    taxIsInclusive
      ? add(netSubtotal, shippingTotal)
      : add(add(netSubtotal, shippingTotal), taxTotal),
  );

  /* ── Stored value is tender, not discount ──────────────────────────── */

  const loyaltyValue =
    context.loyaltyPointsRedeemed && context.loyaltyPointValue
      ? multiply(context.loyaltyPointValue, context.loyaltyPointsRedeemed)
      : zero(currency);

  const tender = sum(
    [context.storeCreditApplied ?? zero(currency), context.giftCardApplied ?? zero(currency), loyaltyValue],
    currency,
  );
  const amountDue = clampNonNegative(subtract(total, minMoney(tender, total)));

  /* ── Per-line output & margin ──────────────────────────────────────── */

  const pricedLines: PricedLine[] = lines.map((line) => {
    const lineSubtotal = lineSubtotals.get(line.id)!;
    const discount = lineDiscounts.get(line.id)!;
    const tax = lineTaxes.get(line.id)!;
    const net = clampNonNegative(subtract(lineSubtotal, discount));
    const costTotal = line.unitCost ? multiply(line.unitCost, line.quantity) : zero(currency);
    const lineTotal = taxIsInclusive ? net : add(net, tax);

    return {
      id: line.id,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineSubtotal,
      discountTotal: discount,
      taxTotal: tax,
      lineTotal,
      costTotal,
      marginBps: marginBps(net, costTotal),
    };
  });

  const costTotal = sum(
    pricedLines.map((l) => l.costTotal),
    currency,
  );

  return {
    currency,
    lines: pricedLines,
    subtotal,
    discountTotal,
    shippingTotal,
    taxTotal,
    total,
    amountDue,
    costTotal,
    marginBps: marginBps(netSubtotal, costTotal),
    appliedDiscounts: applied,
    rejectedDiscounts: rejected,
  };
}

/* ───────────────────────────── Internals ────────────────────────────── */

function sumLineDiscounts(lineDiscounts: ReadonlyMap<string, Money>, currency: string): Money {
  return sum([...lineDiscounts.values()], currency);
}

function partitionEligible(
  discounts: readonly DiscountInput[],
  lines: readonly PricingLineInput[],
  subtotal: Money,
  context: PricingContext,
): { eligible: DiscountInput[]; rejected: RejectedDiscount[] } {
  const eligible: DiscountInput[] = [];
  const rejected: RejectedDiscount[] = [];
  const totalQuantity = lines.reduce((n, l) => n + l.quantity, 0);

  for (const d of discounts) {
    const reason = ineligibilityReason(d, subtotal, totalQuantity, context);
    if (reason) rejected.push({ discountId: d.id, code: d.code, reason });
    else eligible.push(d);
  }
  return { eligible, rejected };
}

/**
 * Returns a *customer-readable* reason, or null when eligible. These strings go
 * straight into the checkout UI: "Spend AED 500 more to use SAVE15" converts far
 * better than a generic "invalid coupon", which reads as an accusation.
 */
function ineligibilityReason(
  d: DiscountInput,
  subtotal: Money,
  totalQuantity: number,
  context: PricingContext,
): string | null {
  const { now } = context;
  if (d.startsAt && now < d.startsAt) return 'This offer has not started yet';
  if (d.endsAt && now > d.endsAt) return 'This offer has expired';
  if (d.usageLimit != null && (d.usageCount ?? 0) >= d.usageLimit)
    return 'This offer has reached its usage limit';

  const c = d.conditions;
  if (c.minSubtotal != null && subtotal.amount < c.minSubtotal) {
    const shortfall = c.minSubtotal - subtotal.amount;
    return `Add ${(shortfall / 100).toFixed(2)} more to qualify`;
  }
  if (c.minQuantity != null && totalQuantity < c.minQuantity)
    return `Requires at least ${c.minQuantity} items`;
  if (c.firstOrderOnly && !context.isFirstOrder) return 'Valid on your first order only';
  if (c.channels?.length && !c.channels.includes(context.channel))
    return 'Not available on this channel';
  if (
    c.paymentProviders?.length &&
    context.paymentProvider &&
    !c.paymentProviders.includes(context.paymentProvider)
  )
    return 'Not available with the selected payment method';
  if (
    c.customerSegments?.length &&
    !c.customerSegments.some((s) => context.customerSegments.includes(s))
  )
    return 'Not available for your account';

  return null;
}

function discountTargets(d: DiscountInput, line: PricingLineInput): boolean {
  const c = d.conditions;
  if (d.scope === 'order') return true;
  if (c.variantIds?.length) return c.variantIds.includes(line.variantId);
  if (c.productIds?.length) return c.productIds.includes(line.productId);
  if (c.categoryIds?.length) return line.categoryIds.some((id) => c.categoryIds!.includes(id));
  if (c.brandIds?.length) return Boolean(line.brandId && c.brandIds.includes(line.brandId));
  // A scoped discount with no targeting rules would silently become an
  // order-wide discount. Refuse to match rather than give away the store.
  return false;
}

function computeDiscountAmount(
  d: DiscountInput,
  targeted: readonly PricingLineInput[],
  lineSubtotals: ReadonlyMap<string, Money>,
  base: Money,
  currency: string,
): Money {
  switch (d.type) {
    case 'percentage':
      return percentage(base, d.value);
    case 'fixed_amount':
      return money(d.value, currency);
    case 'bundle':
      return percentage(base, d.value);
    case 'buy_x_get_y':
      return buyXGetY(d, targeted, lineSubtotals, currency);
    case 'free_shipping':
      return zero(currency);
    default:
      return zero(currency);
  }
}

/**
 * "Buy 2 get 1 at 100% off" and friends.
 *
 * The cheapest qualifying units are the ones discounted — this is both the
 * industry convention and the interpretation that protects margin. Expanding
 * lines into individual units keeps the logic obvious at the cost of an array
 * proportional to cart quantity, which is bounded by the per-line quantity cap.
 */
function buyXGetY(
  d: DiscountInput,
  targeted: readonly PricingLineInput[],
  lineSubtotals: ReadonlyMap<string, Money>,
  currency: string,
): Money {
  const buyQty = d.conditions.buyQuantity ?? 1;
  const getQty = d.conditions.getQuantity ?? 1;
  const getBps = d.conditions.getDiscountBps ?? 10_000;
  if (buyQty <= 0 || getQty <= 0) return zero(currency);

  const units: number[] = [];
  for (const line of targeted) {
    const unit = Math.round(lineSubtotals.get(line.id)!.amount / line.quantity);
    for (let i = 0; i < line.quantity; i += 1) units.push(unit);
  }
  units.sort((a, b) => a - b);

  const sets = Math.floor(units.length / (buyQty + getQty));
  const freeUnits = sets * getQty;

  let total = 0;
  for (let i = 0; i < freeUnits && i < units.length; i += 1) {
    total += Math.round((units[i]! * getBps) / 10_000);
  }
  return money(total, currency);
}

function taxFor(
  net: Money,
  categoryIds: readonly string[],
  rules: readonly TaxRule[],
  currency: string,
): Money {
  // Most specific rule wins: a category-scoped rule beats the catch-all.
  const rule =
    rules.find((r) => r.categoryIds?.some((id) => categoryIds.includes(id))) ??
    rules.find((r) => !r.categoryIds?.length);
  if (!rule) return zero(currency);
  return taxAmount(net, rule, currency);
}

function taxAmount(amount: Money, rule: TaxRule, currency: string): Money {
  if (amount.amount <= 0) return zero(currency);
  if (rule.isInclusive) {
    // Extract the tax already contained in the price:
    //   tax = gross × rate / (10000 + rate)
    return money(
      Math.round((amount.amount * rule.rateBps) / (10_000 + rule.rateBps)),
      currency,
    );
  }
  return percentage(amount, rule.rateBps);
}

/** Gross margin in basis points, or null when cost is unknown. */
function marginBps(revenue: Money, cost: Money): number | null {
  if (cost.amount <= 0 || revenue.amount <= 0) return null;
  return Math.round(((revenue.amount - cost.amount) / revenue.amount) * 10_000);
}
