import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { CashOnDeliveryGateway } from '@voltix/payments';
import { addItem, getOrCreateCart } from './cart';
import { completeCheckout } from './checkout';
import { recordCodCollection } from './payment-ops';
import { createReturn, transitionReturn } from './returns';
import {
  closeTestPools,
  createFixture,
  databaseAvailable,
  ownerDb,
  UAE_ADDRESS,
  type Fixture,
} from './test-support';
import type { ActorContext } from './types';

/**
 * RETURNS — against real Postgres.
 *
 * This module moves money and stock, so the tests exercise the whole lifecycle
 * rather than each function alone. The properties worth protecting are the ones
 * a spreadsheet would catch a week later and a customer would catch immediately:
 * you cannot return more than was bought, a damaged item does not silently
 * become sellable stock again, and a refund happens once.
 */

const available = await databaseAvailable();
const suite = available ? describe : describe.skip;
if (!available) console.warn('\n  ⚠ Postgres unreachable — returns tests skipped.\n');

const ACTOR: ActorContext = { type: 'staff', id: undefined, label: 'returns-test' };
const URLS = {
  returnUrl: 'http://localhost:3000/checkout/return',
  cancelUrl: 'http://localhost:3000/cart',
  webhookUrl: 'http://localhost:3000/api/webhooks/cod',
};

/** Places a paid COD order for `quantity` units and returns its ids. */
async function paidOrder(f: Fixture, quantity: number, price = 100_000) {
  const variantId = await f.variant({ price, onHand: 20, cost: 60_000 });

  const result = await ownerDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${f.tenantId}, true)`);
    // getOrCreateCart returns the id itself, not a row.
    const cartId = await getOrCreateCart(tx, f.ctx, { sessionToken: `ret-${Date.now()}-${Math.random()}` });
    await addItem(tx, f.ctx, cartId, { variantId, quantity });

    const checkout = await completeCheckout(
      tx,
      f.ctx,
      ACTOR,
      {
        cartId,
        idempotencyKey: `ret-${cartId}`,
        expectedTotal: price * quantity,
        paymentProvider: 'cod',
        phone: '+971501234567',
        shippingAddress: UAE_ADDRESS,
      },
      new CashOnDeliveryGateway(),
      URLS,
    );

    // Collect the cash, so there is something to refund.
    await recordCodCollection(tx, f.ctx, ACTOR, checkout.orderId);

    const items = await tx.execute<{ id: string }>(sql`
      SELECT id FROM order_items WHERE order_id = ${checkout.orderId}
    `);
    return { orderId: checkout.orderId, variantId, orderItemId: items.rows[0]!.id };
  });

  return result;
}

suite('returns', () => {
  const fixtures: Fixture[] = [];
  const fixture = async (label: string) => {
    const f = await createFixture(label);
    fixtures.push(f);
    return f;
  };

  afterAll(async () => {
    for (const f of fixtures) await f.cleanup();
    await closeTestPools();
  });

  it('refuses to return more than was bought', async () => {
    const f = await fixture('ret-over');
    const { orderId, orderItemId } = await paidOrder(f, 2);

    await expect(
      ownerDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', ${f.tenantId}, true)`);
        return createReturn(tx, f.ctx, ACTOR, {
          orderId,
          reason: 'damaged',
          resolution: 'refund',
          lines: [{ orderItemId, quantity: 3 }], // only 2 were bought
        });
      }),
    ).rejects.toThrow(/returnable/i);
  });

  it('refuses a zero or fractional quantity', async () => {
    const f = await fixture('ret-qty');
    const { orderId, orderItemId } = await paidOrder(f, 1);

    for (const quantity of [0, -1, 1.5]) {
      await expect(
        ownerDb().transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.tenant_id', ${f.tenantId}, true)`);
          return createReturn(tx, f.ctx, ACTOR, {
            orderId,
            reason: 'changed_mind',
            resolution: 'refund',
            lines: [{ orderItemId, quantity }],
          });
        }),
      ).rejects.toThrow();
    }
  });

  it('rejects an illegal status jump', async () => {
    // requested → completed skips receiving the parcel, which is the whole
    // point of the process: it would refund for goods nobody has seen.
    const f = await fixture('ret-jump');
    const { orderId, orderItemId } = await paidOrder(f, 1);

    const created = await ownerDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${f.tenantId}, true)`);
      return createReturn(tx, f.ctx, ACTOR, {
        orderId,
        reason: 'defective',
        resolution: 'refund',
        lines: [{ orderItemId, quantity: 1 }],
      });
    });

    await expect(
      ownerDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', ${f.tenantId}, true)`);
        return transitionReturn(tx, f.ctx, ACTOR, created.id, 'completed');
      }),
    ).rejects.toThrow(/cannot be marked|Cannot move/i);
  });

  it('a full lifecycle refunds once and restocks a good unit', async () => {
    const f = await fixture('ret-happy');
    const { orderId, orderItemId, variantId } = await paidOrder(f, 1, 100_000);

    const before = await ownerDb().execute<{ on_hand: number }>(sql`
      SELECT sum(on_hand)::int AS on_hand FROM stock_levels WHERE variant_id = ${variantId}
    `);
    const stockBefore = Number(before.rows[0]!.on_hand);

    const created = await ownerDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${f.tenantId}, true)`);
      return createReturn(tx, f.ctx, ACTOR, {
        orderId,
        reason: 'changed_mind',
        resolution: 'refund',
        lines: [{ orderItemId, quantity: 1 }],
      });
    });
    expect(created.number).toMatch(/^RET-\d{4}-/);

    for (const step of ['approved', 'received', 'inspected'] as const) {
      await ownerDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', ${f.tenantId}, true)`);
        // The inspection says the unit is fine, so it may go back on the shelf.
        await transitionReturn(tx, f.ctx, ACTOR, created.id, step, {
          ...(step === 'inspected' ? { restockable: true, inspectionNote: 'unopened' } : {}),
        });
      });
    }

    // Receiving the parcel is what marks the units returned.
    const returnedQty = await ownerDb().execute<{ q: number }>(sql`
      SELECT quantity_returned AS q FROM order_items WHERE id = ${orderItemId}
    `);
    expect(Number(returnedQty.rows[0]!.q)).toBe(1);

    await ownerDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${f.tenantId}, true)`);
      await transitionReturn(tx, f.ctx, ACTOR, created.id, 'completed');
    });

    // Stock came back, and the movement was recorded — an unexplained stock
    // change is what makes a stock-take argument unresolvable.
    const after = await ownerDb().execute<{ on_hand: number }>(sql`
      SELECT sum(on_hand)::int AS on_hand FROM stock_levels WHERE variant_id = ${variantId}
    `);
    expect(Number(after.rows[0]!.on_hand)).toBe(stockBefore + 1);

    const movements = await ownerDb().execute<{ delta: number; reason: string }>(sql`
      SELECT delta, reason FROM stock_movements
      WHERE variant_id = ${variantId} AND reason = 'return_restock'
    `);
    expect(movements.rows).toHaveLength(1);
    expect(Number(movements.rows[0]!.delta)).toBe(1);

    // Exactly one refund, for the line value.
    const refunds = await ownerDb().execute<{ amount: string; kind: string }>(sql`
      SELECT amount, kind FROM transactions
      WHERE order_id = ${orderId} AND kind = 'refund'
    `);
    expect(refunds.rows).toHaveLength(1);
    expect(Number(refunds.rows[0]!.amount)).toBe(100_000);

    const order = await ownerDb().execute<{ refunded_total: string; payment_status: string }>(sql`
      SELECT refunded_total, payment_status FROM orders WHERE id = ${orderId}
    `);
    expect(Number(order.rows[0]!.refunded_total)).toBe(100_000);
    expect(order.rows[0]!.payment_status).toBe('refunded');
  });

  it('a damaged unit is refunded but NOT put back on the shelf', async () => {
    // The property that keeps a catalogue from selling broken goods. Undecided
    // is not a yes: `restockable` left unset must not restock either.
    const f = await fixture('ret-damaged');
    const { orderId, orderItemId, variantId } = await paidOrder(f, 1, 80_000);

    const before = await ownerDb().execute<{ on_hand: number }>(sql`
      SELECT sum(on_hand)::int AS on_hand FROM stock_levels WHERE variant_id = ${variantId}
    `);
    const stockBefore = Number(before.rows[0]!.on_hand);

    const created = await ownerDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${f.tenantId}, true)`);
      return createReturn(tx, f.ctx, ACTOR, {
        orderId,
        reason: 'damaged',
        resolution: 'refund',
        lines: [{ orderItemId, quantity: 1 }],
      });
    });

    for (const step of ['approved', 'received', 'inspected', 'completed'] as const) {
      await ownerDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', ${f.tenantId}, true)`);
        await transitionReturn(tx, f.ctx, ACTOR, created.id, step, {
          ...(step === 'inspected'
            ? { restockable: false, inspectionNote: 'screen cracked in transit' }
            : {}),
        });
      });
    }

    const after = await ownerDb().execute<{ on_hand: number }>(sql`
      SELECT sum(on_hand)::int AS on_hand FROM stock_levels WHERE variant_id = ${variantId}
    `);
    expect(Number(after.rows[0]!.on_hand)).toBe(stockBefore); // unchanged

    // The customer is still made whole — the damage is the merchant's problem.
    const refunds = await ownerDb().execute<{ amount: string }>(sql`
      SELECT amount FROM transactions WHERE order_id = ${orderId} AND kind = 'refund'
    `);
    expect(refunds.rows).toHaveLength(1);
    expect(Number(refunds.rows[0]!.amount)).toBe(80_000);
  });

  it('an exchange returns goods without returning money', async () => {
    const f = await fixture('ret-exchange');
    const { orderId, orderItemId } = await paidOrder(f, 1, 50_000);

    const created = await ownerDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${f.tenantId}, true)`);
      return createReturn(tx, f.ctx, ACTOR, {
        orderId,
        reason: 'wrong_item',
        resolution: 'exchange',
        lines: [{ orderItemId, quantity: 1 }],
      });
    });

    for (const step of ['approved', 'received', 'inspected', 'completed'] as const) {
      await ownerDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', ${f.tenantId}, true)`);
        await transitionReturn(tx, f.ctx, ACTOR, created.id, step, {
          ...(step === 'inspected' ? { restockable: true } : {}),
        });
      });
    }

    const refunds = await ownerDb().execute(sql`
      SELECT 1 FROM transactions WHERE order_id = ${orderId} AND kind = 'refund'
    `);
    expect(refunds.rows).toHaveLength(0);
  });

  it('two partial returns cannot together exceed what was bought', async () => {
    const f = await fixture('ret-partial');
    const { orderId, orderItemId } = await paidOrder(f, 3);

    // Return 2 of 3, all the way through to received.
    const first = await ownerDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${f.tenantId}, true)`);
      return createReturn(tx, f.ctx, ACTOR, {
        orderId,
        reason: 'changed_mind',
        resolution: 'refund',
        lines: [{ orderItemId, quantity: 2 }],
      });
    });
    for (const step of ['approved', 'received'] as const) {
      await ownerDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', ${f.tenantId}, true)`);
        await transitionReturn(tx, f.ctx, ACTOR, first.id, step);
      });
    }

    // One left. Asking for two must fail.
    await expect(
      ownerDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', ${f.tenantId}, true)`);
        return createReturn(tx, f.ctx, ACTOR, {
          orderId,
          reason: 'changed_mind',
          resolution: 'refund',
          lines: [{ orderItemId, quantity: 2 }],
        });
      }),
    ).rejects.toThrow(/returnable/i);

    // Exactly one is fine.
    await expect(
      ownerDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', ${f.tenantId}, true)`);
        return createReturn(tx, f.ctx, ACTOR, {
          orderId,
          reason: 'changed_mind',
          resolution: 'refund',
          lines: [{ orderItemId, quantity: 1 }],
        });
      }),
    ).resolves.toBeDefined();
  });
});
