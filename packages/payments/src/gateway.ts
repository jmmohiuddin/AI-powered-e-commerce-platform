import type { Money } from '@voltix/core';

/**
 * THE PAYMENT GATEWAY PORT
 *
 * A hexagonal boundary. Everything above this line — checkout, orders,
 * refunds, reconciliation — speaks only this interface and knows nothing about
 * Stripe, Tabby, Network International or cash. Everything below is an adapter.
 *
 * WHY THIS SHAPE
 *
 * The naive alternative is `if (provider === 'stripe') … else if …` sprinkled
 * through checkout. That works for one gateway and collapses at two, because
 * gateways disagree on fundamentals: some authorise then capture, some only do
 * immediate sale; some redirect the shopper away and return via webhook, some
 * complete inline; some support partial refunds, some do not.
 *
 * Rather than pretend those differences away, the port makes them *declared*
 * data (`GatewayCapabilities`) that the checkout can branch on once, in one
 * place, instead of discovering them through runtime failures. A gateway that
 * cannot do partial refunds says so, and the refund UI disables the option
 * rather than throwing after the merchant has promised a customer their money.
 *
 * THE THREE-CALL CONTRACT
 *   createPayment  — express intent, get back either a completed sale or a
 *                    redirect/action the shopper must perform
 *   capturePayment — take money that was authorised (no-op for sale-only)
 *   refundPayment  — give money back, in whole or in part
 *
 * Plus two inbound paths: `verifyWebhook` (gateway → us, authoritative) and
 * `fetchStatus` (us → gateway, for reconciliation when a webhook is lost).
 * Both exist because webhooks *will* be missed and a store that cannot answer
 * "did this payment actually succeed?" without a webhook has no reconciliation
 * story at all.
 */

/**
 * Providers relevant to the UAE market.
 *
 *   stripe   — cards, Apple Pay and Google Pay. Wallet share is high here, and
 *              both ride the card rails through Stripe rather than needing
 *              their own adapter.
 *   network  — Network International (N-Genius). The incumbent domestic
 *              acquirer; many UAE merchants already hold an account.
 *   paytabs  — regional MENA gateway; the usual alternative to Network.
 *   tabby    — buy-now-pay-later, split into 4. Not a card alternative but a
 *              basket-size lever: BNPL adoption in the UAE is high enough that
 *              omitting it is a measurable conversion loss on higher-value
 *              handsets.
 *   tamara   — the other major regional BNPL. Adapter not yet written.
 *   cod      — still a real share of UAE e-commerce, and still shrinking.
 */
export type PaymentProviderId =
  | 'stripe'
  | 'network'
  | 'paytabs'
  | 'tabby'
  | 'tamara'
  | 'cod'
  | 'bank_transfer'
  | 'store_credit'
  | 'gift_card'
  | 'manual';

export interface GatewayCapabilities {
  /** Two-step auth/capture, versus immediate sale only. */
  readonly supportsAuthorisation: boolean;
  readonly supportsPartialCapture: boolean;
  readonly supportsRefund: boolean;
  readonly supportsPartialRefund: boolean;
  /** Can charge a stored token without the shopper present (subscriptions). */
  readonly supportsTokenisation: boolean;
  /** Shopper leaves the site and returns — changes the whole checkout flow. */
  readonly requiresRedirect: boolean;
  /** Money arrives later, at delivery. Affects when stock is committed. */
  readonly isDeferredSettlement: boolean;
  readonly supportedCurrencies: readonly string[];
  /** Gateway-imposed bounds, in minor units. */
  readonly minAmount?: number;
  readonly maxAmount?: number;
}

export interface PaymentRequest {
  readonly idempotencyKey: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly amount: Money;
  readonly customer: {
    readonly id?: string;
    readonly email?: string;
    readonly phone?: string;
    readonly name?: string;
  };
  readonly billingAddress?: Record<string, unknown>;
  readonly shippingAddress?: Record<string, unknown>;
  readonly items: readonly { name: string; quantity: number; unitPrice: Money }[];
  /** Where the gateway sends the shopper back to. */
  readonly returnUrl: string;
  readonly cancelUrl: string;
  /** Server-to-server callback target. */
  readonly webhookUrl: string;
  readonly metadata?: Record<string, string>;
}

export type PaymentOutcome =
  /** Money is captured. Fulfilment may proceed. */
  | { readonly kind: 'succeeded'; readonly reference: string; readonly raw?: unknown }
  /** Funds held, not yet taken. Call `capturePayment` to complete. */
  | { readonly kind: 'authorised'; readonly reference: string; readonly raw?: unknown }
  /** Shopper must go somewhere (hosted page, wallet PIN, 3-D Secure). */
  | {
      readonly kind: 'requires_action';
      readonly reference: string;
      readonly redirectUrl: string;
      readonly raw?: unknown;
    }
  /** Gateway accepted the request but the answer arrives by webhook. */
  | { readonly kind: 'pending'; readonly reference: string; readonly raw?: unknown }
  /** Promise to pay later — cash on delivery. Not money in the bank. */
  | { readonly kind: 'deferred'; readonly reference: string; readonly raw?: unknown }
  | {
      readonly kind: 'failed';
      readonly code: string;
      readonly message: string;
      /** Distinguishes "try another card" from "try again in a minute". */
      readonly retryable: boolean;
      readonly raw?: unknown;
    };

export interface RefundRequest {
  readonly idempotencyKey: string;
  readonly transactionReference: string;
  readonly amount: Money;
  readonly reason?: string;
  readonly orderNumber?: string;
}

export type RefundOutcome =
  | { readonly kind: 'succeeded'; readonly reference: string; readonly raw?: unknown }
  | { readonly kind: 'pending'; readonly reference: string; readonly raw?: unknown }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string; readonly raw?: unknown };

export interface WebhookVerification {
  readonly valid: boolean;
  readonly eventId: string;
  readonly eventType: string;
  /** Provider's payment reference, so the handler can find the local intent. */
  readonly paymentReference?: string;
  readonly status?: 'succeeded' | 'failed' | 'refunded' | 'cancelled' | 'pending';
  readonly amount?: Money;
  readonly raw: unknown;
}

export interface PaymentStatusResult {
  readonly status: 'succeeded' | 'authorised' | 'pending' | 'failed' | 'cancelled' | 'refunded';
  readonly amount?: Money;
  readonly reference: string;
  readonly raw?: unknown;
}

/** The port every adapter implements. */
export interface PaymentGateway {
  readonly id: PaymentProviderId;
  readonly displayName: string;
  readonly capabilities: GatewayCapabilities;

  createPayment(request: PaymentRequest): Promise<PaymentOutcome>;
  capturePayment(reference: string, amount: Money, idempotencyKey: string): Promise<PaymentOutcome>;
  refundPayment(request: RefundRequest): Promise<RefundOutcome>;
  /**
   * Verifies signature and parses the payload. Adapters MUST verify
   * cryptographically and MUST NOT trust any field before doing so — an
   * unverified webhook is an unauthenticated request that claims a payment
   * succeeded, which is the cheapest possible way to rob a store.
   */
  verifyWebhook(rawBody: string, headers: Record<string, string>): Promise<WebhookVerification>;
  /** Pull-based truth, for reconciling when a webhook never arrived. */
  fetchStatus(reference: string): Promise<PaymentStatusResult>;
  /** Optional startup check so misconfiguration surfaces at deploy, not checkout. */
  healthCheck?(): Promise<boolean>;
}

/* ─────────────────── Capability-driven helper logic ─────────────────── */

export class GatewayError extends Error {
  constructor(
    readonly provider: PaymentProviderId,
    readonly code: string,
    message: string,
    readonly retryable = false,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = 'GatewayError';
  }
}

/** Is this gateway usable for this amount and currency? */
export function supportsPayment(gateway: PaymentGateway, amount: Money): boolean {
  const c = gateway.capabilities;
  if (!c.supportedCurrencies.includes(amount.currency)) return false;
  if (c.minAmount != null && amount.amount < c.minAmount) return false;
  if (c.maxAmount != null && amount.amount > c.maxAmount) return false;
  return true;
}

/**
 * Whether stock should be *committed* (permanently decremented) or merely held
 * when this outcome occurs.
 *
 * Cash on delivery is the interesting case: no money has moved, but the
 * merchant has committed to shipping. Holding the reservation forever would
 * block the SKU; releasing it would oversell. Committing is correct — the
 * order exists, and a subsequent cancellation restocks explicitly.
 */
export function shouldCommitStock(outcome: PaymentOutcome): boolean {
  return outcome.kind === 'succeeded' || outcome.kind === 'authorised' || outcome.kind === 'deferred';
}

/** Whether the shopper is finished, or still owes an action. */
export function isTerminal(outcome: PaymentOutcome): boolean {
  return outcome.kind === 'succeeded' || outcome.kind === 'failed' || outcome.kind === 'deferred';
}

/**
 * Turns pull- or push-based *truth* back into the outcome type the ledger
 * speaks.
 *
 * `createPayment` returns a `PaymentOutcome`, but the two inbound paths do not:
 * `fetchStatus` returns a `PaymentStatusResult` and `verifyWebhook` a
 * `WebhookVerification`, and both carry the same small vocabulary of statuses.
 * Without this, every caller that reconciles a payment after checkout — the
 * webhook worker, the shopper's return page — would write its own mapping, and
 * a store where two mappings disagree about what `authorised` means is a store
 * that ships against a hold that never settles.
 *
 * `refunded` returns null on purpose. A refund is not a payment outcome: it is
 * a separate ledger entry against an existing capture, and fabricating a
 * `PaymentOutcome` for one would restate the original payment rather than
 * record the money going back.
 */
export function outcomeFromStatus(
  status: PaymentStatusResult['status'] | NonNullable<WebhookVerification['status']>,
  reference: string,
  raw?: unknown,
): PaymentOutcome | null {
  switch (status) {
    case 'succeeded':
      return { kind: 'succeeded', reference, raw };
    case 'authorised':
      return { kind: 'authorised', reference, raw };
    case 'pending':
      return { kind: 'pending', reference, raw };
    case 'cancelled':
      return {
        kind: 'failed',
        code: 'cancelled',
        message: 'The payment was cancelled',
        retryable: false,
        raw,
      };
    case 'failed':
      return {
        kind: 'failed',
        code: 'payment_failed',
        message: 'The payment was not completed',
        retryable: false,
        raw,
      };
    case 'refunded':
      return null;
  }
}
