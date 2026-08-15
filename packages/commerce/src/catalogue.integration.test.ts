import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  adjustStock,
  createProduct,
  setProductStatus,
  slugify,
  updateProduct,
} from './catalogue';
import {
  closeTestPools,
  createFixture,
  databaseAvailable,
  ownerDb,
  type Fixture,
} from './test-support';
import type { ActorContext } from './types';

/**
 * CATALOGUE WRITES — against real Postgres.
 *
 * These are the first mutations a merchant performs, and two of them touch the
 * stock ledger. The properties under test are the ones whose failure is silent:
 * a duplicate SKU that breaks fulfilment weeks later, a live product with no
 * price, negative stock poisoning every forecast downstream.
 */

const available = await databaseAvailable();
const suite = available ? describe : describe.skip;
if (!available) console.warn('\n  ⚠ Postgres unreachable — catalogue write tests skipped.\n');

const ACTOR: ActorContext = { type: 'staff', label: 'catalogue-test' };

const PRODUCT = { title: 'Anker 737 Power Bank' };
const VARIANT = { sku: 'ANK-737-BLK', title: '24000mAh · Black', price: 49_900, costPrice: 32_000 };

suite('catalogue writes', () => {
  const fixtures: Fixture[] = [];
  const fixture = async (label: string) => {
    const f = await createFixture(label);
    fixtures.push(f);
    return f;
  };
  const asTenant = <T>(f: Fixture, fn: (tx: never) => Promise<T>): Promise<T> =>
    ownerDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${f.tenantId}, true)`);
      return fn(tx as never);
    });

  afterAll(async () => {
    for (const f of fixtures) await f.cleanup();
    await closeTestPools();
  });

  it('slugify handles the cases a UAE catalogue actually contains', () => {
    expect(slugify('Samsung Galaxy S25 Ultra')).toBe('samsung-galaxy-s25-ultra');
    expect(slugify('Anker 737  —  Power Bank!')).toBe('anker-737-power-bank');
    expect(slugify('Café Latte')).toBe('cafe-latte'); // diacritics folded
    expect(slugify('   ')).toBe(''); // caller falls back
    // Arabic has no Latin transliteration here; the caller must supply a fallback
    // rather than emitting an empty URL.
    expect(slugify('هاتف ذكي')).toBe('');
  });

  it('creates a draft product with stock and an opening ledger entry', async () => {
    const f = await fixture('cat-create');
    const created = await asTenant(f, (tx) =>
      createProduct(tx, f.ctx, ACTOR, PRODUCT, { ...VARIANT, onHand: 12 }),
    );

    expect(created.slug).toBe('anker-737-power-bank');

    const row = await ownerDb().execute<{ status: string; price_from: string; currency: string }>(sql`
      SELECT status::text, price_from, currency FROM products WHERE id = ${created.id}
    `);
    // Never live on creation — publishing is a separate, deliberate act.
    expect(row.rows[0]!.status).toBe('draft');
    expect(Number(row.rows[0]!.price_from)).toBe(49_900);

    const stock = await ownerDb().execute<{ on_hand: number }>(sql`
      SELECT sum(on_hand)::int AS on_hand FROM stock_levels sl
      JOIN variants v ON v.id = sl.variant_id WHERE v.product_id = ${created.id}
    `);
    expect(Number(stock.rows[0]!.on_hand)).toBe(12);

    // Opening stock is a movement, so the ledger explains the count from unit one.
    const moves = await ownerDb().execute<{ delta: number; reason: string }>(sql`
      SELECT delta, reason FROM stock_movements
      WHERE tenant_id = ${f.tenantId} AND reference_type = 'product_create'
    `);
    expect(moves.rows).toHaveLength(1);
    expect(Number(moves.rows[0]!.delta)).toBe(12);
  });

  it('refuses a duplicate SKU', async () => {
    const f = await fixture('cat-dupe');
    await asTenant(f, (tx) => createProduct(tx, f.ctx, ACTOR, PRODUCT, VARIANT));

    await expect(
      asTenant(f, (tx) =>
        createProduct(tx, f.ctx, ACTOR, { title: 'A different product' }, VARIANT),
      ),
    ).rejects.toThrow(/already used|already exists/i);
  });

  it('gives a second product with the same title a distinct readable slug', async () => {
    const f = await fixture('cat-slug');
    const a = await asTenant(f, (tx) =>
      createProduct(tx, f.ctx, ACTOR, PRODUCT, { ...VARIANT, sku: 'SKU-A' }),
    );
    const b = await asTenant(f, (tx) =>
      createProduct(tx, f.ctx, ACTOR, PRODUCT, { ...VARIANT, sku: 'SKU-B' }),
    );
    expect(a.slug).toBe('anker-737-power-bank');
    expect(b.slug).toBe('anker-737-power-bank-2'); // readable, not random
  });

  it('rejects invalid titles, prices and cost above price', async () => {
    const f = await fixture('cat-invalid');
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['empty title', () => asTenant(f, (tx) => createProduct(tx, f.ctx, ACTOR, { title: '  ' }, VARIANT))],
      ['empty sku', () => asTenant(f, (tx) => createProduct(tx, f.ctx, ACTOR, PRODUCT, { ...VARIANT, sku: '' }))],
      ['negative price', () => asTenant(f, (tx) => createProduct(tx, f.ctx, ACTOR, PRODUCT, { ...VARIANT, price: -1 }))],
      ['fractional price', () => asTenant(f, (tx) => createProduct(tx, f.ctx, ACTOR, PRODUCT, { ...VARIANT, price: 10.5 }))],
      // A decimal-point slip is far more common than a genuine 7-figure product.
      ['implausible price', () => asTenant(f, (tx) => createProduct(tx, f.ctx, ACTOR, PRODUCT, { ...VARIANT, price: 999_999_999 }))],
      ['cost above price', () => asTenant(f, (tx) => createProduct(tx, f.ctx, ACTOR, PRODUCT, { ...VARIANT, price: 1000, costPrice: 5000 }))],
    ];
    for (const [label, run] of cases) {
      await expect(run(), label).rejects.toThrow();
    }
  });

  it('will not publish a product with no priced variant, and unpublishing is never blocked', async () => {
    const f = await fixture('cat-publish');
    const created = await asTenant(f, (tx) =>
      // Cost omitted: this test is about publish preconditions, and the
      // fixture's default cost would trip the cost-above-price guard at price 1.
      createProduct(tx, f.ctx, ACTOR, PRODUCT, { sku: VARIANT.sku, title: VARIANT.title, price: 1 }),
    );

    // Deactivate the only variant, then publishing must fail.
    await ownerDb().execute(sql`
      UPDATE variants SET is_active = false WHERE product_id = ${created.id}
    `);
    // Assert on `publicMessage` — that is the string a merchant reads, and it
    // is the one that must stay comprehensible.
    await expect(
      asTenant(f, (tx) => setProductStatus(tx, f.ctx, ACTOR, created.id, 'active')),
    ).rejects.toMatchObject({
      publicMessage: expect.stringMatching(/at least one active variant with a price/i),
    });

    // Restore it; now publishing works and stamps published_at.
    await ownerDb().execute(sql`
      UPDATE variants SET is_active = true WHERE product_id = ${created.id}
    `);
    await asTenant(f, (tx) => setProductStatus(tx, f.ctx, ACTOR, created.id, 'active'));

    const live = await ownerDb().execute<{ status: string; published_at: Date | null }>(sql`
      SELECT status::text, published_at FROM products WHERE id = ${created.id}
    `);
    expect(live.rows[0]!.status).toBe('active');
    expect(live.rows[0]!.published_at).not.toBeNull();

    // Taking something off sale must never be blocked — a wrong or unsafe
    // product has to be removable in one action.
    await expect(
      asTenant(f, (tx) => setProductStatus(tx, f.ctx, ACTOR, created.id, 'draft')),
    ).resolves.toBeUndefined();
  });

  it('updates descriptive fields without touching price or stock', async () => {
    const f = await fixture('cat-update');
    const created = await asTenant(f, (tx) =>
      createProduct(tx, f.ctx, ACTOR, PRODUCT, { ...VARIANT, onHand: 7 }),
    );

    await asTenant(f, (tx) =>
      updateProduct(tx, f.ctx, ACTOR, created.id, {
        title: 'Anker 737 Power Bank (2026)',
        subtitle: '140W USB-C',
        warrantyMonths: 24,
      }),
    );

    const after = await ownerDb().execute<{
      title: string; subtitle: string; warranty_months: number; price_from: string; slug: string;
    }>(sql`SELECT title, subtitle, warranty_months, price_from, slug FROM products WHERE id = ${created.id}`);
    expect(after.rows[0]!.title).toContain('2026');
    expect(Number(after.rows[0]!.warranty_months)).toBe(24);
    // Price untouched, and the slug is stable so existing links keep working.
    expect(Number(after.rows[0]!.price_from)).toBe(49_900);
    expect(after.rows[0]!.slug).toBe(created.slug);

    const stock = await ownerDb().execute<{ on_hand: number }>(sql`
      SELECT sum(on_hand)::int AS on_hand FROM stock_levels sl
      JOIN variants v ON v.id = sl.variant_id WHERE v.product_id = ${created.id}
    `);
    expect(Number(stock.rows[0]!.on_hand)).toBe(7);
  });

  /**
   * ARABIC PRODUCT COPY — UAE Federal Law 15/2020.
   *
   * Consumer product information must be available in Arabic, so the write path
   * for `products.translations` is a compliance surface rather than a feature.
   * What is under test is the storage contract the storefront's `localise()`
   * depends on: per-field overrides, and no empty strings.
   */
  it('stores Arabic copy alongside the English fields', async () => {
    const f = await fixture('cat-arabic');
    const created = await asTenant(f, (tx) =>
      createProduct(
        tx,
        f.ctx,
        ACTOR,
        {
          ...PRODUCT,
          description: 'A 24,000mAh power bank with 140W output.',
          highlights: ['140W USB-C output', '24,000mAh capacity'],
          translations: {
            'ar-AE': {
              title: 'أنكر ٧٣٧ باور بانك',
              description: 'باور بانك بسعة ٢٤٠٠٠ مللي أمبير وقدرة ١٤٠ واط.',
              highlights: ['منفذ USB-C بقوة ١٤٠ واط', 'سعة ٢٤٠٠٠ مللي أمبير'],
            },
          },
        },
        VARIANT,
      ),
    );

    const row = await ownerDb().execute<{ highlights: unknown; translations: unknown }>(
      sql`SELECT highlights, translations FROM products WHERE id = ${created.id}`,
    );
    const translations = row.rows[0]!.translations as Record<string, Record<string, unknown>>;

    expect(row.rows[0]!.highlights).toEqual(['140W USB-C output', '24,000mAh capacity']);
    expect(translations['ar-AE']!.title).toBe('أنكر ٧٣٧ باور بانك');
    expect(translations['ar-AE']!.highlights).toEqual([
      'منفذ USB-C بقوة ١٤٠ واط',
      'سعة ٢٤٠٠٠ مللي أمبير',
    ]);
  });

  /**
   * The property that makes per-field fallback work.
   *
   * `localise()` resolves with `??`, which falls back on null/undefined only —
   * an empty string stored here would blank the English title for an Arabic
   * reader instead of falling back to it. A merchant who translates the title
   * and leaves the description alone must leave no description key at all.
   */
  it('keeps a partial translation partial, and stores no empty strings', async () => {
    const f = await fixture('cat-arabic-partial');
    const created = await asTenant(f, (tx) =>
      createProduct(tx, f.ctx, ACTOR, PRODUCT, VARIANT),
    );

    await asTenant(f, (tx) =>
      updateProduct(tx, f.ctx, ACTOR, created.id, {
        title: 'Anker 737 Power Bank',
        description: 'English description stays.',
        highlights: ['English highlight'],
        translations: {
          // Title translated; everything else left blank by the merchant.
          'ar-AE': { title: 'أنكر ٧٣٧', subtitle: '', description: '   ', highlights: ['', '  '] },
        },
      }),
    );

    const row = await ownerDb().execute<{ translations: unknown }>(
      sql`SELECT translations FROM products WHERE id = ${created.id}`,
    );
    const arabic = (row.rows[0]!.translations as Record<string, Record<string, unknown>>)['ar-AE']!;

    expect(arabic).toEqual({ title: 'أنكر ٧٣٧' });
    expect('description' in arabic).toBe(false);
    expect('subtitle' in arabic).toBe(false);
    expect('highlights' in arabic).toBe(false);
  });

  /** A locale with nothing in it is dropped, so the column reads as untranslated
   *  rather than holding `{"ar-AE": {}}` — the same state, worse to read. */
  it('drops a locale whose fields are all blank', async () => {
    const f = await fixture('cat-arabic-empty');
    const created = await asTenant(f, (tx) =>
      createProduct(tx, f.ctx, ACTOR, PRODUCT, VARIANT),
    );

    await asTenant(f, (tx) =>
      updateProduct(tx, f.ctx, ACTOR, created.id, {
        title: 'Anker 737 Power Bank',
        translations: { 'ar-AE': { title: '', subtitle: '', description: '', highlights: [] } },
      }),
    );

    const row = await ownerDb().execute<{ translations: unknown }>(
      sql`SELECT translations FROM products WHERE id = ${created.id}`,
    );
    expect(row.rows[0]!.translations).toEqual({});
  });

  it('adjusts stock, records the reason, and refuses to go negative', async () => {
    const f = await fixture('cat-stock');
    const created = await asTenant(f, (tx) =>
      createProduct(tx, f.ctx, ACTOR, PRODUCT, { ...VARIANT, onHand: 10 }),
    );
    const variants = await ownerDb().execute<{ id: string }>(sql`
      SELECT id FROM variants WHERE product_id = ${created.id}
    `);
    const variantId = variants.rows[0]!.id;

    const up = await asTenant(f, (tx) =>
      adjustStock(tx, f.ctx, ACTOR, { variantId, delta: 5, reason: 'purchase_received' }),
    );
    expect(up.balanceAfter).toBe(15);

    const down = await asTenant(f, (tx) =>
      adjustStock(tx, f.ctx, ACTOR, { variantId, delta: -3, reason: 'damage', note: 'water damage' }),
    );
    expect(down.balanceAfter).toBe(12);

    // Negative stock is never a fact about the world — it is always an error.
    await expect(
      asTenant(f, (tx) =>
        adjustStock(tx, f.ctx, ACTOR, { variantId, delta: -99, reason: 'stocktake' }),
      ),
    ).rejects.toThrow(/cannot remove|negative/i);

    await expect(
      asTenant(f, (tx) =>
        adjustStock(tx, f.ctx, ACTOR, { variantId, delta: 0, reason: 'stocktake' }),
      ),
    ).rejects.toThrow();

    // Every change is explained in the ledger.
    const moves = await ownerDb().execute<{ delta: number; reason: string; note: string | null }>(sql`
      SELECT delta, reason::text, note FROM stock_movements
      WHERE tenant_id = ${f.tenantId} AND reference_type = 'manual'
      ORDER BY created_at
    `);
    expect(moves.rows).toHaveLength(2);
    expect(moves.rows.map((m) => m.reason)).toEqual(['purchase_received', 'damage']);
    expect(moves.rows[1]!.note).toBe('water damage');
  });
});
