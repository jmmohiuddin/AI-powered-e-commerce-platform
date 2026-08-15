import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CashOnDeliveryGateway, type PaymentGateway, type PaymentOutcome } from '@voltix/payments';
import { addItem, getCart, getOrCreateCart } from './cart';
import { completeCheckout } from './checkout';
import { recordCodCollection } from './payment-ops';
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
 * THE COD RISK CONTROL, END TO END.
 *
 * Cash-on-delivery refusal is the merchant's single largest loss: the parcel is
 * picked, packed, carried, refused and returned, and they pay round-trip
 * freight for nothing. The platform has always *had* the two controls for it —
 * a risk model and an eligibility gate with a deposit — and neither ran. The
 * model had no caller and the gate was consulted only while drawing the payment
 * options, which is a display decision, not enforcement.
 *
 * So these tests do not assert that the functions exist. They assert that a
 * form post naming `cod` is actually stopped, and that a deposit actually
 * splits the money.
 */

const available = await databaseAvailable();
const suite = available ? describe : describe.skip;

if (!available) {
  console.warn(
    '\n  ⚠ Postgres unreachable — COD advance integration tests skipped.\n' +
      '    Run `npm run infra:up && npm run db:migrate` to enable them.\n',
  );
}

const ACTOR: ActorContext = { type: 'customer', label: 'integration-test' };
const STAFF: ActorContext = { type: 'staff', label: 'integration-test' };
const URLS = {
  returnUrl: 'http://localhost:3000/checkout/return',
  cancelUrl: 'http://localhost:3000/cart',
  webhookUrl: 'http://localhost:3000/api/webhooks/cod',
  advanceWebhookUrl: 'http://localhost:3000/api/webhooks/stripe',
};

/** Stands in for a card gateway, so the deposit leg has something to charge. */
function cardGateway(outcome: PaymentOutcome): PaymentGateway {
  const cod = new CashOnDeliveryGateway();
  return {
    ...cod,
    id: 'stripe',
    displayName: 'Test card',
    capabilities: { ...cod.capabilities, isDeferredSettlement: false },
    createPayment: async () => outcome,
    capturePayment: async () => outcome,
    refundPayment: async () => ({ kind: 'succeeded', reference: 'r' }),
    verifyWebhook: cod.verifyWebhook.bind(cod),
    fetchStatus: cod.fetchStatus.bind(cod),
    // Deliberately no `eligibility` — only the COD adapter gates, and the
    // checkout must not assume every gateway does.
  } as PaymentGateway;
}

suite('cash on delivery risk gate', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture('cod-risk');
  });
  afterAll(async () => {
    await ownerDb().execute(sql`DELETE FROM risk_assessments WHERE tenant_id = ${f.tenantId}`);
    await f.cleanup();
    await closeTestPools();
  });

  async function cartWith(variantId: string, quantity: number, session: string): Promise<string> {
    return asTenant(f.tenantId, async (tx) => {
      const cartId = await getOrCreateCart(tx, f.ctx, { sessionToken: session });
      await addItem(tx, f.ctx, cartId, { variantId, quantity });
      return cartId;
    });
  }

  function place(
    cartId: string,
    key: string,
    gateway: PaymentGateway,
    advanceGateway?: PaymentGateway,
    address = UAE_ADDRESS,
  ) {
    return asTenant(f.tenantId, async (tx) => {
      const cart = await getCart(tx, f.ctx, cartId);
      return completeCheckout(
        tx,
        f.ctx,
        ACTOR,
        {
          cartId,
          idempotencyKey: key,
          expectedTotal: cart.pricing.total.amount,
          paymentProvider: 'cod',
          phone: address.phone,
          shippingAddress: address,
          ...(advanceGateway ? { advancePaymentProvider: 'stripe' } : {}),
        },
        gateway,
        URLS,
        advanceGateway,
      );
    });
  }

  it('scores every order and stores the signals, not just the number', async () => {
    const variantId = await f.variant({ price: 99_900, onHand: 5 });
    const cartId = await cartWith(variantId, 1, 'risk-plain');

    const result = await place(cartId, 'risk-plain', new CashOnDeliveryGateway());

    const row = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ risk_score: number; risk_signals: { decision: string; signals: unknown[] } }>(
        sql`SELECT risk_score, risk_signals FROM orders WHERE id = ${result.orderId}`,
      ),
    );
    expect(Number(row.rows[0]!.risk_score)).toBe(result.riskScore);
    // Explainability is the requirement, not the score. A merchant phoning a
    // customer needs the reasons, and a re-fit later needs them even more.
    expect(row.rows[0]!.risk_signals.decision).toBeTruthy();
    expect(Array.isArray(row.rows[0]!.risk_signals.signals)).toBe(true);

    const assessments = await ownerDb().execute<{ n: number; decision: string }>(sql`
      SELECT count(*)::int AS n, min(decision) AS decision FROM risk_assessments
      WHERE entity_type = 'order' AND entity_id = ${result.orderId}
    `);
    expect(Number(assessments.rows[0]!.n)).toBe(1);
  });

  /**
   * The gate has to bite on the *server*, not in the payment picker.
   *
   * This posts `cod` for an order well over the ceiling, exactly as a replayed
   * or hand-rolled form post would. Before this work it went straight through.
   */
  it('refuses cash on delivery above the ceiling, and says what to do instead', async () => {
    const variantId = await f.variant({ price: 900_000, onHand: 3 });
    const cartId = await cartWith(variantId, 1, 'risk-ceiling');

    const attempt = place(cartId, 'risk-ceiling', new CashOnDeliveryGateway({ maxOrderAmount: 500_000 }));

    // Requirement S-05: the refusal names the alternative in the same message.
    await expect(attempt).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      publicMessage: expect.stringContaining('pay online'),
    });

    // Refused before anything was held — the shopper can pick another method
    // and the unit never left the shelf.
    const stock = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ reserved: number }>(
        sql`SELECT reserved FROM stock_levels WHERE variant_id = ${variantId}`,
      ),
    );
    expect(Number(stock.rows[0]!.reserved)).toBe(0);
  });

  it('refuses to guess which card a deposit should go on', async () => {
    const variantId = await f.variant({ price: 200_000, onHand: 3 });
    const cartId = await cartWith(variantId, 1, 'risk-noadvance');

    // 25% standing policy, and no gateway offered to charge it.
    const attempt = place(
      cartId,
      'risk-noadvance',
      new CashOnDeliveryGateway({ advancePaymentBps: 2500 }),
    );

    await expect(attempt).rejects.toMatchObject({ code: 'ADVANCE_REQUIRED' });
  });

  /**
   * The whole point of the feature.
   *
   * A deposit taken on a card, the rest owed to the courier, and — the part
   * that was broken until the capture stopped being written as the order total
   * — an order that reads `partially_paid` rather than `paid`.
   */
  it('splits a deposit from the cash, and reports the order as partially paid', async () => {
    const variantId = await f.variant({ price: 400_000, onHand: 3 });
    const cartId = await cartWith(variantId, 1, 'risk-split');

    const result = await place(
      cartId,
      'risk-split',
      new CashOnDeliveryGateway({ advancePaymentBps: 2500 }),
      cardGateway({ kind: 'succeeded', reference: 'pi_advance_1' }),
    );

    const total = result.total;
    expect(result.advanceDue).toBe(Math.round(total * 0.25));
    expect(result.codDue).toBe(total - Math.round(total * 0.25));
    expect(result.payment.kind).toBe('succeeded');
    expect(result.codPayment?.kind).toBe('deferred');

    const order = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ status: string; payment_status: string; paid_total: number }>(
        sql`SELECT status, payment_status, paid_total FROM orders WHERE id = ${result.orderId}`,
      ),
    );
    expect(order.rows[0]!.status).toBe('confirmed');
    // Not 'paid'. The courier still has money to collect, and an order marked
    // paid here is one nobody ever chases.
    expect(order.rows[0]!.payment_status).toBe('partially_paid');
    expect(Number(order.rows[0]!.paid_total)).toBe(result.advanceDue);

    // Two intents, one order — the card leg and the cash leg have different
    // lifecycles and cannot share a status.
    const intents = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ provider: string; amount: number }>(sql`
        SELECT provider, amount FROM payment_intents
        WHERE order_id = ${result.orderId} ORDER BY amount
      `),
    );
    expect(intents.rows.map((r) => r.provider).sort()).toEqual(['cod', 'stripe']);

    // Stock is committed: the parcel is going out on these terms.
    const stock = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ on_hand: number; reserved: number }>(
        sql`SELECT on_hand, reserved FROM stock_levels WHERE variant_id = ${variantId}`,
      ),
    );
    expect(Number(stock.rows[0]!.on_hand)).toBe(2);
    expect(Number(stock.rows[0]!.reserved)).toBe(0);

    /**
     * And the loop closes: the courier remits the balance, and the existing
     * admin flow — which already computes `total − paid` — settles it without
     * knowing a deposit was ever involved.
     */
    await asTenant(f.tenantId, (tx) => recordCodCollection(tx, f.ctx, STAFF, result.orderId));

    const settled = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ payment_status: string; paid_total: number }>(
        sql`SELECT payment_status, paid_total FROM orders WHERE id = ${result.orderId}`,
      ),
    );
    expect(settled.rows[0]!.payment_status).toBe('paid');
    expect(Number(settled.rows[0]!.paid_total)).toBe(total);
  });

  it('does not create a cash obligation when the deposit is declined', async () => {
    const variantId = await f.variant({ price: 400_000, onHand: 4 });
    const cartId = await cartWith(variantId, 2, 'risk-declined');

    const result = await place(
      cartId,
      'risk-declined',
      new CashOnDeliveryGateway({ advancePaymentBps: 2500 }),
      cardGateway({
        kind: 'failed',
        code: 'card_declined',
        message: 'Declined',
        retryable: false,
      }),
    );

    expect(result.payment.kind).toBe('failed');
    expect(result.codDue).toBe(0);

    // No cash leg was ever created. Dispatching on the terms the deposit
    // existed to avoid is the exact loss this feature prevents.
    const intents = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM payment_intents
        WHERE order_id = ${result.orderId} AND provider = 'cod'
      `),
    );
    expect(Number(intents.rows[0]!.n)).toBe(0);

    const stock = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ on_hand: number; reserved: number }>(
        sql`SELECT on_hand, reserved FROM stock_levels WHERE variant_id = ${variantId}`,
      ),
    );
    expect(Number(stock.rows[0]!.on_hand)).toBe(4);
    expect(Number(stock.rows[0]!.reserved)).toBe(0);
  });

  /**
   * A freight-forwarder delivery address on a high-value handset order.
   *
   * The UAE-specific signal that does not exist in other markets' fraud models,
   * and the reason the score is worth computing at all: nothing else about this
   * order looks unusual.
   */
  it('scores a re-export delivery address above an ordinary one', async () => {
    const variantId = await f.variant({ price: 600_000, onHand: 4 });

    const plainCart = await cartWith(variantId, 1, 'risk-plain-addr');
    const plain = await place(plainCart, 'risk-plain-addr', new CashOnDeliveryGateway());

    const forwarderCart = await cartWith(variantId, 1, 'risk-forwarder');
    const forwarder = await place(
      forwarderCart,
      'risk-forwarder',
      new CashOnDeliveryGateway(),
      undefined,
      {
        ...UAE_ADDRESS,
        // A different phone, so this reads as a different person rather than as
        // the same customer's second order.
        phone: '+971509876543',
        buildingName: 'Gulf Cargo & Freight Warehouse 12',
      },
    );

    expect(forwarder.riskScore!).toBeGreaterThan(plain.riskScore!);
  });
});
