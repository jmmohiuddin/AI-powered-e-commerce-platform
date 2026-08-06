import { describe, expect, it, vi } from 'vitest';
import { money } from '@voltix/core';
import { CashOnDeliveryGateway } from './adapters/cod';
import { StripeGateway } from './adapters/stripe';
import { shouldCommitStock, supportsPayment, type PaymentGateway } from './gateway';
import { PaymentRegistry } from './registry';
import { CircuitBreaker, isRetryable, withRetry } from './retry';
import { GatewayError } from './gateway';

const AED = 'AED';

describe('cash on delivery', () => {
  it('returns a deferred outcome rather than pretending money moved', async () => {
    const cod = new CashOnDeliveryGateway();
    const outcome = await cod.createPayment({
      idempotencyKey: 'k1',
      orderId: 'o1',
      orderNumber: '10001',
      amount: money(500_000, AED),
      customer: {},
      items: [],
      returnUrl: '',
      cancelUrl: '',
      webhookUrl: '',
    });
    expect(outcome.kind).toBe('deferred');
  });

  it('commits stock on a deferred outcome — the parcel is going out either way', () => {
    expect(shouldCommitStock({ kind: 'deferred', reference: 'x' })).toBe(true);
    expect(shouldCommitStock({ kind: 'requires_action', reference: 'x', redirectUrl: 'u' })).toBe(false);
  });

  it('refuses COD above the configured ceiling, with a usable explanation', () => {
    const cod = new CashOnDeliveryGateway({ maxOrderAmount: 5_000_000 });
    const verdict = cod.eligibility({ orderTotal: money(9_000_000, AED) });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/pay online/i);
  });

  it('refuses COD to high-risk customers', () => {
    const cod = new CashOnDeliveryGateway({ maxCustomerRiskScore: 70 });
    expect(cod.eligibility({ orderTotal: money(100_000, AED), customerRiskScore: 85 }).allowed).toBe(
      false,
    );
    expect(cod.eligibility({ orderTotal: money(100_000, AED), customerRiskScore: 10 }).allowed).toBe(
      true,
    );
  });

  it('refuses COD after repeated refused deliveries', () => {
    const cod = new CashOnDeliveryGateway();
    expect(
      cod.eligibility({ orderTotal: money(100_000, AED), previousRefusedDeliveries: 3 }).allowed,
    ).toBe(false);
  });

  it('computes the required advance payment', () => {
    const cod = new CashOnDeliveryGateway({ advancePaymentBps: 2000 });
    expect(cod.advanceAmount(money(1_000_000, AED)).amount).toBe(200_000);
  });

  it('supports partial capture, because couriers remit in batches', async () => {
    const cod = new CashOnDeliveryGateway();
    const outcome = await cod.capturePayment('cod_o1', money(250_000, AED), 'k');
    expect(outcome.kind).toBe('succeeded');
  });
});

describe('capability gating', () => {
  const fake = (over: Partial<PaymentGateway['capabilities']>): PaymentGateway =>
    ({
      id: 'manual',
      displayName: 'Fake',
      capabilities: {
        supportsAuthorisation: false,
        supportsPartialCapture: false,
        supportsRefund: false,
        supportsPartialRefund: false,
        supportsTokenisation: false,
        requiresRedirect: false,
        isDeferredSettlement: false,
        supportedCurrencies: ['AED'],
        ...over,
      },
    }) as PaymentGateway;

  it('rejects unsupported currencies', () => {
    expect(supportsPayment(fake({}), money(100, 'USD'))).toBe(false);
  });

  it('respects gateway amount bounds', () => {
    const gateway = fake({ minAmount: 1000, maxAmount: 10_000 });
    expect(supportsPayment(gateway, money(500, AED))).toBe(false);
    expect(supportsPayment(gateway, money(5000, AED))).toBe(true);
    expect(supportsPayment(gateway, money(50_000, AED))).toBe(false);
  });
});

describe('registry', () => {
  function registry() {
    return new PaymentRegistry()
      .register(new CashOnDeliveryGateway({ maxOrderAmount: 5_000_000 }))
      .register(
        new StripeGateway({ secretKey: 'sk_test', webhookSecret: 'whsec', fetchImpl: vi.fn() }),
      );
  }

  it('leads with prepaid methods, not cash', () => {
    // UAE ordering: cards convert better here and carry none of the refusal
    // risk a COD order does. Every COD order converted to prepaid removes a
    // refusal risk and a courier remittance delay, so cash is offered last.
    const { available } = registry().availableFor({ amount: money(200_000, AED) });
    expect(available[0]?.id).toBe('stripe');
    expect(available.map((m) => m.id)).toContain('cod');
    expect(available.findIndex((m) => m.id === 'cod')).toBeGreaterThan(0);
  });

  it('explains why a method is unavailable instead of hiding it', () => {
    const { available, unavailable } = registry().availableFor({ amount: money(9_000_000, AED) });
    expect(available.map((m) => m.id)).not.toContain('cod');
    expect(unavailable.find((m) => m.id === 'cod')?.reason).toMatch(/up to/i);
  });

  it('throws a clear error for an unregistered provider', () => {
    expect(() => registry().get('tamara')).toThrow(/not configured/);
  });
});

describe('retry', () => {
  it('retries transient gateway errors and eventually succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new GatewayError('stripe', 'http_503', 'down', true);
        return 'ok';
      },
      { sleep: async () => {}, random: () => 0 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry a decline', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new GatewayError('stripe', 'card_declined', 'declined', false);
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow('declined');
    expect(calls).toBe(1);
  });

  it('classifies transport failures as retryable', () => {
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    expect(isRetryable(err)).toBe(true);
    expect(isRetryable(new Error('plain'))).toBe(false);
  });
});

describe('circuit breaker', () => {
  it('opens after repeated failures and short-circuits further calls', async () => {
    let clock = 0;
    const breaker = new CircuitBreaker(2, 1000, () => clock);
    const failing = () => Promise.reject(new GatewayError('network', 'http_500', 'down', true));

    await expect(breaker.run(failing)).rejects.toThrow();
    await expect(breaker.run(failing)).rejects.toThrow();
    expect(breaker.isOpen).toBe(true);

    await expect(breaker.run(() => Promise.resolve('never runs'))).rejects.toThrow(/unavailable/);
  });

  it('half-opens after the reset window', async () => {
    let clock = 0;
    const breaker = new CircuitBreaker(1, 1000, () => clock);
    await expect(
      breaker.run(() => Promise.reject(new GatewayError('network', 'http_500', 'down', true))),
    ).rejects.toThrow();
    expect(breaker.isOpen).toBe(true);

    clock = 1001;
    await expect(breaker.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('does not open on non-retryable business errors', async () => {
    const breaker = new CircuitBreaker(1);
    await expect(
      breaker.run(() => Promise.reject(new GatewayError('stripe', 'card_declined', 'no', false))),
    ).rejects.toThrow();
    expect(breaker.isOpen).toBe(false);
  });
});

describe('stripe webhook verification', () => {
  const secret = 'whsec_test_secret';
  const gateway = new StripeGateway({ secretKey: 'sk', webhookSecret: secret, fetchImpl: vi.fn() });

  async function sign(body: string, timestamp: number) {
    const { createHmac } = await import('node:crypto');
    const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    return `t=${timestamp},v1=${v1}`;
  }

  it('accepts a correctly signed, fresh event', async () => {
    const body = JSON.stringify({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_1', amount: 1000, currency: 'usd' } },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const result = await gateway.verifyWebhook(body, {
      'stripe-signature': await sign(body, timestamp),
    });
    expect(result.valid).toBe(true);
    expect(result.status).toBe('succeeded');
    expect(result.amount?.amount).toBe(1000);
  });

  it('rejects a tampered body', async () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'x', data: { object: {} } });
    const timestamp = Math.floor(Date.now() / 1000);
    const header = await sign(body, timestamp);
    const result = await gateway.verifyWebhook(`${body} `, { 'stripe-signature': header });
    expect(result.valid).toBe(false);
  });

  it('rejects a replayed old event', async () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'x', data: { object: {} } });
    const stale = Math.floor(Date.now() / 1000) - 10_000;
    const result = await gateway.verifyWebhook(body, {
      'stripe-signature': await sign(body, stale),
    });
    expect(result.valid).toBe(false);
    expect(result.eventType).toBe('expired');
  });

  it('rejects a missing signature header', async () => {
    const result = await gateway.verifyWebhook('{}', {});
    expect(result.valid).toBe(false);
  });
});

describe('stripe payment flow', () => {
  it('maps requires_capture to an authorised outcome', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'pi_1', status: 'requires_capture' }), { status: 200 }),
    ) as unknown as typeof fetch;

    const gateway = new StripeGateway({ secretKey: 'sk', webhookSecret: 'w', fetchImpl });
    const outcome = await gateway.createPayment({
      idempotencyKey: 'idem-1',
      orderId: 'o1',
      orderNumber: '10001',
      amount: money(1000, 'USD'),
      customer: { email: 'a@b.c' },
      items: [],
      returnUrl: '',
      cancelUrl: '',
      webhookUrl: '',
    });
    expect(outcome.kind).toBe('authorised');
  });

  it('sends the idempotency key so a retried charge cannot double-bill', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'pi_1', status: 'succeeded' }), { status: 200 }),
    ) as unknown as typeof fetch;

    const gateway = new StripeGateway({ secretKey: 'sk', webhookSecret: 'w', fetchImpl });
    await gateway.createPayment({
      idempotencyKey: 'idem-42',
      orderId: 'o1',
      orderNumber: '1',
      amount: money(1000, 'USD'),
      customer: {},
      items: [],
      returnUrl: '',
      cancelUrl: '',
      webhookUrl: '',
    });

    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('idem-42');
  });

  it('surfaces a decline as a non-retryable failure', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { code: 'card_declined', message: 'Your card was declined' } }),
        { status: 402 },
      ),
    ) as unknown as typeof fetch;

    const gateway = new StripeGateway({ secretKey: 'sk', webhookSecret: 'w', fetchImpl });
    const outcome = await gateway.refundPayment({
      idempotencyKey: 'r1',
      transactionReference: 'pi_1',
      amount: money(1000, 'USD'),
    });
    expect(outcome.kind).toBe('failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
