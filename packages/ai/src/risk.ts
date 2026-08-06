/**
 * ORDER RISK SCORING
 *
 * Explainable by construction: the score is a sum of named, weighted signals,
 * and every assessment carries the list of signals that produced it.
 *
 * Two reasons this is not a black-box model:
 *
 *  1. **The merchant has to act on it.** "Risk 87" tells a shop owner nothing.
 *     "First-time customer, AED 140,000 order, unverified phone, delivery address
 *     500 km from any previous order" tells them to make a phone call.
 *  2. **The customer can be wrong-footed by it.** An automated decision that
 *     refuses someone cash on delivery with no stated reason is unappealable,
 *     and in several jurisdictions unlawful. Every rejection here produces a
 *     reason the merchant can read out loud.
 *
 * THE FRAUD MODEL IS REGIONAL, AND THIS ONE IS TUNED FOR THE UAE.
 *
 * The UAE is a card-and-wallet market with a shrinking but still real cash-on-
 * delivery tail, so two loss modes run in parallel and the model has to weight
 * both:
 *
 *  • **Card-not-present fraud** — the dominant loss on prepaid orders. A stolen
 *    card buys a resellable handset shipped to a freight forwarder or a
 *    short-let address. The signals are velocity, a mismatch between billing
 *    and delivery, a brand-new account, and a cart of high-resale goods.
 *    Chargebacks land months later and cost the goods plus a fee plus the
 *    scheme's attention.
 *
 *  • **COD refusal** — the loss on the cash tail. Nobody steals anything; the
 *    parcel is picked, packed, carried, refused and returned, and the merchant
 *    eats round-trip freight while the unit was unavailable for a week.
 *
 * The UAE adds two signals that do not exist elsewhere. Freight-forwarder
 * delivery addresses are a strong re-export indicator on high-value
 * electronics. And a delivery address in a different emirate from every prior
 * order is meaningful in a way it would not be in a larger country, because the
 * whole country is a few hours across — a genuine customer rarely switches
 * emirate between orders.
 *
 * Weights are a starting calibration, not received truth. `riskAssessments`
 * records the outcome of every decision so they can be re-fit against real
 * labels once a merchant has enough history — the honest version of "AI fraud
 * detection" is a model trained on your own chargebacks, not a vendor's prior.
 */

export interface RiskSignalInput {
  readonly isFirstOrder: boolean;
  readonly customerOrderCount: number;
  readonly customerRefusedDeliveries: number;
  readonly customerChargebacks: number;
  readonly phoneVerified: boolean;
  readonly emailVerified: boolean;
  /** Minor units. */
  readonly orderTotal: number;
  /** Customer's historical average order value, minor units. */
  readonly averageOrderValue: number | null;
  readonly paymentProvider: string;
  /** Minutes between account creation and this order. */
  readonly accountAgeMinutes: number | null;
  /** Orders placed by this customer in the last hour. */
  readonly recentOrderVelocity: number;
  /** Distinct addresses used by this customer in the last 30 days. */
  readonly distinctRecentAddresses: number;
  /** True when shipping and billing disagree beyond a plausible margin. */
  readonly addressMismatch: boolean;
  /** True when the cart is dominated by easily-resold high-value goods. */
  readonly highResaleValueCart: boolean;
  readonly shippingAddressIncomplete: boolean;

  /* ── UAE-specific ─────────────────────────────────────────────────── */
  /** Delivery address matches a known freight forwarder or re-export agent. */
  readonly freightForwarderAddress?: boolean;
  /** Emirate differs from every previous delivery for this customer. */
  readonly newEmirateForCustomer?: boolean;
  /** Issuing country of the card, when the gateway reports it. */
  readonly cardIssuerCountry?: string;
  /** 3-D Secure outcome: 'authenticated' | 'attempted' | 'failed' | 'unavailable'. */
  readonly threeDSecureResult?: string;
}

export interface RiskSignal {
  readonly code: string;
  readonly description: string;
  readonly weight: number;
}

export type RiskDecision = 'allow' | 'review' | 'require_advance_payment' | 'block';

export interface RiskAssessment {
  /** 0–100. Clamped, so weights can be tuned without breaking the scale. */
  readonly score: number;
  readonly decision: RiskDecision;
  readonly signals: readonly RiskSignal[];
  /** Plain-language reason, safe to show the merchant. */
  readonly explanation: string;
}

export function assessOrderRisk(input: RiskSignalInput): RiskAssessment {
  const signals: RiskSignal[] = [];
  // Negative weights are meaningful — a clean order history is evidence, and
  // dropping it would make every long-standing customer look like a stranger.
  const add = (code: string, description: string, weight: number) => {
    if (weight !== 0) signals.push({ code, description, weight });
  };

  /* ── History: the strongest predictor there is ─────────────────────── */

  if (input.customerChargebacks > 0) {
    add(
      'prior_chargeback',
      `${input.customerChargebacks} previous chargeback(s)`,
      Math.min(45, 25 + input.customerChargebacks * 10),
    );
  }
  if (input.customerRefusedDeliveries > 0) {
    add(
      'prior_refusal',
      `${input.customerRefusedDeliveries} previously refused deliver${input.customerRefusedDeliveries === 1 ? 'y' : 'ies'}`,
      Math.min(40, input.customerRefusedDeliveries * 18),
    );
  }
  // A long clean history is the best evidence available; it subtracts risk.
  if (input.customerOrderCount >= 5 && input.customerRefusedDeliveries === 0) {
    add('established_customer', `${input.customerOrderCount} completed orders, none refused`, -20);
  }

  /* ── Identity ──────────────────────────────────────────────────────── */

  if (!input.phoneVerified) {
    // Weighted heavily for COD, where the phone number is the only way to
    // reach the buyer before dispatch.
    add('phone_unverified', 'Phone number not verified', input.paymentProvider === 'cod' ? 18 : 8);
  }
  if (!input.emailVerified && input.paymentProvider !== 'cod') {
    add('email_unverified', 'Email address not verified', 6);
  }
  if (input.accountAgeMinutes != null && input.accountAgeMinutes < 15) {
    add('account_minutes_old', 'Account created minutes before ordering', 12);
  }

  /* ── Order shape ───────────────────────────────────────────────────── */

  if (input.isFirstOrder && input.orderTotal > 5_000_000) {
    add('first_order_high_value', 'First order above AED 50,000', 20);
  }
  if (input.averageOrderValue && input.averageOrderValue > 0) {
    const ratio = input.orderTotal / input.averageOrderValue;
    if (ratio >= 5) {
      add('value_anomaly', `Order is ${ratio.toFixed(1)}× this customer's usual value`, 15);
    }
  }
  if (input.highResaleValueCart && input.paymentProvider === 'cod') {
    add('resale_cart_cod', 'High-resale-value goods on cash on delivery', 12);
  }

  /* ── Behaviour ─────────────────────────────────────────────────────── */

  if (input.recentOrderVelocity >= 4) {
    add('order_velocity', `${input.recentOrderVelocity} orders in the last hour`, 18);
  }
  if (input.distinctRecentAddresses >= 4) {
    add('address_churn', `${input.distinctRecentAddresses} delivery addresses in 30 days`, 14);
  }
  if (input.addressMismatch) {
    add('address_mismatch', 'Billing and delivery addresses differ significantly', 8);
  }

  /* ── UAE-specific signals ──────────────────────────────────────────── */

  if (input.freightForwarderAddress) {
    // Not fraud by itself — plenty of legitimate customers re-export. But
    // combined with a first order and a high-value cart it is the strongest
    // single indicator of a chargeback the merchant will lose, because the
    // goods leave the country before the dispute arrives.
    add('freight_forwarder', 'Delivery to a freight forwarder or re-export agent', 16);
  }
  if (input.newEmirateForCustomer && input.customerOrderCount > 0) {
    add('new_emirate', 'Delivery emirate differs from all previous orders', 8);
  }
  if (input.cardIssuerCountry && input.cardIssuerCountry !== 'AE') {
    // Weak on its own: the UAE population is overwhelmingly expatriate and
    // foreign-issued cards are entirely ordinary. It earns its weight only
    // when it stacks with other signals, which the additive model handles.
    add('foreign_card', `Card issued outside the UAE (${input.cardIssuerCountry})`, 5);
  }
  if (input.threeDSecureResult === 'failed') {
    add('3ds_failed', '3-D Secure authentication failed', 22);
  } else if (input.threeDSecureResult === 'authenticated') {
    // A successful 3DS shifts chargeback liability to the issuer. That is a
    // real reduction in the merchant's exposure and the score should say so.
    add('3ds_authenticated', '3-D Secure authenticated — liability shifted', -18);
  }
  if (input.shippingAddressIncomplete) {
    // Not fraud so much as a failed delivery waiting to happen — and it costs
    // the merchant exactly the same amount.
    add('incomplete_address', 'Delivery address is missing detail needed to deliver', 10);
  }

  const raw = signals.reduce((total, s) => total + s.weight, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  return {
    score,
    decision: decide(score, input),
    signals,
    explanation: explain(score, signals),
  };
}

/**
 * Decision thresholds.
 *
 * `require_advance_payment` exists because outright blocking is almost always
 * the wrong call: most high-risk COD orders are real customers who would
 * happily pay online if asked. Blocking loses the sale; asking for a deposit
 * converts it *and* removes the risk. Blocking is reserved for the narrow band
 * where the customer has already cost the merchant money.
 */
function decide(score: number, input: RiskSignalInput): RiskDecision {
  if (input.customerChargebacks >= 2) return 'block';
  if (score >= 80) return 'block';
  if (score >= 50) return input.paymentProvider === 'cod' ? 'require_advance_payment' : 'review';
  if (score >= 30) return 'review';
  return 'allow';
}

function explain(score: number, signals: readonly RiskSignal[]): string {
  if (signals.length === 0) return 'No risk signals detected.';
  const contributing = signals
    .filter((s) => s.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((s) => s.description);
  if (contributing.length === 0) return `Low risk (${score}): established customer history.`;
  return `Risk ${score}. Main factors: ${contributing.join('; ')}.`;
}

/**
 * Customer segmentation from behavioural facts — RFM plus a couple of
 * commerce-specific axes.
 *
 * Rule-based rather than clustered, deliberately: a merchant needs to know
 * *why* a customer is in a segment before they will send that segment a
 * campaign, and "cluster 4" does not survive that conversation. Once a merchant
 * has enough history, these become labelled training data for a real model.
 */
export interface SegmentInput {
  readonly orderCount: number;
  readonly daysSinceLastOrder: number | null;
  readonly lifetimeValue: number;
  readonly averageOrderValue: number;
  readonly discountedOrderShare: number;
  readonly accessoryOrderShare: number;
  readonly returnRate: number;
}

export function segmentCustomer(input: SegmentInput): string[] {
  const segments: string[] = [];
  const { orderCount, daysSinceLastOrder, lifetimeValue, averageOrderValue } = input;

  if (orderCount === 0) segments.push('prospect');
  else if (orderCount === 1) segments.push('first_time');
  else if (orderCount >= 5) segments.push('loyal');
  else segments.push('repeat');

  if (daysSinceLastOrder != null) {
    if (daysSinceLastOrder <= 30) segments.push('active');
    else if (daysSinceLastOrder <= 120) segments.push('cooling');
    // 120+ days without a purchase in a category people buy from every few
    // months means they are buying somewhere else.
    else segments.push('at_risk');
  }

  if (lifetimeValue >= 20_000_000) segments.push('vip');
  if (averageOrderValue >= 8_000_000) segments.push('high_basket');
  if (input.discountedOrderShare >= 0.7 && orderCount >= 3) segments.push('price_sensitive');
  if (input.accessoryOrderShare >= 0.6) segments.push('accessory_buyer');
  if (input.returnRate >= 0.3 && orderCount >= 3) segments.push('high_return');

  return segments;
}
