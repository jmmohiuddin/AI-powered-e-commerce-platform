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

export interface StripeOptions {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly apiVersion?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Tolerance for webhook timestamp skew. 5 minutes matches Stripe's guidance. */
  readonly webhookToleranceSeconds?: number;
}

/**
 * STRIPE
 *
 * Present for international card acceptance and as the reference implementation
 * of a well-behaved gateway — auth/capture, partial refunds, tokenisation,
 * signed webhooks. Local wallets carry domestic volume; Stripe carries
 * cross-border, and having both behind one port is the whole point of the
 * abstraction.
 *
 * Implemented against the REST API with `fetch` rather than the official SDK.
 * The trade-off: we give up typed helpers and get a dependency-free adapter
 * whose behaviour is identical in Node, edge and worker runtimes, and which
 * cannot break when the SDK's major version changes. For the ~6 endpoints this
 * platform uses, that is the better side of the trade. A store needing Stripe's
 * broader surface (Connect, Billing, Terminal) should swap in the SDK behind
 * this same class — nothing outside this file would change.
 */
export class StripeGateway implements PaymentGateway {
  readonly id = 'stripe' as const;
  readonly displayName = 'Card';

  readonly capabilities: GatewayCapabilities = {
    supportsAuthorisation: true,
    supportsPartialCapture: true,
    supportsRefund: true,
    supportsPartialRefund: true,
    supportsTokenisation: true,
    requiresRedirect: false,
    isDeferredSettlement: false,
    supportedCurrencies: ['USD', 'EUR', 'GBP', 'AED', 'SAR', 'INR', 'AED'],
    minAmount: 50,
  };

  private readonly fetchImpl: typeof fetch;
  private readonly base = 'https://api.stripe.com/v1';

  constructor(private readonly options: StripeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async createPayment(request: PaymentRequest): Promise<PaymentOutcome> {
    const body = new URLSearchParams({
      amount: String(request.amount.amount),
      currency: request.amount.currency.toLowerCase(),
      // Manual capture so stock is only committed once we decide to take the
      // money — the safer default for physical goods that might be out of stock
      // by the time the warehouse picks them.
      capture_method: 'manual',
      'automatic_payment_methods[enabled]': 'true',
      description: `Order ${request.orderNumber}`,
      'metadata[order_id]': request.orderId,
      'metadata[order_number]': request.orderNumber,
    });
    if (request.customer.email) body.set('receipt_email', request.customer.email);

    const intent = await this.post('/payment_intents', body, request.idempotencyKey);
    return this.mapIntent(intent);
  }

  async capturePayment(
    reference: string,
    amount: Money,
    idempotencyKey: string,
  ): Promise<PaymentOutcome> {
    const body = new URLSearchParams({ amount_to_capture: String(amount.amount) });
    const intent = await this.post(`/payment_intents/${reference}/capture`, body, idempotencyKey);
    return this.mapIntent(intent);
  }

  async refundPayment(request: RefundRequest): Promise<RefundOutcome> {
    const body = new URLSearchParams({
      payment_intent: request.transactionReference,
      amount: String(request.amount.amount),
      reason: mapRefundReason(request.reason),
    });

    try {
      const refund = await this.post('/refunds', body, request.idempotencyKey);
      const status = String(refund.status ?? '');
      return {
        kind: status === 'succeeded' ? 'succeeded' : status === 'failed' ? 'failed' : 'pending',
        reference: String(refund.id ?? ''),
        ...(status === 'failed' ? { code: 'refund_failed', message: 'Stripe rejected the refund' } : {}),
        raw: refund,
      } as RefundOutcome;
    } catch (error) {
      if (error instanceof GatewayError) {
        return { kind: 'failed', code: error.code, message: error.message, raw: error };
      }
      throw error;
    }
  }

  /**
   * Verifies the `Stripe-Signature` header: HMAC-SHA256 over `${timestamp}.${body}`.
   *
   * The timestamp check is not optional decoration — without it, a signature
   * captured from a legitimate old event can be replayed forever. Both checks
   * run against the *raw* body, so the caller must not parse JSON first;
   * re-serialising changes bytes and invalidates the signature.
   */
  verifyWebhook(rawBody: string, headers: Record<string, string>): Promise<WebhookVerification> {
    const header = headers['stripe-signature'] ?? headers['Stripe-Signature'] ?? '';
    const parts = Object.fromEntries(
      header.split(',').map((piece) => {
        const [key = '', value = ''] = piece.split('=');
        return [key.trim(), value.trim()];
      }),
    );

    const timestamp = Number(parts.t);
    const signature = parts.v1;
    const tolerance = this.options.webhookToleranceSeconds ?? 300;

    if (!timestamp || !signature) {
      return Promise.resolve({ valid: false, eventId: '', eventType: 'unknown', raw: null });
    }
    if (Math.abs(Date.now() / 1000 - timestamp) > tolerance) {
      return Promise.resolve({ valid: false, eventId: '', eventType: 'expired', raw: null });
    }

    const expected = createHmac('sha256', this.options.webhookSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');

    if (!safeEqual(expected, signature)) {
      return Promise.resolve({ valid: false, eventId: '', eventType: 'bad_signature', raw: null });
    }

    const event = JSON.parse(rawBody) as {
      id: string;
      type: string;
      data: { object: Record<string, unknown> };
    };
    const object = event.data.object;

    return Promise.resolve({
      valid: true,
      eventId: event.id,
      eventType: event.type,
      paymentReference: String(object.id ?? ''),
      status: mapEventStatus(event.type),
      ...(typeof object.amount === 'number'
        ? { amount: money(object.amount, String(object.currency ?? 'usd').toUpperCase()) }
        : {}),
      raw: event,
    });
  }

  async fetchStatus(reference: string): Promise<PaymentStatusResult> {
    const intent = await this.get(`/payment_intents/${reference}`);
    const status = String(intent.status ?? '');
    return {
      reference,
      status:
        status === 'succeeded'
          ? 'succeeded'
          : status === 'requires_capture'
            ? 'authorised'
            : status === 'canceled'
              ? 'cancelled'
              : 'pending',
      ...(typeof intent.amount === 'number'
        ? { amount: money(intent.amount, String(intent.currency ?? 'usd').toUpperCase()) }
        : {}),
      raw: intent,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.get('/balance');
      return true;
    } catch {
      return false;
    }
  }

  /* ── Internals ────────────────────────────────────────────────────── */

  private mapIntent(intent: Record<string, unknown>): PaymentOutcome {
    const status = String(intent.status ?? '');
    const id = String(intent.id ?? '');

    switch (status) {
      case 'succeeded':
        return { kind: 'succeeded', reference: id, raw: intent };
      case 'requires_capture':
        return { kind: 'authorised', reference: id, raw: intent };
      case 'requires_action': {
        const nextAction = intent.next_action as { redirect_to_url?: { url?: string } } | undefined;
        return {
          kind: 'requires_action',
          reference: id,
          redirectUrl: nextAction?.redirect_to_url?.url ?? '',
          raw: intent,
        };
      }
      case 'processing':
      case 'requires_payment_method':
      case 'requires_confirmation':
        return { kind: 'pending', reference: id, raw: intent };
      case 'canceled':
        return {
          kind: 'failed',
          code: 'cancelled',
          message: 'The payment was cancelled',
          retryable: false,
          raw: intent,
        };
      default:
        return {
          kind: 'failed',
          code: status || 'unknown',
          message: 'Unexpected payment state',
          retryable: false,
          raw: intent,
        };
    }
  }

  private post(
    path: string,
    body: URLSearchParams,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    return withRetry(async () => {
      const response = await this.fetchImpl(`${this.base}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Stripe-Version': this.options.apiVersion ?? '2025-10-29.clover',
          // Stripe deduplicates on this key for 24h, which is what makes the
          // retry wrapper above safe on a POST that moves money.
          'Idempotency-Key': idempotencyKey,
        },
        body: body.toString(),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });
      return this.parse(response);
    });
  }

  private get(path: string): Promise<Record<string, unknown>> {
    return withRetry(async () => {
      const response = await this.fetchImpl(`${this.base}${path}`, {
        headers: {
          Authorization: `Bearer ${this.options.secretKey}`,
          'Stripe-Version': this.options.apiVersion ?? '2025-10-29.clover',
        },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });
      return this.parse(response);
    });
  }

  private async parse(response: Response): Promise<Record<string, unknown>> {
    const payload = (await response.json()) as Record<string, unknown> & {
      error?: { code?: string; message?: string; type?: string };
    };

    if (!response.ok) {
      const error = payload.error ?? {};
      throw new GatewayError(
        'stripe',
        error.code ?? `http_${response.status}`,
        error.message ?? `Stripe returned ${response.status}`,
        // Rate limits and server errors are worth retrying; a declined card is not.
        response.status === 429 || response.status >= 500,
      );
    }
    return payload;
  }
}

function mapRefundReason(reason?: string): string {
  if (!reason) return 'requested_by_customer';
  const normalised = reason.toLowerCase();
  if (normalised.includes('fraud')) return 'fraudulent';
  if (normalised.includes('duplicate')) return 'duplicate';
  return 'requested_by_customer';
}

function mapEventStatus(
  eventType: string,
): 'succeeded' | 'failed' | 'refunded' | 'cancelled' | 'pending' {
  if (eventType.startsWith('charge.refund') || eventType === 'charge.refunded') return 'refunded';
  if (eventType.endsWith('.succeeded')) return 'succeeded';
  if (eventType.endsWith('.payment_failed') || eventType.endsWith('.failed')) return 'failed';
  if (eventType.endsWith('.canceled')) return 'cancelled';
  return 'pending';
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
