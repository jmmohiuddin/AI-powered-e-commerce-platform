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

export interface NetworkOptions {
  readonly apiKey: string;
  readonly outletReference: string;
  readonly sandbox?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const LIVE_BASE = 'https://api-gateway.ngenius-payments.com';
const SANDBOX_BASE = 'https://api-gateway.sandbox.ngenius-payments.com';

interface TokenState {
  accessToken: string;
  expiresAt: number;
}

/**
 * NETWORK INTERNATIONAL (N-Genius)
 *
 * The incumbent domestic acquirer in the UAE. Worth a first-class adapter
 * because a large share of established UAE merchants already hold a Network
 * account through their bank, and asking them to move acquiring to a foreign
 * processor to use this platform is a real adoption barrier — often a harder
 * one than any technical objection.
 *
 * TWO THINGS THIS ADAPTER IS BUILT AROUND
 *
 * 1. **Bearer tokens are short-lived.** Requesting one per payment gets the
 *    store throttled. The token is cached, refreshed 60s before expiry, and
 *    concurrent refreshes collapse into a single request — a burst of
 *    simultaneous checkouts must not each mint a token.
 *
 * 2. **Versioned vendor media types, not plain JSON.** N-Genius negotiates on
 *    `application/vnd.ni-payment.v2+json` and friends. Sending
 *    `application/json` fails in ways whose error messages do not point at the
 *    header, so the media types are set explicitly at each call site.
 *
 * ⚠️ Built against the documented N-Genius API shape. Confirm against current
 * documentation and a sandbox outlet before go-live.
 */
export class NetworkInternationalGateway implements PaymentGateway {
  readonly id = 'network' as const;
  readonly displayName = 'Card';

  readonly capabilities: GatewayCapabilities = {
    supportsAuthorisation: true,
    supportsPartialCapture: true,
    supportsRefund: true,
    supportsPartialRefund: true,
    supportsTokenisation: true,
    requiresRedirect: true,
    isDeferredSettlement: false,
    supportedCurrencies: ['AED', 'USD', 'EUR', 'GBP', 'SAR'],
    minAmount: 100,
  };

  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private token: TokenState | null = null;
  private tokenRequest: Promise<TokenState> | null = null;

  constructor(private readonly options: NetworkOptions) {
    this.base = options.sandbox === false ? LIVE_BASE : SANDBOX_BASE;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async createPayment(request: PaymentRequest): Promise<PaymentOutcome> {
    const response = await this.call(
      `/transactions/outlets/${this.options.outletReference}/orders`,
      'POST',
      {
        // AUTH rather than SALE: hold the funds, capture when the warehouse
        // actually picks the item. Capturing at checkout and discovering the
        // last unit was damaged means refunding a customer who never received
        // anything, which costs a gateway fee and a trust hit.
        action: 'AUTH',
        amount: { currencyCode: request.amount.currency, value: request.amount.amount },
        merchantOrderReference: request.orderNumber,
        emailAddress: request.customer.email,
        merchantAttributes: {
          redirectUrl: request.returnUrl,
          cancelUrl: request.cancelUrl,
          skipConfirmationPage: true,
        },
      },
      'application/vnd.ni-payment.v2+json',
    );

    const paymentLink = response._links?.payment?.href as string | undefined;
    const reference = String(response.reference ?? '');

    if (!paymentLink) {
      return {
        kind: 'failed',
        code: 'order_create_failed',
        message: 'Could not start the card payment',
        retryable: true,
        raw: response,
      };
    }

    return { kind: 'requires_action', reference, redirectUrl: paymentLink, raw: response };
  }

  async capturePayment(reference: string, amount: Money): Promise<PaymentOutcome> {
    const order = await this.call(
      `/transactions/outlets/${this.options.outletReference}/orders/${reference}`,
      'GET',
      undefined,
      'application/vnd.ni-payment.v2+json',
    );

    const captureHref = order._embedded?.payment?.[0]?._links?.['cnp:capture']?.href as
      | string
      | undefined;
    if (!captureHref) {
      return {
        kind: 'failed',
        code: 'not_capturable',
        message: 'This authorisation can no longer be captured',
        retryable: false,
        raw: order,
      };
    }

    const response = await this.callAbsolute(captureHref, 'POST', {
      amount: { currencyCode: amount.currency, value: amount.amount },
    });

    return { kind: 'succeeded', reference, raw: response };
  }

  async refundPayment(request: RefundRequest): Promise<RefundOutcome> {
    try {
      const order = await this.call(
        `/transactions/outlets/${this.options.outletReference}/orders/${request.transactionReference}`,
        'GET',
        undefined,
        'application/vnd.ni-payment.v2+json',
      );
      const refundHref = order._embedded?.payment?.[0]?._links?.['cnp:refund']?.href as
        | string
        | undefined;
      if (!refundHref) {
        return { kind: 'failed', code: 'not_refundable', message: 'No refundable capture found' };
      }

      const response = await this.callAbsolute(refundHref, 'POST', {
        amount: { currencyCode: request.amount.currency, value: request.amount.amount },
      });
      return { kind: 'succeeded', reference: String(response.reference ?? ''), raw: response };
    } catch (error) {
      if (error instanceof GatewayError) {
        return { kind: 'failed', code: error.code, message: error.message, raw: error };
      }
      throw error;
    }
  }

  /**
   * N-Genius returns the shopper to `redirectUrl` rather than pushing a signed
   * webhook by default, so the return is treated as a hint and the order is
   * fetched from the gateway to establish what actually happened. That is the
   * correct posture regardless: a browser redirect is fully under the shopper's
   * control.
   */
  async verifyWebhook(rawBody: string): Promise<WebhookVerification> {
    const params = new URLSearchParams(rawBody);
    const reference = params.get('ref') ?? params.get('reference') ?? '';
    if (!reference) {
      return { valid: false, eventId: '', eventType: 'unknown', raw: Object.fromEntries(params) };
    }

    const truth = await this.fetchStatus(reference);
    return {
      valid: true,
      eventId: reference,
      eventType: 'order.updated',
      paymentReference: reference,
      status:
        truth.status === 'succeeded' || truth.status === 'authorised'
          ? 'succeeded'
          : truth.status === 'failed'
            ? 'failed'
            : 'pending',
      ...(truth.amount ? { amount: truth.amount } : {}),
      raw: truth.raw,
    };
  }

  async fetchStatus(reference: string): Promise<PaymentStatusResult> {
    const order = await this.call(
      `/transactions/outlets/${this.options.outletReference}/orders/${reference}`,
      'GET',
      undefined,
      'application/vnd.ni-payment.v2+json',
    );

    const state = String(order._embedded?.payment?.[0]?.state ?? '').toUpperCase();
    const value = order.amount?.value as number | undefined;

    return {
      reference,
      status:
        state === 'CAPTURED' || state === 'PURCHASED'
          ? 'succeeded'
          : state === 'AUTHORISED'
            ? 'authorised'
            : state === 'FAILED' || state === 'DECLINED'
              ? 'failed'
              : state === 'REVERSED'
                ? 'cancelled'
                : 'pending',
      ...(value != null
        ? { amount: money(value, String(order.amount?.currencyCode ?? 'AED')) }
        : {}),
      raw: order,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.getToken();
      return true;
    } catch {
      return false;
    }
  }

  /* ── Token management ─────────────────────────────────────────────── */

  private async getToken(): Promise<TokenState> {
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token;

    this.tokenRequest ??= this.requestToken().finally(() => {
      this.tokenRequest = null;
    });
    this.token = await this.tokenRequest;
    return this.token;
  }

  private async requestToken(): Promise<TokenState> {
    const response = await this.fetchImpl(`${this.base}/identity/auth/access-token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${this.options.apiKey}`,
        'Content-Type': 'application/vnd.ni-identity.v1+json',
        Accept: 'application/vnd.ni-identity.v1+json',
      },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
    });

    if (!response.ok) {
      throw new GatewayError(
        'network',
        `http_${response.status}`,
        `N-Genius auth returned ${response.status}`,
        response.status >= 500,
      );
    }

    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) {
      throw new GatewayError('network', 'no_token', 'N-Genius returned no access token');
    }

    return {
      accessToken: payload.access_token,
      expiresAt: Date.now() + (payload.expires_in ?? 300) * 1000,
    };
  }

  private async call(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    accept = 'application/vnd.ni-payment.v2+json',
  ): Promise<Record<string, any>> {
    return this.callAbsolute(`${this.base}${path}`, method, body, accept);
  }

  private callAbsolute(
    url: string,
    method: 'GET' | 'POST',
    body?: unknown,
    accept = 'application/vnd.ni-payment.v2+json',
  ): Promise<Record<string, any>> {
    return withRetry(async () => {
      const token = await this.getToken();
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          'Content-Type': accept,
          Accept: accept,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });

      if (!response.ok) {
        throw new GatewayError(
          'network',
          `http_${response.status}`,
          `N-Genius returned ${response.status}`,
          response.status === 429 || response.status >= 500,
        );
      }
      return (await response.json()) as Record<string, any>;
    });
  }
}
