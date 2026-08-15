import { sql } from 'drizzle-orm';
import { uuidv7 } from '@voltix/db';
import type { UaeAddress } from '@voltix/core';
import { assessOrderRisk, type RiskAssessment, type RiskSignalInput } from '@voltix/ai';
import type { TenantContext, Tx } from './types';

/**
 * RISK SCORING, WIRED TO REAL DATA.
 *
 * `assessOrderRisk` in @voltix/ai is a pure function over a bag of signals, and
 * it was complete and unreachable: nothing computed the signals, so nothing ever
 * called it, and the cash-on-delivery risk gate — the control the whole COD
 * refusal problem rests on — sat there accepting a `customerRiskScore` that no
 * code path ever produced. This module is the missing half: it reads the facts
 * out of Postgres and hands them over.
 *
 * IDENTITY WITHOUT ACCOUNTS. The storefront is guest checkout — `customerId` is
 * usually null — so history is matched on the phone number as well as the
 * customer id. That is not a compromise, it is the correct key for this
 * problem: COD refusal risk attaches to the person the courier calls, and a
 * repeat refuser does not helpfully create an account first. Phone numbers are
 * normalised to E.164 before they are stored, so the comparison is exact.
 *
 * TWO SIGNALS ARE HONEST PROXIES, and are marked as such below: high-resale
 * carts are inferred from unit price because no category flag exists yet, and
 * freight-forwarder addresses are matched against a starter word list rather
 * than a maintained register of agents. Both are wrong at the edges. Both are
 * far better than the zero that was there before, and both are one query away
 * from being replaced when the data arrives.
 */

export interface CheckoutRiskInput {
  readonly customerId?: string;
  /** E.164, as stored on the order. The identity key for guest checkout. */
  readonly phone: string;
  readonly paymentProvider: string;
  /** Minor units. */
  readonly orderTotal: number;
  readonly shippingAddress: UaeAddress;
  /** Non-blocking warnings from `validateAddress` — a delivery risk in itself. */
  readonly addressWarnings: readonly string[];
  readonly lines: readonly { unitPrice: number; quantity: number }[];
}

/**
 * Scores this checkout and records the assessment.
 *
 * Called before stock is reserved, so a blocked order never holds a unit. The
 * assessment row is written separately by `recordRiskAssessment` once the order
 * exists, because the row references it — the score has to exist first to
 * decide whether there will *be* an order.
 */
export async function assessCheckoutRisk(
  tx: Tx,
  ctx: TenantContext,
  input: CheckoutRiskInput,
): Promise<RiskAssessment> {
  const signals = await gatherSignals(tx, ctx, input);
  return assessOrderRisk(signals);
}

/**
 * Persists the assessment against the order.
 *
 * Two places, on purpose. `orders.risk_score` / `risk_signals` is what an
 * operator sees on the order itself and what a query filters on;
 * `risk_assessments` is the immutable record of what was decided and why,
 * including decisions on orders that were never placed. The second is what
 * makes the weights re-fittable later — a score with no stored outcome is a
 * number nobody can ever check.
 */
export async function recordRiskAssessment(
  tx: Tx,
  ctx: TenantContext,
  orderId: string,
  assessment: RiskAssessment,
): Promise<void> {
  await tx.execute(sql`
    UPDATE orders
    SET risk_score = ${assessment.score},
        risk_signals = ${JSON.stringify({
          decision: assessment.decision,
          explanation: assessment.explanation,
          signals: assessment.signals,
        })}::jsonb,
        updated_at = now()
    WHERE tenant_id = ${ctx.tenantId} AND id = ${orderId}
  `);

  await tx.execute(sql`
    INSERT INTO risk_assessments
      (id, tenant_id, entity_type, entity_id, score, decision, signals, model_version, created_at)
    VALUES (${uuidv7()}, ${ctx.tenantId}, 'order', ${orderId}, ${assessment.score},
            ${assessment.decision}, ${JSON.stringify(assessment.signals)}::jsonb,
            ${MODEL_VERSION}, now())
  `);
}

/**
 * The calibration these signals were scored against.
 *
 * Stored per assessment so a re-fit can tell which rows came from which
 * weighting. Without it, changing a weight silently invalidates every historical
 * score and there is no way to tell the old ones apart.
 */
const MODEL_VERSION = 'rules-v1';

/* ─────────────────────────── Signal gathering ───────────────────────── */

async function gatherSignals(
  tx: Tx,
  ctx: TenantContext,
  input: CheckoutRiskInput,
): Promise<RiskSignalInput> {
  const customerId = input.customerId ?? null;

  /**
   * One round trip for everything the order history knows.
   *
   * `customer_id = NULL` yields NULL rather than false, so the OR falls through
   * to the phone match for a guest — which is the common case here, not the
   * exception.
   *
   * Cancelled orders are excluded from the history: an order the shop itself
   * cancelled is not evidence about the customer, and counting it would make a
   * customer look established because the store had a stock problem.
   */
  const history = await tx.execute<{
    order_count: number;
    average_order_value: number;
    recent_orders: number;
    distinct_addresses: number;
    all_other_emirates: boolean | null;
    chargebacks: number;
    refusals: number;
  }>(sql`
    WITH mine AS (
      SELECT o.id, o.total, o.created_at, o.shipping_address
      FROM orders o
      WHERE o.tenant_id = ${ctx.tenantId}
        AND (o.customer_id = ${customerId}::uuid OR o.phone = ${input.phone})
        AND o.status <> 'cancelled'
    )
    SELECT
      (SELECT count(*)::int FROM mine) AS order_count,
      (SELECT coalesce(round(avg(total)), 0)::bigint FROM mine) AS average_order_value,
      (SELECT count(*)::int FROM mine
        WHERE created_at > now() - interval '1 hour') AS recent_orders,
      (SELECT count(DISTINCT shipping_address->>'area')::int FROM mine
        WHERE created_at > now() - interval '30 days') AS distinct_addresses,
      (SELECT bool_and(shipping_address->>'emirate' <> ${input.shippingAddress.emirate})
         FROM mine) AS all_other_emirates,
      (SELECT count(*)::int FROM transactions t
        WHERE t.order_id IN (SELECT id FROM mine) AND t.kind = 'chargeback') AS chargebacks,
      -- Reads zero until fulfilment starts writing shipments. Correct now,
      -- and starts counting the moment it does, rather than needing a revisit.
      (SELECT count(*)::int FROM shipments s
        WHERE s.order_id IN (SELECT id FROM mine)
          AND s.status IN ('failed', 'returned_to_sender')) AS refusals
  `);

  const identity = await tx.execute<{
    phone_verified_at: Date | null;
    email_verified_at: Date | null;
    created_at: Date;
  }>(sql`
    SELECT phone_verified_at, email_verified_at, created_at
    FROM customers
    WHERE tenant_id = ${ctx.tenantId}
      AND (id = ${customerId}::uuid OR phone = ${input.phone})
      AND deleted_at IS NULL
    LIMIT 1
  `);

  const past = history.rows[0];
  const customer = identity.rows[0];
  const orderCount = Number(past?.order_count ?? 0);
  const averageOrderValue = Number(past?.average_order_value ?? 0);

  return {
    isFirstOrder: orderCount === 0,
    customerOrderCount: orderCount,
    customerRefusedDeliveries: Number(past?.refusals ?? 0),
    customerChargebacks: Number(past?.chargebacks ?? 0),
    // No account means no verification, and that is the truth rather than a
    // missing value: an unverified phone on a COD order is the signal the model
    // weights most heavily, and defaulting it to `true` would quietly disable
    // the control.
    phoneVerified: customer?.phone_verified_at != null,
    emailVerified: customer?.email_verified_at != null,
    orderTotal: input.orderTotal,
    averageOrderValue: orderCount > 0 ? averageOrderValue : null,
    paymentProvider: input.paymentProvider,
    accountAgeMinutes: customer ? minutesSince(customer.created_at) : null,
    recentOrderVelocity: Number(past?.recent_orders ?? 0),
    distinctRecentAddresses: Number(past?.distinct_addresses ?? 0),
    // Checkout copies the shipping address into the billing address, so there is
    // nothing to compare yet. Stated explicitly rather than left to a default,
    // because a separate billing address is a form field away and this is where
    // the signal will land when it arrives.
    addressMismatch: false,
    highResaleValueCart: isHighResaleCart(input.lines),
    shippingAddressIncomplete: input.addressWarnings.length > 0,
    freightForwarderAddress: looksLikeFreightForwarder(input.shippingAddress),
    newEmirateForCustomer: past?.all_other_emirates === true,
  };
}

/**
 * Minutes since a timestamp that TypeScript only BELIEVES is a Date.
 *
 * This signature used to be `(date: Date)`, and it was a lie at runtime. The
 * value comes from a raw `tx.execute`, whose row type is an assertion rather
 * than anything the compiler checked, and the driver hands back a string for
 * this column. `.getTime()` therefore threw `TypeError: date.getTime is not a
 * function` — inside checkout, after the cart was priced.
 *
 * The blast radius was every returning customer and only returning customers.
 * The caller guards with `customer ? … : null`, so a first-time phone has no
 * `customers` row, this is never reached, and the order completes; a shopper
 * who had ever bought before hit it on every attempt, saw "Something went
 * wrong", and lost their whole address form to the re-render. A store that
 * sells to strangers and refuses its regulars fails the wrong way round.
 *
 * Accepting the union and coercing is deliberate rather than casting at the
 * call site: the driver's return type is the thing that is uncertain, so the
 * uncertainty belongs here, once, where it can be handled instead of asserted
 * away. An unparseable value yields null rather than NaN, because NaN would
 * flow into the risk score and silently poison a decision about money.
 */
function minutesSince(value: Date | string | number): number | null {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.round((Date.now() - ms) / 60_000));
}

/**
 * PROXY: high-resale goods, inferred from price.
 *
 * The real signal is a category flag — handsets, GPUs and premium laptops are
 * the goods that move in a grey market; a AED 4,000 washing machine does not.
 * No such flag exists on the catalogue yet, and unit price is the best
 * available stand-in because in this catalogue the expensive things *are* the
 * resellable things. Replace this with a category lookup when one exists.
 */
function isHighResaleCart(lines: readonly { unitPrice: number; quantity: number }[]): boolean {
  const total = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  if (total === 0) return false;
  const premium = lines
    .filter((line) => line.unitPrice >= 100_000)
    .reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  return premium / total >= 0.6;
}

/**
 * PROXY: freight forwarders and re-export agents.
 *
 * A starter word list, not a register. It will miss an agent trading under a
 * personal name and it will flag a genuine customer who lives on a street with
 * "Cargo" in it — which is why the signal carries a weight of 16 rather than a
 * veto, and why the model is additive: on its own it does nothing, stacked with
 * a first order and a high-resale cart it is the strongest chargeback predictor
 * there is.
 */
const FORWARDER_TERMS = [
  'freight',
  'forwarder',
  'cargo',
  'logistics',
  'shipping line',
  'courier hub',
  're-export',
  'reexport',
  'jafza',
  'dafza',
  'free zone warehouse',
];

function looksLikeFreightForwarder(address: UaeAddress): boolean {
  const haystack = [address.recipientName, address.area, address.buildingName, address.landmark]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return FORWARDER_TERMS.some((term) => haystack.includes(term));
}
