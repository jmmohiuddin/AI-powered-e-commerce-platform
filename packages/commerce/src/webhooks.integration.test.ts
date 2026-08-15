import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CashOnDeliveryGateway,
  StripeGateway,
  type PaymentGateway,
  type PaymentOutcome,
} from '@voltix/payments';
import { addItem, getCart, getOrCreateCart } from './cart';
import { completeCheckout } from './checkout';
import { runOnce, type JobHandler, type JobKind } from './jobs';
import { checkoutReturnState, recordPaymentWebhookEvent, settlePayment } from './webhooks';
import {
  asTenant,
  closeTestPools,
  createFixture,
  databaseAvailable,
  ownerDb,
  UAE_ADDRESS,
  type Fixture,
} from './test-support';
import type { ActorContext } from './types';

/**
 * THE PATH A CARD PAYMENT ACTUALLY TAKES.
 *
 * A redirect payment leaves `completeCheckout` unfinished by design: the intent
 * is `requires_action`, the stock is held, the order is unconfirmed. Everything
 * that turns that into a sale happens afterwards, in a webhook and a job — so
 * testing the pieces in isolation proves nothing about whether a shopper who
 * pays ever gets their phone.
 *
 * These tests drive the whole sequence the route drives, in order: a genuinely
 * signed Stripe event, verified by the real adapter, recorded through the real
 * ingress, applied by the real job handler against real Postgres. The only
 * thing stubbed is the network, because no gateway credentials exist here —
 * which is exactly why the signature is computed rather than mocked.
 */

const available = await databaseAvailable();
const suite = available ? describe : describe.skip;

if (!available) {
  console.warn(
    '\n  ⚠ Postgres unreachable — payment webhook integration tests skipped.\n' +
      '    Run `npm run infra:up && npm run db:migrate` to enable them.\n',
  );
}

const ACTOR: ActorContext = { type: 'customer', label: 'integration-test' };
const WEBHOOK_SECRET = 'whsec_integration_test';

function urlsFor(provider: string) {
  return {
    returnUrl: 'http://localhost:3000/checkout/return',
    cancelUrl: 'http://localhost:3000/cart',
    webhookUrl: `http://localhost:3000/api/webhooks/${provider}`,
  };
}

/** A gateway whose outcome the test dictates, so each branch is reachable. */
function scriptedGateway(outcome: PaymentOutcome): PaymentGateway {
  const cod = new CashOnDeliveryGateway();
  return {
    ...cod,
    id: 'stripe',
    displayName: 'Test card gateway',
    capabilities: cod.capabilities,
    createPayment: async () => outcome,
    capturePayment: async () => outcome,
    refundPayment: async () => ({ kind: 'succeeded', reference: 'r' }),
    verifyWebhook: cod.verifyWebhook.bind(cod),
    fetchStatus: cod.fetchStatus.bind(cod),
  } as PaymentGateway;
}

/**
 * A real Stripe event, signed the way Stripe signs one.
 *
 * `verifyWebhook` makes no network call, so this exercises the production
 * signature check byte for byte — including the timestamp tolerance, which is
 * what stops a captured event being replayed forever.
 */
function signedStripeEvent(event: unknown): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return { body, headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` } };
}

function stripeEvent(id: string, type: string, paymentReference: string) {
  return { id, type, data: { object: { id: paymentReference, amount: 469_900, currency: 'aed' } } };
}

/**
 * Drains the queue until this event has been applied.
 *
 * Assertions target the event and order rows, never `runOnce`'s counters: the
 * queue is shared with every other suite in the run, so an aggregate count is a
 * claim about whatever happened to be in the batch — and the batch is capped,
 * so a backlog in front of this job means several passes before it is reached.
 */
async function drain(eventProviderId: string, provider = 'stripe'): Promise<void> {
  const processed = async () => {
    const rows = await ownerDb().execute<{ processed_at: Date | null }>(sql`
      SELECT processed_at FROM payment_webhook_events WHERE provider_event_id = ${eventProviderId}
    `);
    return rows.rows[0]?.processed_at != null;
  };

  // Sending is a network call this test has no business making, so the outbox
  // handler is a no-op here. Everything else runs for real.
  const handlers: Partial<Record<JobKind, JobHandler>> = {
    'notifications.send': async () => {},
  };

  for (let pass = 0; pass < 10 && !(await processed()); pass += 1) {
    await runOnce(ownerDb(), 'worker-webhook-test', { limit: 100, handlers });
  }

  // A handler that threw leaves its reason on the job row and nothing on the
  // event row, so without this the failure surfaces as an unexplained "order is
  // still pending" three assertions later.
  if (!(await processed())) {
    const jobs = await ownerDb().execute<{ status: string; last_error: string | null }>(sql`
      SELECT status, last_error FROM jobs
      WHERE dedupe_key = ${`payment-webhook:${provider}:${eventProviderId}`}
    `);
    const job = jobs.rows[0];
    throw new Error(
      `event ${eventProviderId} was never applied — job ${job?.status ?? 'missing'}: ${
        job?.last_error ?? 'no error recorded'
      }`,
    );
  }
}

suite('payment webhook ingress', () => {
  let f: Fixture;
  const stripe = new StripeGateway({ secretKey: 'sk_test', webhookSecret: WEBHOOK_SECRET });

  beforeAll(async () => {
    f = await createFixture('webhooks');
  });
  afterAll(async () => {
    // The unique index on (provider, provider_event_id) is global, so a run that
    // leaves its events behind poisons the next one.
    await ownerDb().execute(
      sql`DELETE FROM payment_webhook_events WHERE tenant_id = ${f.tenantId}`,
    );
    await f.cleanup();
  });

  /** Places an order that stops at `requires_action`, exactly as a card order does. */
  async function redirectOrder(
    reference: string,
    quantity = 2,
    onHand = 5,
    provider = 'stripe',
  ): Promise<{ orderId: string; orderNumber: string; variantId: string; sessionToken: string }> {
    const variantId = await f.variant({ price: 469_900, onHand });
    const sessionToken = `sess-${reference}`;

    const result = await asTenant(f.tenantId, async (tx) => {
      const cartId = await getOrCreateCart(tx, f.ctx, { sessionToken });
      await addItem(tx, f.ctx, cartId, { variantId, quantity });
      const cart = await getCart(tx, f.ctx, cartId);
      return completeCheckout(
        tx,
        f.ctx,
        ACTOR,
        {
          cartId,
          idempotencyKey: `k-${reference}`,
          expectedTotal: cart.pricing.total.amount,
          paymentProvider: provider,
          phone: UAE_ADDRESS.phone,
          shippingAddress: UAE_ADDRESS,
        },
        scriptedGateway({ kind: 'requires_action', reference, redirectUrl: 'https://pay.test' }),
        urlsFor('stripe'),
      );
    });

    expect(result.payment.kind).toBe('requires_action');
    return {
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      variantId,
      sessionToken,
    };
  }

  async function ingest(body: string, headers: Record<string, string>) {
    const verification = await stripe.verifyWebhook(body, headers);
    const result = await asTenant(f.tenantId, (tx) =>
      recordPaymentWebhookEvent(tx, f.ctx, {
        provider: 'stripe',
        eventId: verification.eventId || `unverified:${f.tenantId}`,
        eventType: verification.eventType,
        signatureVerified: verification.valid,
        envelope: {
          ...(verification.status ? { status: verification.status } : {}),
          ...(verification.paymentReference
            ? { paymentReference: verification.paymentReference }
            : {}),
          raw: verification.raw,
        },
      }),
    );
    return { verification, ...result };
  }

  async function stockOf(variantId: string) {
    const rows = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ on_hand: number; reserved: number }>(
        sql`SELECT on_hand, reserved FROM stock_levels WHERE variant_id = ${variantId}`,
      ),
    );
    return {
      onHand: Number(rows.rows[0]!.on_hand),
      reserved: Number(rows.rows[0]!.reserved),
    };
  }

  async function orderOf(orderId: string) {
    const rows = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ status: string; payment_status: string; paid_total: number }>(
        sql`SELECT status, payment_status, paid_total FROM orders WHERE id = ${orderId}`,
      ),
    );
    return rows.rows[0]!;
  }

  /**
   * The test the whole feature exists for.
   *
   * Before this pipeline existed a shopper could complete 3-D Secure, have the
   * money taken, and watch the order sit unconfirmed forever with the stock
   * still merely held.
   */
  it('turns a signed success event into a paid, confirmed order with stock committed', async () => {
    const reference = `pi_ok_${f.tenantId.slice(0, 8)}`;
    const eventId = `evt_ok_${f.tenantId.slice(0, 8)}`;
    const order = await redirectOrder(reference);

    // Mid-redirect: held, not committed, not paid.
    expect(await stockOf(order.variantId)).toEqual({ onHand: 5, reserved: 2 });

    const { body, headers } = signedStripeEvent(
      stripeEvent(eventId, 'payment_intent.succeeded', reference),
    );
    const { verification, duplicate } = await ingest(body, headers);

    expect(verification.valid).toBe(true);
    expect(duplicate).toBe(false);

    await drain(eventId);

    expect(await orderOf(order.orderId)).toMatchObject({
      status: 'confirmed',
      payment_status: 'paid',
    });
    // The units have left the shelf, not merely been promised.
    expect(await stockOf(order.variantId)).toEqual({ onHand: 3, reserved: 0 });

    const ledger = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM transactions
        WHERE order_id = ${order.orderId} AND kind = 'capture' AND status = 'succeeded'
      `),
    );
    expect(Number(ledger.rows[0]!.n)).toBe(1);

    // Checkout deliberately withheld the confirmation for a redirect payment.
    // This is the moment it becomes owed.
    const confirmation = await ownerDb().execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM jobs
      WHERE dedupe_key = ${`order.confirmation:${order.orderId}`}
    `);
    expect(Number(confirmation.rows[0]!.n)).toBe(1);
  });

  it('answers a redelivery without processing it twice', async () => {
    const reference = `pi_dup_${f.tenantId.slice(0, 8)}`;
    const eventId = `evt_dup_${f.tenantId.slice(0, 8)}`;
    const order = await redirectOrder(reference, 1, 4);

    const { body, headers } = signedStripeEvent(
      stripeEvent(eventId, 'payment_intent.succeeded', reference),
    );

    const first = await ingest(body, headers);
    // Gateways retry aggressively; the same event arriving again is normal traffic.
    const second = await ingest(body, headers);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);

    const events = await ownerDb().execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM payment_webhook_events WHERE provider_event_id = ${eventId}
    `);
    expect(Number(events.rows[0]!.n)).toBe(1);

    const jobs = await ownerDb().execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM jobs WHERE dedupe_key = ${`payment-webhook:stripe:${eventId}`}
    `);
    expect(Number(jobs.rows[0]!.n)).toBe(1);

    await drain(eventId);

    // One event, one capture. A second capture row would be a double-count in
    // the merchant's own books.
    const ledger = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM transactions WHERE order_id = ${order.orderId}
      `),
    );
    expect(Number(ledger.rows[0]!.n)).toBe(1);
    expect(await stockOf(order.variantId)).toEqual({ onHand: 3, reserved: 0 });
  });

  /**
   * A forged webhook is the cheapest possible way to rob a store: an
   * unauthenticated POST that claims a payment succeeded.
   */
  it('records a forged event and queues nothing', async () => {
    const eventId = `evt_forged_${f.tenantId.slice(0, 8)}`;
    const body = JSON.stringify(stripeEvent(eventId, 'payment_intent.succeeded', 'pi_forged'));

    const verification = await stripe.verifyWebhook(body, { 'stripe-signature': 't=1,v1=deadbeef' });
    expect(verification.valid).toBe(false);

    await asTenant(f.tenantId, (tx) =>
      recordPaymentWebhookEvent(tx, f.ctx, {
        provider: 'stripe',
        eventId,
        eventType: verification.eventType,
        signatureVerified: false,
        envelope: { raw: { body } },
      }),
    );

    const row = await ownerDb().execute<{
      signature_verified: boolean;
      processed_at: Date | null;
    }>(sql`
      SELECT signature_verified, processed_at FROM payment_webhook_events
      WHERE provider_event_id = ${eventId}
    `);
    // Kept as evidence, stamped processed so no worker can ever act on it.
    expect(row.rows[0]!.signature_verified).toBe(false);
    expect(row.rows[0]!.processed_at).not.toBeNull();

    const jobs = await ownerDb().execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM jobs WHERE dedupe_key = ${`payment-webhook:stripe:${eventId}`}
    `);
    expect(Number(jobs.rows[0]!.n)).toBe(0);
  });

  it('releases the stock and hands the basket back when the payment fails', async () => {
    const reference = `pi_fail_${f.tenantId.slice(0, 8)}`;
    const eventId = `evt_fail_${f.tenantId.slice(0, 8)}`;
    const order = await redirectOrder(reference, 2, 6);

    const { body, headers } = signedStripeEvent(
      stripeEvent(eventId, 'payment_intent.payment_failed', reference),
    );
    await ingest(body, headers);
    await drain(eventId);

    expect(await orderOf(order.orderId)).toMatchObject({ payment_status: 'failed' });
    expect(await stockOf(order.variantId)).toEqual({ onHand: 6, reserved: 0 });

    // Without this the "try another card" link lands on an empty basket and the
    // sale is lost to a bookkeeping detail.
    const cart = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ status: string; converted_order_id: string | null }>(sql`
        SELECT status, converted_order_id FROM carts WHERE session_token = ${order.sessionToken}
      `),
    );
    expect(cart.rows[0]!.status).toBe('active');
    // Still pointing at the failed order, so a reload of the return page can
    // still say what happened rather than losing the shopper entirely.
    expect(cart.rows[0]!.converted_order_id).toBe(order.orderId);
  });

  /**
   * BNPL through the same pipeline — and a guard on the drift that made it
   * impossible.
   *
   * `PaymentProviderId` has listed `tabby` since the adapter was written, but
   * the `payment_provider` enum in Postgres did not, so every BNPL checkout
   * died on `invalid input value for enum` at the payment_intents insert, after
   * stock had been reserved. Nothing caught it because no test had ever placed
   * an order with a provider other than `cod` or `network`. This one does.
   */
  it('carries a BNPL order through to paid', async () => {
    const reference = `tabby_pay_${f.tenantId.slice(0, 8)}`;
    const eventId = `evt_tabby_${f.tenantId.slice(0, 8)}`;
    const order = await redirectOrder(reference, 1, 3, 'tabby');

    // Tabby signs with its own scheme, so the signature is the adapter's test
    // to own (packages/payments). What matters here is that the ingress
    // contract is provider-agnostic once verification has happened.
    await asTenant(f.tenantId, (tx) =>
      recordPaymentWebhookEvent(tx, f.ctx, {
        provider: 'tabby',
        eventId,
        eventType: 'payment.closed',
        signatureVerified: true,
        envelope: { status: 'succeeded', paymentReference: reference, raw: { id: reference } },
      }),
    );

    await drain(eventId, 'tabby');

    expect(await orderOf(order.orderId)).toMatchObject({
      status: 'confirmed',
      payment_status: 'paid',
    });
    expect(await stockOf(order.variantId)).toEqual({ onHand: 2, reserved: 0 });
  });

  /**
   * Gateways deliver out of order and retry for hours. A late failure notice
   * arriving after a capture must not un-sell a paid order.
   */
  it('ignores a stale failure that arrives after the payment succeeded', async () => {
    const reference = `pi_late_${f.tenantId.slice(0, 8)}`;
    const okId = `evt_late_ok_${f.tenantId.slice(0, 8)}`;
    const lateId = `evt_late_fail_${f.tenantId.slice(0, 8)}`;
    const order = await redirectOrder(reference, 1, 3);

    const ok = signedStripeEvent(stripeEvent(okId, 'payment_intent.succeeded', reference));
    await ingest(ok.body, ok.headers);
    await drain(okId);

    const late = signedStripeEvent(
      stripeEvent(lateId, 'payment_intent.payment_failed', reference),
    );
    await ingest(late.body, late.headers);
    await drain(lateId);

    expect(await orderOf(order.orderId)).toMatchObject({ payment_status: 'paid' });
    expect(await stockOf(order.variantId)).toEqual({ onHand: 2, reserved: 0 });
  });
});

/**
 * The shopper's own return from the hosted page.
 *
 * The page identifies the order from the cart cookie rather than from anything
 * the gateway appended to the URL, so this covers the lookup that makes
 * ignoring those parameters possible.
 */
suite('checkout return', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture('return');
  });
  afterAll(async () => {
    await f.cleanup();
    await closeTestPools();
  });

  async function placeOrder(sessionToken: string, reference: string) {
    const variantId = await f.variant({ price: 99_900, onHand: 4 });
    const result = await asTenant(f.tenantId, async (tx) => {
      const cartId = await getOrCreateCart(tx, f.ctx, { sessionToken });
      await addItem(tx, f.ctx, cartId, { variantId, quantity: 1 });
      const cart = await getCart(tx, f.ctx, cartId);
      return completeCheckout(
        tx,
        f.ctx,
        ACTOR,
        {
          cartId,
          idempotencyKey: `ret-${reference}`,
          expectedTotal: cart.pricing.total.amount,
          paymentProvider: 'stripe',
          phone: UAE_ADDRESS.phone,
          shippingAddress: UAE_ADDRESS,
        },
        scriptedGateway({ kind: 'requires_action', reference, redirectUrl: 'https://pay.test' }),
        urlsFor('stripe'),
      );
    });
    return { ...result, variantId };
  }

  it('finds the order behind a session token, with the reference to re-ask the gateway', async () => {
    const order = await placeOrder('sess-return-1', 'pi_ret_1');

    const state = await asTenant(f.tenantId, (tx) =>
      checkoutReturnState(tx, f.ctx, 'sess-return-1'),
    );

    expect(state).toMatchObject({
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      phone: UAE_ADDRESS.phone,
      paymentStatus: 'unpaid',
      provider: 'stripe',
      providerReference: 'pi_ret_1',
      intentStatus: 'requires_action',
    });
  });

  it('returns nothing for a browser with no cart cookie', async () => {
    const state = await asTenant(f.tenantId, (tx) => checkoutReturnState(tx, f.ctx, ''));
    expect(state).toBeNull();
  });

  /**
   * The page and the webhook race each other constantly — a browser redirect is
   * usually faster than a gateway's callback queue — so settling twice has to
   * be indistinguishable from settling once.
   */
  it('settles the same payment twice without double-charging or double-committing', async () => {
    const order = await placeOrder('sess-return-2', 'pi_ret_2');

    const state = await asTenant(f.tenantId, (tx) =>
      checkoutReturnState(tx, f.ctx, 'sess-return-2'),
    );

    const settle = () =>
      asTenant(f.tenantId, (tx) =>
        settlePayment(
          tx,
          f.ctx,
          { type: 'system', label: 'checkout-return' },
          { orderId: order.orderId, intentId: state!.intentId! },
          { kind: 'succeeded', reference: 'pi_ret_2' },
        ),
      );

    await settle();
    await settle();

    const rows = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ paid_total: number; captures: number; on_hand: number }>(sql`
        SELECT o.paid_total,
               (SELECT count(*)::int FROM transactions
                 WHERE order_id = o.id AND kind = 'capture') AS captures,
               (SELECT on_hand FROM stock_levels WHERE variant_id = ${order.variantId}) AS on_hand
        FROM orders o WHERE o.id = ${order.orderId}
      `),
    );

    expect(Number(rows.rows[0]!.captures)).toBe(1);
    expect(Number(rows.rows[0]!.paid_total)).toBe(order.total);
    // Committed once. Twice would sell a unit the store still has.
    expect(Number(rows.rows[0]!.on_hand)).toBe(3);
  });
});
