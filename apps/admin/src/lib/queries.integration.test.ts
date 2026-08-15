import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeConnections, dbAdmin, ping, uuidv7 } from '@voltix/db';
import { dashboardMetrics, getOrderDetail, listOrders } from './queries';
import { analyseInventory } from './inventory';

/**
 * ADMIN QUERY SMOKE TESTS
 *
 * These exist because of a specific, repeated failure: hand-written SQL that
 * references a column which does not exist. TypeScript cannot catch it — the
 * row type is an assertion about a string, not a checked fact — so the first
 * thing that notices is Postgres, at render time, as a 500 on a page a merchant
 * is looking at.
 *
 * So the point of these tests is *not* elaborate assertions about the numbers.
 * It is that every statement in the admin read model is parsed and planned by a
 * real Postgres against the real schema. A typo in a column name fails here, in
 * a second, instead of in production.
 *
 * They skip when Postgres is unreachable so `npm test` still works on a laptop
 * with no Docker running.
 */

const TENANT = '01920000-0000-7000-8000-000000000001';

/**
 * Top-level await, deliberately, rather than a flag set in `beforeAll`.
 *
 * `describe` bodies run at *collection* time, before any hook fires — so a
 * `beforeAll` that sets `reachable` is still false when `it` vs `it.skip` is
 * chosen, and the entire suite skips even with Postgres running. The failure is
 * silent and the run still reports green, which is the worst way to lose test
 * coverage.
 */
const reachable = await ping().catch(() => false);
const suite = reachable ? describe : describe.skip;

if (!reachable) {
  console.warn('\n  ⚠ Postgres unreachable — admin query tests skipped.\n');
}

afterAll(async () => {
  if (reachable) await closeConnections();
});

suite('admin read model', () => {
  it('dashboardMetrics executes against the real schema', async () => {
    const metrics = await dashboardMetrics(TENANT, 'AED');

    expect(metrics.revenue).toBeGreaterThanOrEqual(0);
    expect(metrics.orders).toBeGreaterThanOrEqual(0);
    expect(metrics.currency).toBe('AED');
    // Null rather than a fabricated zero when there is no prior week to compare.
    expect(metrics.revenueDeltaPct === null || Number.isFinite(metrics.revenueDeltaPct)).toBe(true);
  });

  it('listOrders executes with every filter combination', async () => {
    // Each filter appends a different fragment to the WHERE clause, so an
    // unfiltered query passing proves nothing about the filtered ones.
    const combinations = [
      {},
      { search: '100' },
      { search: "'; DROP TABLE orders; --" },
      { paymentStatus: 'unpaid' },
      { fulfilmentStatus: 'unfulfilled' },
      { status: 'pending' },
      { search: 'Aisha', paymentStatus: 'paid', fulfilmentStatus: 'fulfilled', status: 'completed' },
      { limit: 1, offset: 5 },
    ];

    for (const filters of combinations) {
      const result = await listOrders(TENANT, filters);
      expect(Array.isArray(result.rows)).toBe(true);
      expect(result.total).toBeGreaterThanOrEqual(0);
    }

    // The injection attempt above is parameterised, so the table survives.
    const stillThere = await dbAdmin().execute(sql`SELECT count(*) FROM orders`);
    expect(stillThere.rows).toHaveLength(1);
  });

  it('listOrders clamps a hostile limit and offset', async () => {
    // Straight from a query string, so both are attacker-controlled. An
    // unclamped limit is a one-request denial of service.
    expect((await listOrders(TENANT, { limit: 10_000 })).rows.length).toBeLessThanOrEqual(200);
    await expect(listOrders(TENANT, { limit: -5, offset: -100 })).resolves.toBeDefined();
  });

  it('getOrderDetail returns a fully-populated order', async () => {
    const list = await listOrders(TENANT, { limit: 1 });
    const first = list.rows[0];
    if (!first) return; // No orders seeded; the other tests still cover the SQL.

    const detail = await getOrderDetail(TENANT, first.number);
    expect(detail).not.toBeNull();
    expect(detail!.number).toBe(first.number);
    expect(detail!.items.length).toBeGreaterThan(0);

    // The line items must reconcile with the order header: `subtotal` is
    // exactly the sum of the line totals. Order-level discounts sit in their
    // own column and are applied *after* this, so subtracting them here would
    // be wrong — the earlier version of this assertion did, and the failure is
    // what surfaced the distinction.
    //
    // This is the check that catches reading the wrong money column: picking
    // `unit_price` where `line_total` was meant still produces a plausible
    // number, and only reconciliation notices.
    const lineSum = detail!.items.reduce((sum, i) => sum + i.lineTotal, 0);
    expect(lineSum).toBe(detail!.subtotal);

    // VAT is extracted from the inclusive price, never added on top — so tax
    // must always be strictly less than the total, and a total that equals
    // subtotal + tax means someone made UAE prices exclusive.
    expect(detail!.taxTotal).toBeLessThan(detail!.total);

    // availableActions() is asked of the state machine, so the type must be
    // right even when the list is empty.
    expect(Array.isArray(detail!.actions)).toBe(true);
  });

  it('getOrderDetail accepts a #-prefixed number and rejects a missing one', async () => {
    const list = await listOrders(TENANT, { limit: 1 });
    const first = list.rows[0];
    if (first) {
      // Operators paste "#10001" straight from an email.
      expect(await getOrderDetail(TENANT, `#${first.number}`)).not.toBeNull();
    }
    expect(await getOrderDetail(TENANT, 'definitely-not-an-order')).toBeNull();
  });

  it('getOrderDetail reports the provider from the latest payment intent', async () => {
    // The signal behind the "Record cash collected" button. It has to come from
    // the payment intent: a COD order has no transaction row until the cash is
    // recorded, and `payment_status = 'unpaid'` — the stand-in this replaced —
    // is equally true of a card order whose authorisation is still settling,
    // which put a cash-collection button in front of staff for an order the
    // customer had already paid by card.
    const orderId = uuidv7();
    const number = `9${Date.now().toString().slice(-4)}`;
    try {
      await dbAdmin().execute(sql`
        INSERT INTO orders (id, tenant_id, number, payment_status, total, subtotal)
        VALUES (${orderId}, ${TENANT}, ${number}, 'unpaid', 100000, 100000)
      `);
      // Two intents: a card attempt, then the COD retry the shopper actually
      // checked out with. Only the newest one describes how they are paying.
      for (const [provider, secondsAgo] of [['network', 60], ['cod', 0]] as const) {
        await dbAdmin().execute(sql`
          INSERT INTO payment_intents
            (id, tenant_id, order_id, provider, amount, currency, idempotency_key, created_at)
          VALUES (${uuidv7()}, ${TENANT}, ${orderId}, ${provider}, 100000, 'AED',
                  ${`k-${orderId}-${provider}`}, now() - (${secondsAgo} * interval '1 second'))
        `);
      }

      const detail = await getOrderDetail(TENANT, number);
      expect(detail?.paymentProvider).toBe('cod');
      // Nothing has been captured, so the ledger cannot have carried this.
      expect(detail?.transactions).toHaveLength(0);
    } finally {
      await dbAdmin().execute(sql`DELETE FROM payment_intents WHERE order_id = ${orderId}`);
      await dbAdmin().execute(sql`DELETE FROM orders WHERE id = ${orderId}`);
    }
  });

  it('another tenant cannot read this tenant’s orders', async () => {
    // The load-bearing multi-tenancy assertion for the admin. Every query here
    // runs inside withTenant(), so RLS should return nothing for a stranger.
    const stranger = uuidv7();
    const result = await listOrders(stranger, {});
    expect(result.rows).toHaveLength(0);
    expect(result.total).toBe(0);

    const metrics = await dashboardMetrics(stranger, 'AED');
    expect(metrics.revenue).toBe(0);
    expect(metrics.orders).toBe(0);
  });

  it('analyseInventory executes and produces sane forecasts', async () => {
    const rows = await analyseInventory(TENANT);
    expect(Array.isArray(rows)).toBe(true);

    for (const row of rows) {
      expect(row.forecast.predictedUnits).toBeGreaterThanOrEqual(0);
      expect(row.advice.reorderPoint).toBeGreaterThanOrEqual(0);
      // Margin is null when cost is unknown, never a fabricated 100%.
      expect(row.marginBps === null || row.marginBps <= 10_000).toBe(true);
      expect(row.tiedUpCapital).toBeGreaterThanOrEqual(0);
    }
  });

  it('the demand history spine has one point per day, not one per sale', async () => {
    const rows = await analyseInventory(TENANT);
    if (rows.length === 0) return;

    // The regression guard for the join bug that gave every day the variant's
    // entire lifetime total. A daily rate above the total units ever sold is
    // the visible symptom, and it made every SKU look like an emergency.
    const totalSold = await dbAdmin().execute<{ units: string }>(sql`
      SELECT coalesce(sum(oi.quantity), 0) AS units
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.tenant_id = ${TENANT} AND o.status <> 'cancelled'
        AND o.placed_at >= current_date - 90
    `);
    const sold = Number(totalSold.rows[0]?.units ?? 0);
    const forecastTotal = rows.reduce((sum, r) => sum + r.forecast.dailyRate * 90, 0);

    // Generous bound — forecasts extrapolate — but a 90-day projection cannot
    // exceed several times what actually sold in those 90 days.
    expect(forecastTotal).toBeLessThanOrEqual(Math.max(sold * 5, 50));
  });
});
