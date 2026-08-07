import { describe, expect, it, vi } from 'vitest';
import { money } from '@voltix/core';
import { NetworkInternationalGateway } from './network';
import { TabbyGateway } from './tabby';
import type { PaymentRequest, RefundRequest } from '../gateway';

// Matches how packages/payments/src/payments.test.ts spells it — the domain
// stores currency as a string, so a local constant beats importing a symbol
// that doesn't exist.
const AED = 'AED';

/**
 * ADAPTER TESTS WITHOUT A NETWORK
 *
 * Both adapters accept `fetchImpl` at construction. The tests below use that to
 * drive every path a real gateway would produce: an approval, a rejection, a
 * server error. The goal is not to prove Tabby or N-Genius behaves as their
 * documentation says — only a live sandbox proves that — but to prove **this
 * adapter maps their documented shapes into the domain the store operates on**,
 * because that mapping is where the store's own logic breaks when either API
 * shifts.
 *
 * Two specific outcomes get the closest attention because they are the ones
 * this codebase has commented on:
 *
 *   • A Tabby rejection must never surface as "payment failed" — the shopper
 *     was told their credit was insufficient in a public checkout, which is
 *     both wrong and awful.
 *   • An N-Genius `AUTHORISED` state must not read as `succeeded`: capture has
 *     not happened, and treating auth as capture is the classic way to hand out
 *     stock against a hold that never settles.
 */

/**
 * A fake `fetch` that returns responses in order.
 *
 * A retried request or a request whose body is read twice consumes the same
 * `Response` object twice, which throws — so each entry is a *factory* that
 * mints a fresh `Response`, not a stored one. Passing a plain body is short for
 * "wrap it in a 200 JSON response".
 */
type Responder = () => Response | Promise<Response>;
function fakeFetch(...responses: Array<Responder | unknown>): typeof fetch {
  const factories = responses.map<Responder>((r) =>
    typeof r === 'function' ? (r as Responder) : () => okJson(r),
  );
  let call = 0;
  const impl = vi.fn(async () => {
    const factory = factories[Math.min(call++, factories.length - 1)]!;
    return factory();
  });
  return impl as unknown as typeof fetch;
}

const okJson = (body: unknown, init: ResponseInit = { status: 200 }) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });

const REQUEST: PaymentRequest = {
  idempotencyKey: 'idem-1',
  orderId: 'ord-1',
  orderNumber: '10099',
  amount: money(469_900, AED), // AED 4,699.00
  customer: { id: 'cus-1', name: 'Aisha', email: 'a@example.ae', phone: '+971501234567' },
  items: [{ name: 'Handset', quantity: 1, unitPrice: money(469_900, AED) }],
  returnUrl: 'https://shop.ae/checkout/return',
  cancelUrl: 'https://shop.ae/cart',
  webhookUrl: 'https://shop.ae/api/webhooks/ngenius',
};

/* ──────────────────────── N-Genius / Network ──────────────────────── */

describe('N-Genius adapter', () => {
  const opts = {
    apiKey: 'test-key',
    outletReference: 'outlet-x',
    sandbox: true,
  } as const;

  function withFetch(fetchImpl: typeof fetch) {
    return new NetworkInternationalGateway({ ...opts, fetchImpl });
  }

  it('declares AED, USD, EUR, GBP and SAR — the useful UAE currency set', () => {
    const g = withFetch(fakeFetch({}));
    expect(g.capabilities.supportedCurrencies).toEqual(
      expect.arrayContaining(['AED', 'USD', 'EUR', 'GBP', 'SAR']),
    );
    // The gateway requires an authenticate step before card actions, so
    // requiresRedirect must be true — otherwise the store would show a card
    // form it cannot actually submit.
    expect(g.capabilities.requiresRedirect).toBe(true);
    expect(g.capabilities.supportsRefund).toBe(true);
    expect(g.capabilities.supportsPartialCapture).toBe(true);
  });

  it('creates an AUTH order and returns the redirect URL the shopper is sent to', async () => {
    const gateway = withFetch(
      fakeFetch(
        // Token bootstrap.
        { access_token: 'tok', expires_in: 3600 },
        // Order create.
        {
          reference: 'order-ref-1',
          _links: { payment: { href: 'https://pay.ngenius.example/pay/abc' } },
        },
      ),
    );

    const outcome = await gateway.createPayment(REQUEST);
    // Only `requires_action` carries a `redirectUrl`, so this narrowing also
    // pins the shape.
    if (outcome.kind !== 'requires_action') throw new Error(`unexpected ${outcome.kind}`);
    expect(outcome.reference).toBe('order-ref-1');
    expect(outcome.redirectUrl).toBe('https://pay.ngenius.example/pay/abc');
  });

  it('returns a typed failure — never throws — when the gateway omits the payment link', async () => {
    const gateway = withFetch(
      fakeFetch({ access_token: 'tok', expires_in: 3600 }, { reference: 'nope' }),
    );
    const outcome = await gateway.createPayment(REQUEST);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.retryable).toBe(true);
  });

  it('maps gateway states to domain status — AUTHORISED must not read as succeeded', async () => {
    // The pre-capture case is the important one: an authorisation is not a
    // capture, and letting it read as `succeeded` would ship stock against a
    // hold that never actually settles.
    const gateway = withFetch(
      fakeFetch(
        { access_token: 'tok', expires_in: 3600 },
        {
          amount: { value: 469_900, currencyCode: 'AED' },
          _embedded: { payment: [{ state: 'AUTHORISED' }] },
        },
      ),
    );
    const status = await gateway.fetchStatus('order-ref-1');
    expect(status.status).toBe('authorised');
    expect(status.amount?.amount).toBe(469_900);
    expect(status.amount?.currency).toBe('AED');
  });

  it('reads CAPTURED and PURCHASED as succeeded, DECLINED as failed, REVERSED as cancelled', async () => {
    for (const [state, expected] of [
      ['CAPTURED', 'succeeded'],
      ['PURCHASED', 'succeeded'],
      ['DECLINED', 'failed'],
      ['FAILED', 'failed'],
      ['REVERSED', 'cancelled'],
      ['PENDING', 'pending'],
    ] as const) {
      const gateway = withFetch(
        fakeFetch(
          { access_token: 'tok', expires_in: 3600 },
          { _embedded: { payment: [{ state }] } },
        ),
      );
      const status = await gateway.fetchStatus('order-x');
      expect(status.status, `state=${state}`).toBe(expected);
    }
  });

  it('verifyWebhook treats the browser redirect as a hint and re-queries the gateway', async () => {
    // N-Genius returns the shopper to the redirect URL rather than pushing a
    // signed webhook, so the return is trust-nothing input — this asserts the
    // adapter goes back to the source of truth rather than believing it.
    const gateway = withFetch(
      fakeFetch(
        { access_token: 'tok', expires_in: 3600 },
        { _embedded: { payment: [{ state: 'CAPTURED' }] } },
      ),
    );
    const result = await gateway.verifyWebhook('ref=order-ref-1');
    expect(result.valid).toBe(true);
    expect(result.paymentReference).toBe('order-ref-1');
    expect(result.status).toBe('succeeded');
  });

  it('a webhook body missing a reference is refused, not silently trusted', async () => {
    const gateway = withFetch(fakeFetch({ access_token: 'tok', expires_in: 3600 }));
    const result = await gateway.verifyWebhook('other=1');
    expect(result.valid).toBe(false);
  });

  it('refund without a refundable capture returns a domain failure, not a throw', async () => {
    const gateway = withFetch(
      fakeFetch(
        { access_token: 'tok', expires_in: 3600 },
        { _embedded: { payment: [{}] } },
      ),
    );
    const refund: RefundRequest = {
      idempotencyKey: 'r-1',
      transactionReference: 'order-ref-1',
      amount: money(10_000, AED),
    };
    const outcome = await gateway.refundPayment(refund);
    expect(outcome.kind).toBe('failed');
  });
});

/* ────────────────────────────── Tabby ─────────────────────────────── */

describe('Tabby adapter', () => {
  const opts = {
    secretKey: 'sk_test',
    publicKey: 'pk_test',
    merchantCode: 'MC-AE',
    webhookSecret: 'whsec_1234567890',
  } as const;

  function withFetch(fetchImpl: typeof fetch) {
    return new TabbyGateway({ ...opts, fetchImpl });
  }

  it('advertises AED and offers instalments on realistic UAE electronics amounts', () => {
    const gateway = withFetch(fakeFetch({}));
    expect(gateway.capabilities.supportedCurrencies).toContain('AED');
    // BNPL is not worth offering on very small baskets; the floor keeps a
    // AED 5 accessory from surfacing "Pay in 4 of AED 1.25" — silly and
    // conversion-negative.
    expect(gateway.capabilities.minAmount).toBeGreaterThan(0);
  });

  it('a Tabby rejection returns a typed failure with the shopper-safe message — never a raw error', async () => {
    // The load-bearing behaviour. Tabby underwrites the shopper, and a
    // rejection is normal — not a payment failure. Rejection must not
    // reach the shopper's screen as "your payment failed".
    const gateway = withFetch(
      fakeFetch({
        status: 'rejected',
        configuration: { available_products: { installments: [] } },
        rejection_reason: 'not_available',
      }),
    );
    const outcome = await gateway.createPayment(REQUEST);
    if (outcome.kind !== 'failed') throw new Error(`unexpected ${outcome.kind}`);
    expect(outcome.code).toBe('tabby_rejected');
    expect(outcome.retryable).toBe(false);
    expect(outcome.message.toLowerCase()).not.toContain('error');
    expect(outcome.message.toLowerCase()).not.toContain('failed');
  });

  it('an approved session returns requires_action with Tabby\'s redirect', async () => {
    const gateway = withFetch(
      fakeFetch({
        id: 'sess-1',
        status: 'created',
        configuration: {
          available_products: {
            installments: [{ web_url: 'https://checkout.tabby.ai/sess-1' }],
          },
        },
      }),
    );
    const outcome = await gateway.createPayment(REQUEST);
    if (outcome.kind !== 'requires_action') throw new Error(`unexpected ${outcome.kind}`);
    expect(outcome.reference).toBe('sess-1');
    expect(outcome.redirectUrl).toContain('tabby.ai');
  });

  it('preScore filters below the minimum without calling the API', async () => {
    // Every network call would be wasted latency on a basket Tabby will not
    // fund. The fetchImpl is spied to prove it was not invoked.
    const spy = vi.fn(async () => {});
    const gateway = withFetch(spy as unknown as typeof fetch);
    const eligible = await gateway.preScore({
      amount: money(500, AED),
      phone: '+971501234567',
    });
    expect(eligible.eligible).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('preScore reports eligibility from a live gateway response', async () => {
    const eligible = await withFetch(fakeFetch({ status: 'created' })).preScore({
      amount: money(400_000, AED),
      phone: '+971501234567',
    });
    expect(eligible.eligible).toBe(true);

    const declined = await withFetch(
      fakeFetch({ status: 'rejected', rejection_reason: 'not_available' }),
    ).preScore({ amount: money(400_000, AED), phone: '+971501234567' });
    expect(declined.eligible).toBe(false);
    expect(declined.reason).toBeTruthy();
  });

  it('preScore fails open — a Tabby outage does not disable the payment method', async () => {
    // If Tabby is briefly down, the store keeps offering it; the worst case is
    // a shopper who reaches Tabby and is turned away, which is the same
    // outcome as any other rejection. Failing closed would hide BNPL from
    // every shopper during a partial outage — much worse for revenue.
    const gateway = withFetch(fakeFetch(() => Promise.reject(new Error('ECONNRESET'))));
    const result = await gateway.preScore({
      amount: money(400_000, AED),
      phone: '+971501234567',
    });
    expect(result.eligible).toBe(true);
  });
});
