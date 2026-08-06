import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CashOnDeliveryGateway, type PaymentGateway, type PaymentOutcome } from '@voltix/payments';
import { addItem, getCart, getOrCreateCart } from './cart';
import { completeCheckout } from './checkout';
import { claimJobs, enqueue, runOnce } from './jobs';
import { lookupOrder } from './orders';
import { orderNumber } from './numbering';
import { sweepExpiredReservations } from './reservations';
import {
  appDb,
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
 * INTEGRATION TESTS — real Postgres, restricted role, RLS active.
 *
 * These cover the properties that unit tests structurally cannot: row locking
 * under genuine concurrency, transactional rollback, and whether the database
 * actually refuses a cross-tenant read. Every one of them would pass against a
 * mock while the real system was broken.
 */

const available = await databaseAvailable();
const suite = available ? describe : describe.skip;

if (!available) {
  console.warn(
    '\n  ⚠ Postgres unreachable — integration tests skipped.\n' +
      '    Run `npm run infra:up && npm run db:migrate` to enable them.\n',
  );
}

const ACTOR: ActorContext = { type: 'customer', label: 'integration-test' };
const URLS = {
  returnUrl: 'http://localhost:3000/checkout/return',
  cancelUrl: 'http://localhost:3000/cart',
  webhookUrl: 'http://localhost:3000/api/webhooks/cod',
};

/** A gateway whose outcome the test dictates, so each branch is reachable. */
function scriptedGateway(outcome: PaymentOutcome): PaymentGateway {
  const cod = new CashOnDeliveryGateway();
  return {
    ...cod,
    id: 'cod',
    displayName: 'Test gateway',
    capabilities: cod.capabilities,
    createPayment: async () => outcome,
    capturePayment: async () => outcome,
    refundPayment: async () => ({ kind: 'succeeded', reference: 'r' }),
    verifyWebhook: cod.verifyWebhook.bind(cod),
    fetchStatus: cod.fetchStatus.bind(cod),
  } as PaymentGateway;
}

suite('tenant isolation (RLS)', () => {
  let a: Fixture;
  let b: Fixture;

  beforeAll(async () => {
    a = await createFixture('rls-a');
    b = await createFixture('rls-b');
    await a.variant({ price: 469_900, onHand: 5 });
    await b.variant({ price: 99_900, onHand: 5 });
  });
  afterAll(async () => {
    await a.cleanup();
    await b.cleanup();
  });

  /**
   * The test that must never be deleted.
   *
   * Everything about the multi-tenancy story rests on this being true. It is
   * also the test most likely to silently start passing for the wrong reason —
   * connect as a superuser and it passes while proving nothing — which is why
   * the harness connects as the restricted role.
   */
  it('refuses to return another tenant’s products', async () => {
    const own = await asTenant(a.tenantId, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM products`),
    );
    expect(Number(own.rows[0]!.n)).toBe(1);

    // Same query, same connection pool, different tenant context.
    const foreign = await asTenant(b.tenantId, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM products WHERE tenant_id = ${a.tenantId}`),
    );
    expect(Number(foreign.rows[0]!.n)).toBe(0);
  });

  it('returns nothing at all when no tenant context is set', async () => {
    // A forgotten `withTenant` must yield an empty result, never a leak.
    const result = await appDb().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM products`,
    );
    expect(Number(result.rows[0]!.n)).toBe(0);
  });

  it('refuses to write a row belonging to another tenant', async () => {
    // WITH CHECK is the half of the policy people forget. Without it a tenant
    // could not *read* another's rows but could happily create them.
    const attempt = asTenant(a.tenantId, (tx) =>
      tx.execute(sql`
        INSERT INTO warehouses (id, tenant_id, code, name, kind, priority, is_active, created_at, updated_at)
        VALUES (gen_random_uuid(), ${b.tenantId}, 'HACK', 'Injected', 'warehouse', 1, true, now(), now())
      `),
    );

    // Drizzle wraps the driver error, so assert on the Postgres error code:
    // 42501 is insufficient_privilege, which is what an RLS violation raises.
    await expect(attempt).rejects.toSatisfy(
      (error: unknown) => (error as { cause?: { code?: string } })?.cause?.code === '42501',
      'expected a Postgres RLS violation (42501)',
    );

    const injected = await ownerDb().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM warehouses WHERE code = 'HACK'`,
    );
    expect(Number(injected.rows[0]!.n)).toBe(0);
  });
});

suite('checkout', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture('checkout');
  });
  afterAll(async () => {
    await f.cleanup();
  });

  async function cartWith(variantId: string, quantity: number): Promise<string> {
    return asTenant(f.tenantId, async (tx) => {
      const cartId = await getOrCreateCart(tx, f.ctx, { sessionToken: `s-${Math.random()}` });
      await addItem(tx, f.ctx, cartId, { variantId, quantity });
      return cartId;
    });
  }

  it('places an order and commits stock on cash on delivery', async () => {
    const variantId = await f.variant({ price: 469_900, onHand: 5 });
    const cartId = await cartWith(variantId, 2);

    const result = await asTenant(f.tenantId, async (tx) => {
      const cart = await getCart(tx, f.ctx, cartId);
      return completeCheckout(
        tx,
        f.ctx,
        ACTOR,
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

    expect(result.orderNumber).toMatch(/^\d{5}$/);
    expect(result.payment.kind).toBe('deferred');

    const state = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ status: string; on_hand: number; reserved: number }>(sql`
        SELECT o.status,
               (SELECT on_hand FROM stock_levels WHERE variant_id = ${variantId}) AS on_hand,
               (SELECT reserved FROM stock_levels WHERE variant_id = ${variantId}) AS reserved
        FROM orders o WHERE o.id = ${result.orderId}
      `),
    );

    // COD is a promise to pay, but the parcel is going out — so the units leave
    // the shelf and the hold is released.
    expect(state.rows[0]!.status).toBe('confirmed');
    expect(Number(state.rows[0]!.on_hand)).toBe(3);
    expect(Number(state.rows[0]!.reserved)).toBe(0);
  });

  it('rejects a stale total instead of charging it', async () => {
    const variantId = await f.variant({ price: 99_900, onHand: 5 });
    const cartId = await cartWith(variantId, 1);

    await expect(
      asTenant(f.tenantId, (tx) =>
        completeCheckout(
          tx,
          f.ctx,
          ACTOR,
          {
            cartId,
            idempotencyKey: `stale-${cartId}`,
            // What a cached page from before a price change would have shown.
            expectedTotal: 49_900,
            paymentProvider: 'cod',
            phone: UAE_ADDRESS.phone,
            shippingAddress: UAE_ADDRESS,
          },
          new CashOnDeliveryGateway(),
          URLS,
        ),
      ),
    ).rejects.toMatchObject({ code: 'PRICE_CHANGED' });
  });

  it('rejects an undeliverable address before touching stock', async () => {
    const variantId = await f.variant({ price: 99_900, onHand: 5 });
    const cartId = await cartWith(variantId, 1);

    await expect(
      asTenant(f.tenantId, async (tx) => {
        const cart = await getCart(tx, f.ctx, cartId);
        return completeCheckout(
          tx,
          f.ctx,
          ACTOR,
          {
            cartId,
            idempotencyKey: `addr-${cartId}`,
            expectedTotal: cart.pricing.total.amount,
            paymentProvider: 'cod',
            phone: UAE_ADDRESS.phone,
            // No building name and no Makani — a courier cannot find this.
            shippingAddress: { ...UAE_ADDRESS, buildingName: undefined, makani: undefined },
          },
          new CashOnDeliveryGateway(),
          URLS,
        );
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const stock = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ reserved: number }>(
        sql`SELECT reserved FROM stock_levels WHERE variant_id = ${variantId}`,
      ),
    );
    expect(Number(stock.rows[0]!.reserved)).toBe(0);
  });

  it('releases the hold when payment fails', async () => {
    const variantId = await f.variant({ price: 99_900, onHand: 4 });
    const cartId = await cartWith(variantId, 2);

    const result = await asTenant(f.tenantId, async (tx) => {
      const cart = await getCart(tx, f.ctx, cartId);
      return completeCheckout(
        tx,
        f.ctx,
        ACTOR,
        {
          cartId,
          idempotencyKey: `fail-${cartId}`,
          expectedTotal: cart.pricing.total.amount,
          paymentProvider: 'cod',
          phone: UAE_ADDRESS.phone,
          shippingAddress: UAE_ADDRESS,
        },
        scriptedGateway({
          kind: 'failed',
          code: 'card_declined',
          message: 'Declined',
          retryable: false,
        }),
        URLS,
      );
    });

    const stock = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ on_hand: number; reserved: number }>(
        sql`SELECT on_hand, reserved FROM stock_levels WHERE variant_id = ${variantId}`,
      ),
    );
    // Stock returns to the shelf; the order stays as a record of the attempt.
    expect(Number(stock.rows[0]!.on_hand)).toBe(4);
    expect(Number(stock.rows[0]!.reserved)).toBe(0);
    expect(result.payment.kind).toBe('failed');
  });

  it('keeps the hold while the shopper is mid-redirect', async () => {
    const variantId = await f.variant({ price: 99_900, onHand: 3 });
    const cartId = await cartWith(variantId, 1);

    await asTenant(f.tenantId, async (tx) => {
      const cart = await getCart(tx, f.ctx, cartId);
      return completeCheckout(
        tx,
        f.ctx,
        ACTOR,
        {
          cartId,
          idempotencyKey: `redirect-${cartId}`,
          expectedTotal: cart.pricing.total.amount,
          paymentProvider: 'network',
          phone: UAE_ADDRESS.phone,
          shippingAddress: UAE_ADDRESS,
        },
        scriptedGateway({ kind: 'requires_action', reference: 'ref', redirectUrl: 'https://x' }),
        URLS,
      );
    });

    const stock = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ on_hand: number; reserved: number }>(
        sql`SELECT on_hand, reserved FROM stock_levels WHERE variant_id = ${variantId}`,
      ),
    );
    // Neither committed nor released — the TTL sweep decides if they never return.
    expect(Number(stock.rows[0]!.on_hand)).toBe(3);
    expect(Number(stock.rows[0]!.reserved)).toBe(1);
  });

  it('finds a guest order however the customer types their phone', async () => {
    const variantId = await f.variant({ price: 99_900, onHand: 5 });
    const cartId = await cartWith(variantId, 1);

    const order = await asTenant(f.tenantId, async (tx) => {
      const cart = await getCart(tx, f.ctx, cartId);
      return completeCheckout(
        tx,
        f.ctx,
        ACTOR,
        {
          cartId,
          idempotencyKey: `lookup-${cartId}`,
          expectedTotal: cart.pricing.total.amount,
          paymentProvider: 'cod',
          phone: UAE_ADDRESS.phone,
          shippingAddress: UAE_ADDRESS,
        },
        new CashOnDeliveryGateway(),
        URLS,
      );
    });

    // The order is stored E.164. A customer types whatever they type — and
    // being told your own order does not exist is a support call.
    for (const typed of ['0501234567', '501234567', '+971501234567', '+971 50 123 4567']) {
      const found = await asTenant(f.tenantId, (tx) =>
        lookupOrder(tx, f.ctx, order.orderNumber, typed),
      );
      expect(found?.number, `lookup failed for "${typed}"`).toBe(order.orderNumber);
    }

    // Right order number, wrong phone — the second factor has to actually gate.
    const wrong = await asTenant(f.tenantId, (tx) =>
      lookupOrder(tx, f.ctx, order.orderNumber, '0559999999'),
    );
    expect(wrong).toBeNull();
  });

  it('replays an identical request instead of ordering twice', async () => {
    const variantId = await f.variant({ price: 99_900, onHand: 5 });
    const cartId = await cartWith(variantId, 1);
    const key = `idem-${cartId}`;

    const request = async () =>
      asTenant(f.tenantId, async (tx) => {
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
          },
          new CashOnDeliveryGateway(),
          URLS,
        );
      });

    const first = await request();
    const second = await request();

    expect(second.replayed).toBe(true);
    expect(second.orderId).toBe(first.orderId);

    const orders = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM orders WHERE id = ${first.orderId}`,
      ),
    );
    expect(Number(orders.rows[0]!.n)).toBe(1);
  });
});

suite('concurrency', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture('concurrency');
  });
  afterAll(async () => {
    await f.cleanup();
  });

  /**
   * The oversell test.
   *
   * One unit, eight simultaneous checkouts. Exactly one may succeed. This is
   * the property that row-level locking exists for, and the one that cannot be
   * demonstrated without real concurrent transactions against a real database.
   */
  it('never oversells the last unit under concurrent checkout', async () => {
    const variantId = await f.variant({ price: 469_900, onHand: 1 });

    const carts = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        asTenant(f.tenantId, async (tx) => {
          const cartId = await getOrCreateCart(tx, f.ctx, { sessionToken: `race-${i}` });
          await addItem(tx, f.ctx, cartId, { variantId, quantity: 1 });
          return cartId;
        }),
      ),
    );

    const attempts = await Promise.allSettled(
      carts.map((cartId) =>
        asTenant(f.tenantId, async (tx) => {
          const cart = await getCart(tx, f.ctx, cartId);
          return completeCheckout(
            tx,
            f.ctx,
            ACTOR,
            {
              cartId,
              idempotencyKey: `race-${cartId}`,
              expectedTotal: cart.pricing.total.amount,
              paymentProvider: 'cod',
              phone: UAE_ADDRESS.phone,
              shippingAddress: UAE_ADDRESS,
            },
            new CashOnDeliveryGateway(),
            URLS,
          );
        }),
      ),
    );

    const succeeded = attempts.filter((a) => a.status === 'fulfilled');
    expect(succeeded).toHaveLength(1);

    const stock = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ on_hand: number; reserved: number }>(
        sql`SELECT on_hand, reserved FROM stock_levels WHERE variant_id = ${variantId}`,
      ),
    );
    expect(Number(stock.rows[0]!.on_hand)).toBe(0);
    // Never negative — the CHECK constraint would have caught it, but so should we.
    expect(Number(stock.rows[0]!.reserved)).toBe(0);
  });

  /**
   * Gap-free numbering under concurrency.
   *
   * A Postgres sequence would fail this: `nextval` does not roll back, so a
   * failed transaction burns its number and leaves a hole an auditor will ask
   * about.
   */
  it('issues sequential order numbers with no gaps or duplicates', async () => {
    const numbers = await Promise.all(
      Array.from({ length: 12 }, () => asTenant(f.tenantId, (tx) => orderNumber(tx, f.tenantId))),
    );

    const values = numbers.map(Number).sort((a, b) => a - b);
    expect(new Set(values).size).toBe(values.length);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBe(values[i - 1]! + 1);
    }
  });

  it('rolls the number back when the transaction fails', async () => {
    const before = Number(await asTenant(f.tenantId, (tx) => orderNumber(tx, f.tenantId)));

    await expect(
      asTenant(f.tenantId, async (tx) => {
        await orderNumber(tx, f.tenantId);
        throw new Error('checkout failed after claiming a number');
      }),
    ).rejects.toThrow();

    const after = Number(await asTenant(f.tenantId, (tx) => orderNumber(tx, f.tenantId)));
    // The burned number was returned — no hole in the invoice sequence.
    expect(after).toBe(before + 1);
  });
});

suite('reservation expiry', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture('expiry');
  });
  afterAll(async () => {
    await f.cleanup();
  });

  it('returns stock held by an abandoned checkout', async () => {
    const variantId = await f.variant({ price: 99_900, onHand: 3 });
    const cartId = await asTenant(f.tenantId, async (tx) => {
      const id = await getOrCreateCart(tx, f.ctx, { sessionToken: 'expiring' });
      await addItem(tx, f.ctx, id, { variantId, quantity: 2 });
      return id;
    });

    await asTenant(f.tenantId, async (tx) => {
      const cart = await getCart(tx, f.ctx, cartId);
      await completeCheckout(
        tx,
        f.ctx,
        ACTOR,
        {
          cartId,
          idempotencyKey: `exp-${cartId}`,
          expectedTotal: cart.pricing.total.amount,
          paymentProvider: 'network',
          phone: UAE_ADDRESS.phone,
          shippingAddress: UAE_ADDRESS,
        },
        scriptedGateway({ kind: 'requires_action', reference: 'r', redirectUrl: 'https://x' }),
        URLS,
      );
    });

    // Simulate the shopper closing the tab and the TTL elapsing.
    await ownerDb().execute(sql`
      UPDATE stock_reservations SET expires_at = now() - interval '1 minute'
      WHERE tenant_id = ${f.tenantId} AND status = 'held'
    `);

    const released = await ownerDb().transaction((tx) => sweepExpiredReservations(tx, 100));
    expect(released).toBeGreaterThanOrEqual(1);

    const stock = await asTenant(f.tenantId, (tx) =>
      tx.execute<{ on_hand: number; reserved: number }>(
        sql`SELECT on_hand, reserved FROM stock_levels WHERE variant_id = ${variantId}`,
      ),
    );
    expect(Number(stock.rows[0]!.on_hand)).toBe(3);
    expect(Number(stock.rows[0]!.reserved)).toBe(0);
  });
});

suite('job queue', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture('jobs');
  });
  afterAll(async () => {
    await f.cleanup();
    await closeTestPools();
  });

  it('lets two workers claim disjoint sets of jobs', async () => {
    await ownerDb().transaction(async (tx) => {
      for (let i = 0; i < 6; i += 1) {
        await enqueue(tx, {
          kind: 'notifications.send',
          tenantId: f.tenantId,
          payload: { i },
          dedupeKey: `claim-test-${f.tenantId}-${i}`,
        });
      }
    });

    // SKIP LOCKED is what makes this safe — neither worker blocks the other,
    // and neither sees a job the other has claimed.
    const [a, b] = await Promise.all([
      ownerDb().transaction((tx) => claimJobs(tx, 'worker-a', 3)),
      ownerDb().transaction((tx) => claimJobs(tx, 'worker-b', 3)),
    ]);

    const overlap = a.filter((job) => b.some((other) => other.id === job.id));
    expect(overlap).toHaveLength(0);
    expect(a.length + b.length).toBeGreaterThan(0);
  });

  it('retries a failing job with backoff, then gives up', async () => {
    const key = `failing-${f.tenantId}`;

    await ownerDb().transaction((tx) =>
      enqueue(tx, {
        kind: 'notifications.send',
        tenantId: f.tenantId,
        maxAttempts: 2,
        dedupeKey: key,
      }),
    );

    const failing = { 'notifications.send': async () => { throw new Error('boom'); } };

    // Assertions target THIS job's row, never runOnce's aggregate counters.
    // The queue is shared: checkout tests earlier in the same run legitimately
    // enqueue their own notifications.send jobs, so "failed === 1" is a claim
    // about whatever happened to be in the batch, not about this job — and the
    // claim batch is capped, so this job may not even be in the first pass.
    const jobState = async () => {
      const rows = await ownerDb().execute<{ status: string; attempts: number }>(
        sql`SELECT status, attempts FROM jobs WHERE dedupe_key = ${key}`,
      );
      return rows.rows[0]!;
    };

    // Drain until this job has been attempted once. A generous limit means one
    // pass in the common case; the loop covers a queue with leftovers in front.
    for (let pass = 0; pass < 5 && (await jobState()).attempts === 0; pass += 1) {
      await runOnce(ownerDb(), 'worker-fail', { limit: 50, handlers: failing });
    }

    const afterFirst = await jobState();
    expect(afterFirst.attempts).toBe(1);
    // Backoff pushed run_at into the future, so it is queued but not yet due.
    expect(afterFirst.status).toBe('queued');

    // Not re-claimed while its run_at is in the future.
    await runOnce(ownerDb(), 'worker-fail', { limit: 50, handlers: failing });
    expect((await jobState()).attempts).toBe(1);

    await ownerDb().execute(sql`
      UPDATE jobs SET run_at = now() - interval '1 second' WHERE dedupe_key = ${key}
    `);
    await runOnce(ownerDb(), 'worker-fail', { limit: 50, handlers: failing });

    // Dead-lettered rather than retried forever — this is what an alert watches.
    expect((await jobState()).status).toBe('dead');
  });
});
