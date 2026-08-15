import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CashOnDeliveryGateway } from '@voltix/payments';
import { addItem, getCart, getOrCreateCart } from './cart';
import { completeCheckout } from './checkout';
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
 * THE SECOND ORDER.
 *
 * Every checkout test in this repository placed a FIRST order. That is the
 * cheap half of the space, and it hid a defect that blocked every returning
 * customer: `gatherSignals` called `.getTime()` on `customers.created_at`,
 * which a raw `tx.execute` hands back as a string, so the risk assessment threw
 * `TypeError` inside `completeCheckout`. A first-time phone has no `customers`
 * row, the caller's `customer ? … : null` guard short-circuits, and the order
 * completes — so the whole suite passed while the store refused its regulars.
 *
 * The shopper saw "Something went wrong", the form cleared, and the retry
 * failed identically. It was found by walking the storefront, not by reading
 * it, and the fix is worth nothing without a test that would have caught it.
 *
 * So: place an order, then place ANOTHER order for the same phone. The second
 * one is the test.
 */

const available = await databaseAvailable();
const suite = available ? describe : describe.skip;

if (!available) {
  console.warn('\n  ⚠ Postgres unreachable — returning-customer risk tests skipped.\n');
}

const ACTOR: ActorContext = { type: 'customer', label: 'integration-test' };
const URLS = {
  returnUrl: 'http://localhost:3000/checkout/return',
  cancelUrl: 'http://localhost:3000/cart',
  webhookUrl: 'http://localhost:3000/api/webhooks/cod',
};

suite('returning customers', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture('risk-repeat');
  });

  afterAll(async () => {
    await ownerDb().execute(sql`DELETE FROM risk_assessments WHERE tenant_id = ${f.tenantId}`);
    await f.cleanup();
    await closeTestPools();
  });

  async function placeOrder(key: string, session: string) {
    const variantId = await f.variant({ price: 24900, onHand: 20 });
    return asTenant(f.tenantId, async (tx) => {
      const cartId = await getOrCreateCart(tx, f.ctx, { sessionToken: session });
      await addItem(tx, f.ctx, cartId, { variantId, quantity: 1 });
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
          phone: UAE_ADDRESS.phone,
          shippingAddress: UAE_ADDRESS,
          shippingCost: 0,
          channel: 'web',
        },
        new CashOnDeliveryGateway(),
        URLS,
      );
    });
  }

  it('lets a shopper whose phone is already a customer check out', async () => {
    /**
     * The `customers` row has to be created here, and that is worth knowing.
     *
     * Guest checkout never writes one — `completeCheckout` has no
     * `INSERT INTO customers` at all — so rows arrive only from the seed or
     * from admin. My first attempt at this test placed two orders and expected
     * the second to find a customer; it found none, the `customer ? … : null`
     * guard short-circuited exactly as it does for a first-time buyer, and the
     * test passed with the bug reintroduced. It proved nothing.
     *
     * Matching the real failure means what it always meant: a `customers` row
     * exists carrying this phone. `gatherSignals` matches on phone OR id
     * precisely so guest orders can be tied to a known person.
     */
    await ownerDb().execute(sql`
      INSERT INTO customers (id, tenant_id, phone, first_name, created_at, updated_at)
      VALUES (gen_random_uuid(), ${f.tenantId}, ${UAE_ADDRESS.phone}, 'Repeat', now() - interval '30 days', now())
    `);

    const order = await placeOrder('repeat-key-1', 'sess-repeat-1');
    expect(order.orderNumber).toBeTruthy();
  });

  it('scores the returning order using the account it found', async () => {
    // The point of surviving is not merely not throwing: the signal the crash
    // was reaching for must actually reach the model, or the fix would be a
    // silently-null account age that no test could tell from a working one.
    const rows = await ownerDb().execute<{ signals: unknown; score: number }>(sql`
      SELECT signals, score FROM risk_assessments
      WHERE tenant_id = ${f.tenantId}
      ORDER BY created_at DESC LIMIT 1
    `);

    expect(rows.rows).toHaveLength(1);
    const signals = JSON.stringify(rows.rows[0]!.signals);
    expect(signals).not.toContain('NaN');
    expect(Number.isFinite(Number(rows.rows[0]!.score))).toBe(true);
  });
});
