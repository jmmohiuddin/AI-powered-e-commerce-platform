import { money, type Money } from '@voltix/core';
import type {
  GatewayCapabilities,
  PaymentGateway,
  PaymentOutcome,
  PaymentRequest,
  PaymentStatusResult,
  RefundOutcome,
  RefundRequest,
  WebhookVerification,
} from '../gateway';

export interface CodOptions {
  /** Orders above this need part-payment upfront. Undefined = no ceiling. */
  readonly maxOrderAmount?: number;
  /** Advance payment required, in basis points of order total. */
  readonly advancePaymentBps?: number;
  /** Risk score at or above which COD is refused for this customer. */
  readonly maxCustomerRiskScore?: number;
  readonly currency?: string;
  /** Flat handling fee added for choosing COD, in minor units. */
  readonly handlingFee?: number;
}

/**
 * CASH ON DELIVERY
 *
 * Not an afterthought. In the markets this platform targets first, COD is the
 * majority payment method — a large share of shoppers have no card and will
 * abandon a checkout that does not offer it. Building the payment layer
 * card-first and bolting COD on later produces a system where the dominant
 * flow is the special case.
 *
 * COD is modelled as a *deferred settlement* gateway rather than "no gateway":
 * it participates in the same intent/transaction ledger, so an order paid in
 * cash reconciles through exactly the same reporting as a card order. The money
 * arrives when the courier remits it, recorded as a capture against the same
 * intent.
 *
 * THE RISK PROBLEM
 *
 * COD's failure mode is refusal-to-accept: the parcel is packed, dispatched,
 * carried, refused, and returned — the merchant eats round-trip freight and the
 * unit is out of stock for a week for nothing. Industry refusal rates of
 * 10–25% are normal. So this adapter is the one place where a *risk gate* is
 * built into the payment method itself, not applied afterwards:
 *
 *   • high-risk customers are refused COD and offered prepayment instead
 *   • high-value orders require a partial advance, which collapses refusal
 *     rates because a customer who has paid something turns up
 *   • an unverified phone number is treated as a risk signal in its own right
 *
 * These are policy knobs the merchant tunes, not hardcoded judgements.
 */
export class CashOnDeliveryGateway implements PaymentGateway {
  readonly id = 'cod' as const;
  readonly displayName = 'Cash on Delivery';

  readonly capabilities: GatewayCapabilities;

  constructor(private readonly options: CodOptions = {}) {
    this.capabilities = {
      supportsAuthorisation: false,
      supportsPartialCapture: true,
      supportsRefund: true,
      supportsPartialRefund: true,
      supportsTokenisation: false,
      requiresRedirect: false,
      isDeferredSettlement: true,
      supportedCurrencies: [options.currency ?? 'AED'],
      ...(options.maxOrderAmount != null ? { maxAmount: options.maxOrderAmount } : {}),
    };
  }

  createPayment(request: PaymentRequest): Promise<PaymentOutcome> {
    if (
      this.options.maxOrderAmount != null &&
      request.amount.amount > this.options.maxOrderAmount
    ) {
      return Promise.resolve({
        kind: 'failed',
        code: 'cod_amount_exceeded',
        message: `Cash on delivery is unavailable above ${this.options.maxOrderAmount / 100}`,
        retryable: false,
      });
    }

    // No network call, no external state: the "reference" is simply the order,
    // and the obligation to collect is recorded on the shipment.
    return Promise.resolve({
      kind: 'deferred',
      reference: `cod_${request.orderId}`,
      raw: {
        collectAmount: request.amount.amount,
        currency: request.amount.currency,
        advanceRequired: this.advanceAmount(request.amount).amount,
      },
    });
  }

  /**
   * Called when the courier remits the collected cash. Partial captures are
   * supported because couriers remit in batches and occasionally short-pay,
   * and pretending otherwise means the ledger never balances.
   */
  capturePayment(reference: string, amount: Money, _idempotencyKey?: string): Promise<PaymentOutcome> {
    return Promise.resolve({
      kind: 'succeeded',
      reference,
      raw: { collectedAmount: amount.amount, method: 'courier_remittance' },
    });
  }

  /** A COD refund is a manual disbursement; recorded here, executed by a human. */
  refundPayment(request: RefundRequest): Promise<RefundOutcome> {
    return Promise.resolve({
      kind: 'pending',
      reference: `cod_refund_${request.transactionReference}`,
      raw: { requiresManualDisbursement: true, amount: request.amount.amount },
    });
  }

  verifyWebhook(): Promise<WebhookVerification> {
    // COD has no external event source. Returning invalid rather than throwing
    // keeps the webhook router uniform.
    return Promise.resolve({
      valid: false,
      eventId: '',
      eventType: 'unsupported',
      raw: null,
    });
  }

  fetchStatus(reference: string): Promise<PaymentStatusResult> {
    return Promise.resolve({ status: 'pending', reference });
  }

  /* ── COD-specific policy, consumed by checkout ────────────────────── */

  /** Advance payment required before dispatch. Zero when not configured. */
  advanceAmount(orderTotal: Money): Money {
    const bps = this.options.advancePaymentBps ?? 0;
    if (bps <= 0) return money(0, orderTotal.currency);
    return money(Math.round((orderTotal.amount * bps) / 10_000), orderTotal.currency);
  }

  handlingFee(currency: string): Money {
    return money(this.options.handlingFee ?? 0, currency);
  }

  /**
   * Whether this customer may use COD for this order.
   *
   * Returns a reason string on refusal because the checkout must explain
   * itself — "Cash on delivery isn't available for this order" with no reason
   * reads as a bug and loses the sale outright, whereas "available on orders
   * under AED 50,000 — pay online to continue" converts to a prepaid order.
   */
  eligibility(input: {
    orderTotal: Money;
    customerRiskScore?: number;
    phoneVerified?: boolean;
    previousRefusedDeliveries?: number;
  }): { allowed: boolean; reason?: string; advanceRequired: Money } {
    const advanceRequired = this.advanceAmount(input.orderTotal);

    if (this.options.maxOrderAmount != null && input.orderTotal.amount > this.options.maxOrderAmount) {
      return {
        allowed: false,
        reason: `Cash on delivery is available on orders up to ${this.options.maxOrderAmount / 100}. Please pay online to continue.`,
        advanceRequired,
      };
    }

    const riskCeiling = this.options.maxCustomerRiskScore;
    if (riskCeiling != null && (input.customerRiskScore ?? 0) >= riskCeiling) {
      return {
        allowed: false,
        reason: 'Please complete payment online for this order.',
        advanceRequired,
      };
    }

    if ((input.previousRefusedDeliveries ?? 0) >= 2) {
      return {
        allowed: false,
        reason: 'Online payment is required because of previous undelivered orders.',
        advanceRequired,
      };
    }

    if (input.phoneVerified === false) {
      return {
        allowed: false,
        reason: 'Please verify your phone number to use cash on delivery.',
        advanceRequired,
      };
    }

    return { allowed: true, advanceRequired };
  }
}
