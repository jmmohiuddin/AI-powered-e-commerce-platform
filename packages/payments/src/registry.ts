import type { Money } from '@voltix/core';
import {
  supportsPayment,
  type PaymentGateway,
  type PaymentProviderId,
} from './gateway';
import { CircuitBreaker } from './retry';

export interface CheckoutContext {
  readonly amount: Money;
  readonly countryCode?: string;
  readonly customerRiskScore?: number;
  readonly phoneVerified?: boolean;
  readonly previousRefusedDeliveries?: number;
  /** The risk model's `require_advance_payment` decision for this order. */
  readonly riskRequiresAdvance?: boolean;
  readonly channel?: string;
}

export interface AvailableMethod {
  readonly id: PaymentProviderId;
  readonly displayName: string;
  readonly requiresRedirect: boolean;
  readonly isDeferredSettlement: boolean;
  /** Extra payable for choosing this method (COD handling fee, etc.). */
  readonly surcharge?: Money;
  /** Part-payment required before dispatch. */
  readonly advanceRequired?: Money;
}

export interface UnavailableMethod {
  readonly id: PaymentProviderId;
  readonly displayName: string;
  /** Customer-facing. Shown next to a greyed-out option, never swallowed. */
  readonly reason: string;
}

export interface EligibilityInput {
  orderTotal: Money;
  customerRiskScore?: number;
  phoneVerified?: boolean;
  previousRefusedDeliveries?: number;
  /** The risk model asked for a deposit, whatever the standing policy says. */
  riskRequiresAdvance?: boolean;
}

export interface EligibilityVerdict {
  allowed: boolean;
  reason?: string;
  advanceRequired: Money;
}

export interface EligibilityAware {
  eligibility(input: EligibilityInput): EligibilityVerdict;
  handlingFee(currency: string): Money;
}

/**
 * Exported because the *checkout* has to ask this question, not just the
 * method picker.
 *
 * A gate that only runs while assembling the payment options is a gate that a
 * replayed form post walks straight past — and cash-on-delivery eligibility is
 * the control the whole COD refusal problem rests on. The page uses it to
 * explain itself; `completeCheckout` uses it to enforce.
 */
export function hasEligibility(
  gateway: PaymentGateway,
): gateway is PaymentGateway & EligibilityAware {
  return typeof (gateway as Partial<EligibilityAware>).eligibility === 'function';
}

/**
 * GATEWAY REGISTRY
 *
 * The one place that knows which gateways exist. Everything else asks it a
 * question ("what can this customer pay with?") rather than importing an
 * adapter directly — which is what keeps "add Tamara" a 200-line adapter plus a
 * registration call, with no change to checkout, orders, or refunds.
 *
 * Three responsibilities:
 *
 *  1. **Availability.** Filters by currency, amount bounds, and per-gateway
 *     eligibility rules, returning *reasons* for anything unavailable so the
 *     checkout can explain itself instead of silently hiding an option the
 *     customer expected to see.
 *
 *  2. **Isolation.** Each gateway gets its own circuit breaker. A Tabby outage
 *     must not slow down card checkout — without per-gateway breakers, one
 *     provider's 20-second timeouts become everybody's checkout latency.
 *
 *  3. **Ordering.** Methods are returned in the order that maximises
 *     completion: what the customer is most likely to use first. Payment method
 *     ordering is one of the highest-leverage, least-glamorous conversion levers
 *     there is.
 */
export class PaymentRegistry {
  private readonly gateways = new Map<PaymentProviderId, PaymentGateway>();
  private readonly breakers = new Map<PaymentProviderId, CircuitBreaker>();
  /**
   * Ordering for the UAE market, and it is a conversion lever rather than a
   * cosmetic choice.
   *
   * Cards and wallets lead because they are how most UAE shoppers pay, and
   * because a prepaid order carries none of the refusal risk a COD order does.
   * BNPL sits directly beneath them: on a AED 4,000 handset "AED 1,000 today"
   * converts shoppers who would otherwise abandon, so burying it below cash
   * costs real orders. COD is offered last — genuinely available, deliberately
   * not the default, because every COD order the store converts to prepaid
   * removes a refusal risk and a courier remittance delay.
   */
  private readonly preferredOrder: PaymentProviderId[] = [
    'stripe',
    'network',
    'paytabs',
    'tabby',
    'tamara',
    'cod',
    'bank_transfer',
  ];

  register(gateway: PaymentGateway): this {
    this.gateways.set(gateway.id, gateway);
    this.breakers.set(gateway.id, new CircuitBreaker());
    return this;
  }

  get(id: PaymentProviderId): PaymentGateway {
    const gateway = this.gateways.get(id);
    if (!gateway) throw new Error(`Payment provider '${id}' is not configured`);
    return gateway;
  }

  has(id: PaymentProviderId): boolean {
    return this.gateways.has(id);
  }

  list(): PaymentGateway[] {
    return [...this.gateways.values()];
  }

  /** Runs a gateway call through its circuit breaker. */
  execute<T>(id: PaymentProviderId, fn: (gateway: PaymentGateway) => Promise<T>): Promise<T> {
    const gateway = this.get(id);
    const breaker = this.breakers.get(id)!;
    return breaker.run(() => fn(gateway));
  }

  /**
   * What this shopper can actually pay with, plus what they cannot and why.
   *
   * Returning both halves is deliberate. A checkout that simply omits cash on
   * delivery when a customer expected it produces an abandoned cart and a
   * support ticket; one that says "online payment required for this order"
   * produces a prepaid order.
   */
  availableFor(context: CheckoutContext): {
    available: AvailableMethod[];
    unavailable: UnavailableMethod[];
  } {
    const available: AvailableMethod[] = [];
    const unavailable: UnavailableMethod[] = [];

    for (const gateway of this.gateways.values()) {
      const breaker = this.breakers.get(gateway.id);
      if (breaker?.isOpen) {
        unavailable.push({
          id: gateway.id,
          displayName: gateway.displayName,
          reason: 'Temporarily unavailable — please try another method.',
        });
        continue;
      }

      if (!supportsPayment(gateway, context.amount)) {
        unavailable.push({
          id: gateway.id,
          displayName: gateway.displayName,
          reason: amountReason(gateway, context.amount),
        });
        continue;
      }

      if (hasEligibility(gateway)) {
        const verdict = gateway.eligibility({
          orderTotal: context.amount,
          ...(context.customerRiskScore != null ? { customerRiskScore: context.customerRiskScore } : {}),
          ...(context.phoneVerified != null ? { phoneVerified: context.phoneVerified } : {}),
          ...(context.previousRefusedDeliveries != null
            ? { previousRefusedDeliveries: context.previousRefusedDeliveries }
            : {}),
          ...(context.riskRequiresAdvance != null
            ? { riskRequiresAdvance: context.riskRequiresAdvance }
            : {}),
        });
        if (!verdict.allowed) {
          unavailable.push({
            id: gateway.id,
            displayName: gateway.displayName,
            reason: verdict.reason ?? 'Not available for this order.',
          });
          continue;
        }
        available.push({
          id: gateway.id,
          displayName: gateway.displayName,
          requiresRedirect: gateway.capabilities.requiresRedirect,
          isDeferredSettlement: gateway.capabilities.isDeferredSettlement,
          surcharge: gateway.handlingFee(context.amount.currency),
          advanceRequired: verdict.advanceRequired,
        });
        continue;
      }

      available.push({
        id: gateway.id,
        displayName: gateway.displayName,
        requiresRedirect: gateway.capabilities.requiresRedirect,
        isDeferredSettlement: gateway.capabilities.isDeferredSettlement,
      });
    }

    available.sort((a, b) => this.rank(a.id) - this.rank(b.id));
    return { available, unavailable };
  }

  /** Startup verification — surfaces bad credentials at deploy, not at checkout. */
  async healthReport(): Promise<Record<string, boolean>> {
    const entries = await Promise.all(
      [...this.gateways.values()].map(async (gateway) => {
        if (!gateway.healthCheck) return [gateway.id, true] as const;
        try {
          return [gateway.id, await gateway.healthCheck()] as const;
        } catch {
          return [gateway.id, false] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  private rank(id: PaymentProviderId): number {
    const index = this.preferredOrder.indexOf(id);
    return index === -1 ? this.preferredOrder.length : index;
  }
}

function amountReason(gateway: PaymentGateway, amount: Money): string {
  const c = gateway.capabilities;
  if (!c.supportedCurrencies.includes(amount.currency)) {
    return `Not available for ${amount.currency}.`;
  }
  if (c.minAmount != null && amount.amount < c.minAmount) {
    return `Available on orders of ${(c.minAmount / 100).toFixed(2)} and above.`;
  }
  if (c.maxAmount != null && amount.amount > c.maxAmount) {
    return `Available on orders up to ${(c.maxAmount / 100).toFixed(2)}.`;
  }
  return 'Not available for this order.';
}
