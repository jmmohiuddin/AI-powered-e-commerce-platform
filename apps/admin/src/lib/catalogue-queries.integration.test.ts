import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeConnections, dbAdmin, ping, uuidv7 } from '@voltix/db';
import { getProductDetail, listCustomers, listProducts } from './catalogue-queries';

/**
 * Same purpose as the order read-model tests: every statement gets parsed and
 * planned by a real Postgres against the real schema, so a wrong column name
 * fails here in a second rather than as a 500 on a screen a merchant is using.
 */

const TENANT = '01920000-0000-7000-8000-000000000001';

const reachable = await ping().catch(() => false);
const suite = reachable ? describe : describe.skip;
if (!reachable) console.warn('\n  ⚠ Postgres unreachable — catalogue query tests skipped.\n');

afterAll(async () => {
  if (reachable) await closeConnections();
});

suite('catalogue read model', () => {
  it('listProducts executes with every filter combination', async () => {
    // Each filter appends a different WHERE fragment, so an unfiltered query
    // passing proves nothing about the filtered ones.
    const combinations = [
      {},
      { search: 'galaxy' },
      { search: "'; DROP TABLE products; --" },
      { status: 'active' },
      { status: 'draft' },
      { stock: 'out' },
      { stock: 'low' },
      { stock: 'in' },
      { search: 'sam', status: 'active', stock: 'in' },
      { limit: 1, offset: 3 },
    ];

    for (const filters of combinations) {
      const result = await listProducts(TENANT, filters);
      expect(Array.isArray(result.rows)).toBe(true);
      expect(result.total).toBeGreaterThanOrEqual(0);
    }

    // The injection attempt is parameterised, so the table survives.
    const alive = await dbAdmin().execute(sql`SELECT count(*) FROM products`);
    expect(alive.rows).toHaveLength(1);
  });

  it('clamps a hostile limit and offset', async () => {
    expect((await listProducts(TENANT, { limit: 100_000 })).rows.length).toBeLessThanOrEqual(200);
    await expect(listProducts(TENANT, { limit: -5, offset: -100 })).resolves.toBeDefined();
    await expect(listCustomers(TENANT, { limit: -5, offset: -100 })).resolves.toBeDefined();
  });

  it('stock band filters agree with the number the row displays', async () => {
    // The filter and the SELECT use the same subquery expression. If they ever
    // diverge, a product shows in the "out of stock" band with stock on it —
    // which is the sort of thing nobody reports and everybody stops trusting.
    for (const row of (await listProducts(TENANT, { stock: 'out' })).rows) {
      expect(row.onHand).toBeLessThanOrEqual(0);
    }
    for (const row of (await listProducts(TENANT, { stock: 'low' })).rows) {
      expect(row.onHand).toBeGreaterThan(0);
      expect(row.onHand).toBeLessThanOrEqual(5);
    }
    for (const row of (await listProducts(TENANT, { stock: 'in' })).rows) {
      expect(row.onHand).toBeGreaterThan(5);
    }
  });

  it('getProductDetail returns variants that reconcile with the summary', async () => {
    const list = await listProducts(TENANT, { limit: 1, status: 'active' });
    const first = list.rows[0];
    if (!first) return; // Nothing seeded; the SQL is still covered above.

    const detail = await getProductDetail(TENANT, first.slug);
    expect(detail).not.toBeNull();
    expect(detail!.slug).toBe(first.slug);
    expect(detail!.variants.length).toBe(first.variantCount);

    // Stock on the summary must equal the sum of its variants — they come from
    // separate queries, and this is what catches one of them drifting.
    const variantStock = detail!.variants.reduce((sum, v) => sum + v.onHand, 0);
    expect(variantStock).toBe(first.onHand);

    for (const v of detail!.variants) {
      // Margin is null when cost is unknown, never a fabricated 100%.
      expect(v.marginBps === null || v.marginBps <= 10_000).toBe(true);
    }
  });

  it('rating is stars out of 5, not the raw hundredths column', async () => {
    // The column stores 468 for a 4.68-star product. Rendering it raw put
    // "468.0" on the product page under a heading that said RATING.
    for (const row of (await listProducts(TENANT, {})).rows) {
      if (row.ratingAverage === null) continue;
      expect(row.ratingAverage).toBeGreaterThan(0);
      expect(row.ratingAverage).toBeLessThanOrEqual(5);
    }
  });

  it('getProductDetail returns null for a slug that does not exist', async () => {
    expect(await getProductDetail(TENANT, 'definitely-not-a-product')).toBeNull();
  });

  it('listCustomers executes with every segment', async () => {
    for (const filters of [
      {},
      { search: 'aisha' },
      { segment: 'repeat' },
      { segment: 'new' },
      { segment: 'at_risk' },
    ]) {
      const result = await listCustomers(TENANT, filters);
      expect(Array.isArray(result.rows)).toBe(true);
      for (const row of result.rows) {
        // Spend is derived from real orders, so it can never be negative.
        expect(row.lifetimeSpend).toBeGreaterThanOrEqual(0);
        expect(row.orderCount).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('the repeat segment really does mean more than one order', async () => {
    for (const row of (await listCustomers(TENANT, { segment: 'repeat' })).rows) {
      expect(row.orderCount).toBeGreaterThan(1);
    }
  });

  it('another tenant sees nothing — RLS holds for the catalogue too', async () => {
    const stranger = uuidv7();
    expect((await listProducts(stranger, {})).rows).toHaveLength(0);
    expect((await listProducts(stranger, {})).total).toBe(0);
    expect((await listCustomers(stranger, {})).rows).toHaveLength(0);
  });
});
