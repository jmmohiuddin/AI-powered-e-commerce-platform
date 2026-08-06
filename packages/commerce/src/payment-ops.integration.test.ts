import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CashOnDeliveryGateway, type PaymentGateway, type RefundOutcome } from '@voltix/payments';
import { addItem, getCart, getOrCreateCart } from './cart';
import { completeCheckout } from './checkout';
import { recordCodCollection, refundOrder } from './payment-ops';
import {
  asTenant,
  closeTestPools,
  createFixture,
  databaseAvailable,
  UAE_ADDRESS,
  type Fixture,
} from './test-support';
import type { ActorContext } from './types';

/**
 * PAYMENT OPERATIONS — the money-out path.
 *
 * These are the tests that matter most in the whole suite: every function under
 * test either records money as received or gives money back. The properties
 * asserted are the ones that cost real cash to get wrong — over-refunding,
 * double-refunding, and letting the derived payment status drift away from the
 * transaction ledger it is supposed to summarise.
 */

const available = await databaseAvailable();
const suite = available ? describe : describe.skip;

const ACTOR: ActorContext = { type: 'staff', label: 'payment-ops-test' };
const URLS = {
  returnUrl: 'http://localhost:3000/checkout/return',
  cancelUrl: 'http://localhost:3000/cart',
  webhookUrl: 'http://localhost:3000/api/webhooks/cod',
};

/** A gateway whose refund outcome the test dictates. */
function refundGateway(outcome: RefundOutcome): PaymentGateway {
  const cod = new CashOnDeliveryGateway();
  return {
    ...cod,
    id: 'cod',
    capabilities: cod.capabilities,
    createPayment: cod.createPayment.bind(cod),
    capturePayment: cod.capturePayment.bind(cod),
    refundPayment: async () => outcome,
    verifyWebhook: cod.verifyWebhook.bind(cod),
    fetchStatus: cod.fetchStatus.bind(cod),
  } as PaymentGateway;
}

suite('payment operations', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture('payops');
  });
  afterAll(async () => {
    await f.cleanup();
    await closeTestPools();
  });

  /** Places a COD order and returns its id plus total. */
  async function placeOrder(price = 100_000, quantity = 1) {
    const variantId = await f.variant({ price, onHand: 10 });
    const cartId = await asTenant(f.tenantId, async (tx) => {
      const id = await getOrCreateCart(tx, f.ctx, { sessionToken: `s-${Math.random()}` });
      await addItem(tx, f.ctx, id, { variantId, quantity });
      return id;
    });

    return asTenant(f.tenantId, async (tx) => {
      const cart = await getCart(tx, f.ctx, cartId);
      return completeCheckout(
        tx,
        f.ctx,
        { type: 'customer', label: 'test' },
        {
          cartId,
          idempotencyKey: `k-${cartId}`,
          expectedTotal: cart.pricing.total.amount,
          paymentProvider: 'cod',
          phone: UAE_ADDRESS.phone,
          shippingAddress: UAE_ADDRESS,
        },
        new CashOnDeliveryGateway(),
        URLS,
      );
    });
  }

  async function orderRow(orderId: string) {
    const rows = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ payment_status: string; paid_total: string; refunded_total: string }>(sql`
        SELECT payment_status, paid_total, refunded_total FROM orders WHERE id = ${orderId}
      `),
    );
    const r = rows.rows[0]!;
    return {
      paymentStatus: r.payment_status,
      paid: Number(r.paid_total),
      refunded: Number(r.refunded_total),
    };
  }

  /* ───────────────────────── COD collection ───────────────────────── */

  it('records cash on delivery and derives paid status from the ledger', async () => {
    const order = await placeOrder();
    expect((await orderRow(order.orderId)).paymentStatus).toBe('unpaid');

    await asTenant(f.tenantId, (tx) => recordCodCollection(tx, f.ctx, ACTOR, order.orderId));

    const after = await orderRow(order.orderId);
    expect(after.paymentStatus).toBe('paid');
    expect(after.paid).toBe(order.total);

    // The status must be backed by a real ledger row, not just a column write.
    const ledger = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ kind: string; amount: string; status: string }>(sql`
        SELECT kind, amount, status FROM transactions WHERE order_id = ${order.orderId}
      `),
    );
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]!.kind).toBe('capture');
    expect(Number(ledger.rows[0]!.amount)).toBe(order.total);
  });

  it('refuses to collect the same cash twice', async () => {
    const order = await placeOrder();
    await asTenant(f.tenantId, (tx) => recordCodCollection(tx, f.ctx, ACTOR, order.orderId));

    // A courier reconciliation run that double-submits must not double-count
    // revenue — this is the assertion that keeps the day's takings honest.
    await expect(
      asTenant(f.tenantId, (tx) => recordCodCollection(tx, f.ctx, ACTOR, order.orderId)),
    ).rejects.toThrow(/already/i);

    expect((await orderRow(order.orderId)).paid).toBe(order.total);
  });

  /* ───────────────────────────── Refunds ──────────────────────────── */

  it('refunds in full and marks the order refunded', async () => {
    const order = await placeOrder();
    await asTenant(f.tenantId, (tx) => recordCodCollection(tx, f.ctx, ACTOR, order.orderId));

    const result = await asTenant(f.tenantId, (tx) =>
      refundOrder(tx, f.ctx, ACTOR, order.orderId, { reason: 'Customer returned the item' }),
    );

    expect(result.amount).toBe(order.total); // defaults to the full refundable balance
    expect(result.status).toBe('succeeded');

    const after = await orderRow(order.orderId);
    expect(after.refunded).toBe(order.total);
    expect(after.paymentStatus).toBe('refunded');
  });

  it('supports a partial refund and reports the remaining balance', async () => {
    const order = await placeOrder(100_000, 2); // AED 2,000 total
    await asTenant(f.tenantId, (tx) => recordCodCollection(tx, f.ctx, ACTOR, order.orderId));

    await asTenant(f.tenantId, (tx) =>
      refundOrder(tx, f.ctx, ACTOR, order.orderId, { amount: 50_000, reason: 'One item faulty' }),
    );

    const after = await orderRow(order.orderId);
    expect(after.refunded).toBe(50_000);
    expect(after.paymentStatus).toBe('partially_refunded');

    // A second partial refund stacks rather than replacing the first.
    await asTenant(f.tenantId, (tx) =>
      refundOrder(tx, f.ctx, ACTOR, order.orderId, { amount: 25_000, reason: 'Goodwill' }),
    );
    expect((await orderRow(order.orderId)).refunded).toBe(75_000);
  });

  it('refuses to refund more than was captured', async () => {
    const order = await placeOrder(100_000, 1);
    await asTenant(f.tenantId, (tx) => recordCodCollection(tx, f.ctx, ACTOR, order.orderId));

    await expect(
      asTenant(f.tenantId, (tx) =>
        refundOrder(tx, f.ctx, ACTOR, order.orderId, {
          amount: order.total + 1,
          reason: 'Fat finger',
        }),
      ),
    ).rejects.toThrow(/most that can be refunded|exceeds/i);

    expect((await orderRow(order.orderId)).refunded).toBe(0);
  });

  it('refuses to refund across two calls beyond the captured total', async () => {
    // The realistic version of over-refunding: each refund looks fine alone.
    const order = await placeOrder(100_000, 1);
    await asTenant(f.tenantId, (tx) => recordCodCollection(tx, f.ctx, ACTOR, order.orderId));

    await asTenant(f.tenantId, (tx) =>
      refundOrder(tx, f.ctx, ACTOR, order.orderId, { amount: 80_000, reason: 'Partial' }),
    );
    await expect(
      asTenant(f.tenantId, (tx) =>
        refundOrder(tx, f.ctx, ACTOR, order.orderId, { amount: 80_000, reason: 'Again' }),
      ),
    ).rejects.toThrow();

    expect((await orderRow(order.orderId)).refunded).toBe(80_000);
  });

  it('refuses to refund an order that was never paid', async () => {
    const order = await placeOrder();
    await expect(
      asTenant(f.tenantId, (tx) =>
        refundOrder(tx, f.ctx, ACTOR, order.orderId, { reason: 'Nothing to give back' }),
      ),
    ).rejects.toThrow(/nothing has been captured|cannot be refunded/i);
  });

  it('requires a reason', async () => {
    const order = await placeOrder();
    await asTenant(f.tenantId, (tx) => recordCodCollection(tx, f.ctx, ACTOR, order.orderId));

    await expect(
      asTenant(f.tenantId, (tx) =>
        refundOrder(tx, f.ctx, ACTOR, order.orderId, { reason: '   ' }),
      ),
    ).rejects.toThrow(/reason/i);
  });

  it('writes nothing when the gateway refuses the refund', async () => {
    const order = await placeOrder();
    await asTenant(f.tenantId, (tx) => recordCodCollection(tx, f.ctx, ACTOR, order.orderId));

    await expect(
      asTenant(f.tenantId, (tx) =>
        refundOrder(
          tx,
          f.ctx,
          ACTOR,
          order.orderId,
          { amount: 10_000, reason: 'Gateway down' },
          refundGateway({ kind: 'failed', code: 'card_error', message: 'Issuer declined' }),
        ),
      ),
    ).rejects.toThrow(/issuer declined/i);

    // The whole transaction rolled back: no ledger row, no status change. A
    // refund recorded locally but never issued at the gateway is money the
    // books say went out and the customer never received.
    const after = await orderRow(order.orderId);
    expect(after.refunded).toBe(0);
    expect(after.paymentStatus).toBe('paid');
  });

  it('holds a pending gateway refund out of the refunded total until it settles', async () => {
    const order = await placeOrder();
    await asTenant(f.tenantId, (tx) => recordCodCollection(tx, f.ctx, ACTOR, order.orderId));

    const result = await asTenant(f.tenantId, (tx) =>
      refundOrder(
        tx,
        f.ctx,
        ACTOR,
        order.orderId,
        { amount: 30_000, reason: 'Slow rail' },
        refundGateway({ kind: 'pending', reference: 'rf_pending_1' }),
      ),
    );

    expect(result.status).toBe('pending');

    // Counted as returned only once the gateway confirms — otherwise the order
    // would claim the customer has money back while it is still in transit.
    const after = await orderRow(order.orderId);
    expect(after.refunded).toBe(0);
    expect(after.paymentStatus).toBe('paid');

    const pending = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ status: string }>(sql`
        SELECT status FROM transactions WHERE order_id = ${order.orderId} AND kind = 'refund'
      `),
    );
    expect(pending.rows[0]!.status).toBe('pending');
  });

  it('links each refund to the capture it reverses', async () => {
    const order = await placeOrder();
    await asTenant(f.tenantId, (tx) => recordCodCollection(tx, f.ctx, ACTOR, order.orderId));
    await asTenant(f.tenantId, (tx) =>
      refundOrder(tx, f.ctx, ACTOR, order.orderId, { amount: 10_000, reason: 'Partial' }),
    );

    // Without the parent link a statement cannot show which payment a refund
    // belongs to, which is exactly what reconciliation needs.
    const rows = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ id: string; kind: string; parent: string | null }>(sql`
        SELECT id, kind, parent_transaction_id AS parent FROM transactions
        WHERE order_id = ${order.orderId} ORDER BY created_at
      `),
    );
    const refund = rows.rows.find((r) => r.kind === 'refund')!;
    const capture = rows.rows.find((r) => r.kind === 'capture')!;
    expect(refund.parent).toBe(capture.id);
  });

  it('records a public order event a customer can be shown', async () => {
    const order = await placeOrder();
    await asTenant(f.tenantId, (tx) => recordCodCollection(tx, f.ctx, ACTOR, order.orderId));
    await asTenant(f.tenantId, (tx) =>
      refundOrder(tx, f.ctx, ACTOR, order.orderId, { reason: 'Returned in store' }),
    );

    const events = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ type: string; is_public: boolean; message: string }>(sql`
        SELECT type, is_public, message FROM order_events
        WHERE order_id = ${order.orderId} AND type IN ('payment.captured', 'payment.refunded')
        ORDER BY created_at
      `),
    );
    expect(events.rows.map((e) => e.type)).toEqual(['payment.captured', 'payment.refunded']);
    expect(events.rows.every((e) => e.is_public)).toBe(true);
    expect(events.rows[1]!.message).toContain('Returned in store');
  });
});
