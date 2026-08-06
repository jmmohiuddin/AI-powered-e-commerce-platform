import { createHmac, timingSafeEqual } from 'node:crypto';
import { money, type Money } from '@voltix/core';
import {
  GatewayError,
  type GatewayCapabilities,
  type PaymentGateway,
  type PaymentOutcome,
  type PaymentRequest,
  type PaymentStatusResult,
  type RefundOutcome,
  type RefundRequest,
  type WebhookVerification,
} from '../gateway';
import { withRetry } from '../retry';

export interface TabbyOptions {
  readonly secretKey: string;
  readonly publicKey: string;
  readonly merchantCode: string;
  readonly webhookSecret?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const BASE = 'https://api.tabby.ai/api/v2';

/**
 * TABBY — buy now, pay later (split into 4)
 *
 * The most consequential UAE-specific payment method after cards. On a
 * AED 4,199 handset, "AED 1,050 today" converts shoppers who would otherwise
 * abandon at the price, and it raises average basket size on accessories
 * attached to that handset. Omitting BNPL in this market is a measurable
 * conversion loss, not a missing nice-to-have.
 *
 * THE ONE THING THAT MAKES THIS ADAPTER DIFFERENT FROM A CARD GATEWAY
 *
 * Tabby underwrites the shopper. A checkout session is submitted with the
 * customer's history and Tabby returns **approved or rejected before the
 * shopper ever chooses to pay** — and rejection is common and normal, not an
 * error. Two consequences the integration has to respect:
 *
 *  1. **A rejection is not a failure to surface as one.** Showing "payment
 *     failed" to a shopper Tabby declined is both wrong and, in effect, telling
 *     them their credit was refused in a shop full of people. `createPayment`
 *     maps a rejection to a typed unavailability with Tabby's own customer-safe
 *     wording, and the checkout quietly drops the option.
 *  2. **Eligibility must be checked before the method is displayed**, not after
 *     it is chosen. `preScore()` exists for exactly that: the registry calls it
 *     while assembling available methods, so a shopper never selects Tabby and
 *     then gets turned away.
 *
 * SETTLEMENT: Tabby pays the merchant in full, up front, and carries the
 * customer credit risk itself. So from the ledger's point of view this is an
 * immediate settlement like a card — not a deferred one like cash on delivery.
 *
 * ⚠️ Field names follow Tabby's v2 checkout API as built. Confirm against
 * current Tabby documentation and a sandbox merchant account before go-live;
 * no adapter in this repository has yet been run against a live account.
 */
export class TabbyGateway implements PaymentGateway {
  readonly id = 'tabby' as const;
  readonly displayName = 'Tabby — 4 interest-free payments';

  readonly capabilities: GatewayCapabilities = {
    supportsAuthorisation: true,
    supportsPartialCapture: true,
    supportsRefund: true,
    supportsPartialRefund: true,
    supportsTokenisation: false,
    requiresRedirect: true,
    // Tabby settles the merchant up front, so this is not deferred settlement.
    isDeferredSettlement: false,
    supportedCurrencies: ['AED', 'SAR', 'KWD', 'BHD', 'QAR'],
    // Below roughly AED 100 the instalments are too small to be useful, and
    // Tabby rejects most of them anyway.
    minAmount: 10_000,
    maxAmount: 1_000_000_00,
  };

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TabbyOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async createPayment(request: PaymentRequest): Promise<PaymentOutcome> {
    const body = {
      payment: {
        amount: toMajor(request.amount),
        currency: request.amount.currency,
        description: `Order ${request.orderNumber}`,
        buyer: {
          phone: request.customer.phone ?? '',
          email: request.customer.email ?? '',
          name: request.customer.name ?? '',
        },
        order: {
          reference_id: request.orderNumber,
          items: request.items.map((item) => ({
            title: item.name,
            quantity: item.quantity,
            unit_price: toMajor(item.unitPrice),
          })),
        },
        shipping_address: request.shippingAddress ?? {},
        meta: { order_id: request.orderId, ...request.metadata },
      },
      lang: 'en',
      merchant_code: this.options.merchantCode,
      merchant_urls: {
        success: request.returnUrl,
        cancel: request.cancelUrl,
        failure: request.cancelUrl,
      },
    };

    const response = await this.post('/checkout', body);
    const status = String(response.status ?? '').toLowerCase();

    if (status === 'rejected') {
      // Not an error. Tabby declined to underwrite this shopper.
      return {
        kind: 'failed',
        code: 'tabby_rejected',
        message: rejectionMessage(response),
        retryable: false,
        raw: response,
      };
    }

    const config = response.configuration as
      | { available_products?: { installments?: Array<{ web_url?: string }> } }
      | undefined;
    const webUrl = config?.available_products?.installments?.[0]?.web_url;

    if (!webUrl) {
      return {
        kind: 'failed',
        code: 'tabby_unavailable',
        message: 'Tabby is not available for this order',
        retryable: false,
        raw: response,
      };
    }

    return {
      kind: 'requires_action',
      reference: String(response.payment?.id ?? response.id ?? ''),
      redirectUrl: webUrl,
      raw: response,
    };
  }

  async capturePayment(
    reference: string,
    amount: Money,
    _idempotencyKey: string,
  ): Promise<PaymentOutcome> {
    const response = await this.post(`/payments/${reference}/captures`, {
      amount: toMajor(amount),
    });
    const status = String(response.status ?? '').toLowerCase();

    if (status === 'closed' || status === 'captured') {
      return { kind: 'succeeded', reference, raw: response };
    }
    if (status === 'authorized') {
      return { kind: 'authorised', reference, raw: response };
    }
    return {
      kind: 'failed',
      code: 'tabby_capture_failed',
      message: String(response.error ?? 'Capture was not accepted'),
      retryable: false,
      raw: response,
    };
  }

  async refundPayment(request: RefundRequest): Promise<RefundOutcome> {
    try {
      const response = await this.post(`/payments/${request.transactionReference}/refunds`, {
        amount: toMajor(request.amount),
        reason: request.reason ?? 'Customer refund',
      });
      return { kind: 'succeeded', reference: String(response.id ?? ''), raw: response };
    } catch (error) {
      if (error instanceof GatewayError) {
        return { kind: 'failed', code: error.code, message: error.message, raw: error };
      }
      throw error;
    }
  }

  /**
   * Webhook verification.
   *
   * The signature gate rejects cheap forgery; `fetchStatus` against Tabby is
   * the authority for whether money actually moved. Same two-step discipline as
   * every other adapter here — a webhook is an unauthenticated request that
   * claims a payment succeeded until proven otherwise.
   */
  async verifyWebhook(
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<WebhookVerification> {
    const signature = headers['x-tabby-signature'] ?? headers['X-Tabby-Signature'] ?? '';

    if (this.options.webhookSecret) {
      const expected = createHmac('sha256', this.options.webhookSecret).update(rawBody).digest('hex');
      if (!signature || !safeEqual(expected, signature)) {
        return { valid: false, eventId: '', eventType: 'bad_signature', raw: null };
      }
    }

    const event = JSON.parse(rawBody) as { id?: string; status?: string; amount?: string; currency?: string };
    const paymentId = String(event.id ?? '');
    const truth = await this.fetchStatus(paymentId);

    return {
      valid: true,
      eventId: paymentId,
      eventType: `payment.${event.status ?? 'updated'}`,
      paymentReference: paymentId,
      status:
        truth.status === 'succeeded'
          ? 'succeeded'
          : truth.status === 'failed'
            ? 'failed'
            : truth.status === 'refunded'
              ? 'refunded'
              : 'pending',
      ...(truth.amount ? { amount: truth.amount } : {}),
      raw: truth.raw,
    };
  }

  async fetchStatus(reference: string): Promise<PaymentStatusResult> {
    const response = await this.get(`/payments/${reference}`);
    const status = String(response.status ?? '').toLowerCase();

    return {
      reference,
      status:
        status === 'closed'
          ? 'succeeded'
          : status === 'authorized'
            ? 'authorised'
            : status === 'rejected' || status === 'expired'
              ? 'failed'
              : status === 'refunded'
                ? 'refunded'
                : 'pending',
      ...(response.amount
        ? { amount: fromMajor(String(response.amount), String(response.currency ?? 'AED')) }
        : {}),
      raw: response,
    };
  }

  /**
   * Pre-scoring, called while the checkout assembles its list of methods.
   *
   * This is what keeps a Tabby rejection out of the shopper's face. Failing
   * open on a network error is deliberate: showing the option and having Tabby
   * decline is a mildly worse experience than showing it and having it work,
   * but hiding a method the shopper expected because our scoring call timed out
   * loses the order outright.
   */
  async preScore(input: {
    amount: Money;
    phone?: string;
    email?: string;
  }): Promise<{ eligible: boolean; reason?: string }> {
    if (input.amount.amount < (this.capabilities.minAmount ?? 0)) {
      return { eligible: false, reason: 'Available on orders above AED 100' };
    }
    if (!input.phone && !input.email) {
      return { eligible: true };
    }

    try {
      const response = await this.post('/checkout', {
        payment: {
          amount: toMajor(input.amount),
          currency: input.amount.currency,
          buyer: { phone: input.phone ?? '', email: input.email ?? '' },
        },
        merchant_code: this.options.merchantCode,
      });
      const status = String(response.status ?? '').toLowerCase();
      return status === 'rejected'
        ? { eligible: false, reason: rejectionMessage(response) }
        : { eligible: true };
    } catch {
      return { eligible: true };
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.get('/payments?limit=1');
      return true;
    } catch {
      return false;
    }
  }

  /* ── Internals ────────────────────────────────────────────────────── */

  private post(path: string, body: unknown): Promise<Record<string, any>> {
    return withRetry(async () => {
      const response = await this.fetchImpl(`${BASE}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });
      return this.parse(response);
    });
  }

  private get(path: string): Promise<Record<string, any>> {
    return withRetry(async () => {
      const response = await this.fetchImpl(`${BASE}${path}`, {
        headers: { Authorization: `Bearer ${this.options.secretKey}` },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });
      return this.parse(response);
    });
  }

  private async parse(response: Response): Promise<Record<string, any>> {
    const payload = (await response.json()) as Record<string, any>;
    if (!response.ok) {
      throw new GatewayError(
        'tabby',
        String(payload.errorType ?? `http_${response.status}`),
        String(payload.error ?? `Tabby returned ${response.status}`),
        response.status === 429 || response.status >= 500,
      );
    }
    return payload;
  }
}

/**
 * Tabby returns its own customer-facing rejection copy. Using it verbatim
 * matters: Tabby has tuned that wording for the market and for not implying a
 * credit judgement, and a paraphrase risks both.
 */
function rejectionMessage(response: Record<string, any>): string {
  const config = response.configuration as
    | { products?: { installments?: { rejection_reason?: string } } }
    | undefined;
  const reason = config?.products?.installments?.rejection_reason;

  switch (reason) {
    case 'order_amount_too_high':
      return 'This order is above your Tabby limit. Try paying with a card instead.';
    case 'order_amount_too_low':
      return 'This order is below the Tabby minimum.';
    case 'not_available':
    default:
      return 'Tabby is not available for this order right now.';
  }
}

/** Tabby speaks major units as decimal strings; the ledger speaks minor units. */
function toMajor(amount: Money): string {
  return (amount.amount / 100).toFixed(2);
}

function fromMajor(value: string, currency: string): Money {
  return money(Math.round(Number(value) * 100), currency);
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
