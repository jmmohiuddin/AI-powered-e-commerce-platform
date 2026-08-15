import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeConnections, dbAdmin, ping, uuidv7 } from '@voltix/db';
import {
  getCategoryByPath,
  getProductBySlug,
  listCategories,
  searchProducts,
} from './repository';
import { specsOf } from './types';

/**
 * Pagination and the real total, against real Postgres.
 *
 * These cannot be proved against the seeded demo tenant: it holds six products,
 * which is under one page, and a broken `total` agrees with a broken page size
 * at that size. The bug being fixed here — `total: hydrated.length` after a
 * LIMIT — is invisible below the page boundary and wrong above it, so the
 * fixture deliberately straddles it with 30 products in a 24-per-page listing.
 *
 * A dedicated tenant, torn down afterwards, because row-level security keys off
 * `tenant_id` and borrowing the demo tenant would leave 30 fake products in the
 * store every other agent is looking at.
 */

const reachable = await ping().catch(() => false);
const suite = reachable ? describe : describe.skip;
if (!reachable) console.warn('\n  ⚠ Postgres unreachable — catalogue listing tests skipped.\n');

const TENANT = uuidv7();
const PARENT_PATH = '/test-mobiles';
const CHILD_PATH = '/test-mobiles/test-handsets';
const TOTAL_PRODUCTS = 30;

/** The product that carries specifications; the other 29 carry none. */
let specProductId = '';

const SPEC_ATTRIBUTES: Array<{
  key: string;
  name: string;
  type: 'text' | 'number' | 'boolean' | 'enum' | 'measurement';
  unit?: string;
  keySpec?: boolean;
  position: number;
  text?: string;
  number?: number;
  boolean?: boolean;
}> = [
  { key: 'sf_display', name: 'Display', type: 'text', keySpec: true, position: 10, text: '6.9" OLED' },
  { key: 'sf_ram', name: 'RAM', type: 'measurement', unit: 'GB', position: 20, number: 12 },
  { key: 'sf_battery', name: 'Battery', type: 'measurement', unit: 'mAh', position: 25, number: 5000 },
  { key: 'sf_ports', name: 'Ports', type: 'number', position: 30, number: 2 },
  { key: 'sf_anc', name: 'Noise cancelling', type: 'boolean', keySpec: true, position: 40, boolean: true },
  { key: 'sf_wireless', name: 'Wireless charging', type: 'boolean', position: 45, boolean: false },
  { key: 'sf_network', name: 'Network', type: 'enum', position: 50, text: '5G' },
  // Attached but never filled in — must produce no row rather than a blank one.
  { key: 'sf_blank', name: 'Unfilled', type: 'text', position: 60 },
];

async function seed() {
  const owner = dbAdmin();
  await owner.execute(sql`
    INSERT INTO tenants (id, slug, name, plan, status, country_code, default_currency,
                         default_locale, timezone, vat_rate_bps, prices_include_vat,
                         created_at, updated_at)
    VALUES (${TENANT}, ${`listing-${TENANT.slice(0, 8)}`}, 'Listing fixture',
            'growth', 'active', 'AE', 'AED', 'en-AE', 'Asia/Dubai', 500, true, now(), now())
  `);

  const parentId = uuidv7();
  const childId = uuidv7();
  const brandId = uuidv7();

  await owner.execute(sql`
    INSERT INTO brands (id, tenant_id, slug, name, created_at, updated_at)
    VALUES (${brandId}, ${TENANT}, 'test-brand', 'Test Brand', now(), now())
  `);
  await owner.execute(sql`
    INSERT INTO categories (id, tenant_id, parent_id, slug, name, path, depth, position,
                            is_visible, translations, created_at, updated_at)
    VALUES (${parentId}, ${TENANT}, NULL, 'test-mobiles', 'Mobiles', ${PARENT_PATH}, 0, 0, true,
            ${JSON.stringify({ 'ar-AE': { name: 'الهواتف' } })}::jsonb, now(), now()),
           (${childId}, ${TENANT}, ${parentId}, 'test-handsets', 'Handsets', ${CHILD_PATH}, 1, 0, true,
            '{}'::jsonb, now(), now())
  `);

  // Split across parent and child so the subtree filter has something to prove.
  for (let i = 0; i < TOTAL_PRODUCTS; i += 1) {
    const productId = uuidv7();
    if (i === 0) specProductId = productId;
    const categoryId = i % 2 === 0 ? parentId : childId;
    await owner.execute(sql`
      INSERT INTO products (id, tenant_id, brand_id, category_id, slug, title, status,
                            currency, price_from, rating_count, created_at, updated_at)
      VALUES (${productId}, ${TENANT}, ${brandId}, ${categoryId},
              ${`listing-fixture-${i}`}, ${`Listing fixture ${i}`}, 'active',
              'AED', ${10_000 + i * 1_000}, ${i}, now(), now())
    `);
  }

  /**
   * One product with a specification of every declared type.
   *
   * The value lives in one of three typed columns according to the attribute's
   * `type`, so a type nothing exercises is a rendering bug waiting for its first
   * real product. `blank` is here for the case that produces no row at all: an
   * attribute attached to a product but never filled in.
   */
  for (const a of SPEC_ATTRIBUTES) {
    const attributeId = uuidv7();
    await owner.execute(sql`
      INSERT INTO attributes (id, tenant_id, key, name, type, unit, options,
                              is_filterable, is_comparable, is_key_spec, position,
                              created_at, updated_at)
      VALUES (${attributeId}, ${TENANT}, ${a.key}, ${a.name}, ${a.type}::attribute_type,
              ${a.unit ?? null}, '[]'::jsonb, true, true, ${a.keySpec ?? false},
              ${a.position}, now(), now())
    `);
    await owner.execute(sql`
      INSERT INTO product_attribute_values (id, tenant_id, product_id, attribute_id,
                                            value_text, value_number, value_boolean,
                                            created_at, updated_at)
      VALUES (${uuidv7()}, ${TENANT}, ${specProductId}, ${attributeId},
              ${a.text ?? null}, ${a.number ?? null}, ${a.boolean ?? null}, now(), now())
    `);
  }
}

if (reachable) await seed();

afterAll(async () => {
  if (!reachable) return;
  const owner = dbAdmin();
  // Children first — products reference categories and brands. Deleting the
  // products cascades their attribute values; the attributes themselves are
  // tenant-level and outlive them, so they go explicitly.
  await owner.execute(sql`DELETE FROM products WHERE tenant_id = ${TENANT}`);
  await owner.execute(sql`DELETE FROM attributes WHERE tenant_id = ${TENANT}`);
  await owner.execute(sql`DELETE FROM categories WHERE tenant_id = ${TENANT}`);
  await owner.execute(sql`DELETE FROM brands WHERE tenant_id = ${TENANT}`);
  await owner.execute(sql`DELETE FROM tenants WHERE id = ${TENANT}`);
  await closeConnections();
});

suite('listing pagination', () => {
  it('reports the true total, not the size of the page', async () => {
    const result = await searchProducts(TENANT, {});

    expect(result.total).toBe(TOTAL_PRODUCTS);
    // The bug: this used to equal `total`, because total *was* this.
    expect(result.products).toHaveLength(24);
    expect(result.total).toBeGreaterThan(result.products.length);
    expect(result.pageCount).toBe(2);
  });

  it('returns the remainder on the last page, with no overlap', async () => {
    const first = await searchProducts(TENANT, { page: 1 });
    const second = await searchProducts(TENANT, { page: 2 });

    expect(second.products).toHaveLength(TOTAL_PRODUCTS - 24);
    expect(second.page).toBe(2);

    const firstIds = new Set(first.products.map((p) => p.id));
    const overlap = second.products.filter((p) => firstIds.has(p.id));
    expect(overlap, 'a product must not appear on two pages').toEqual([]);
  });

  it('clamps a hostile page number instead of erroring on a negative OFFSET', async () => {
    await expect(searchProducts(TENANT, { page: -5 })).resolves.toMatchObject({ page: 1 });
    await expect(searchProducts(TENANT, { page: 99_999 })).resolves.toMatchObject({ page: 2 });
  });

  it('caps page size, so ?pageSize= cannot ask for the whole catalogue', async () => {
    const result = await searchProducts(TENANT, { pageSize: 100_000 });
    expect(result.pageSize).toBeLessThanOrEqual(60);
  });

  it('counts facets over the whole match rather than the current page', async () => {
    // Every fixture product shares one brand, so the facet must report 30 —
    // page-scoped counting would say 24.
    const result = await searchProducts(TENANT, {});
    expect(result.facets.brands[0]).toMatchObject({ value: 'Test Brand', count: TOTAL_PRODUCTS });
  });
});

suite('category subtree', () => {
  it('includes descendants, so a parent category is not empty', async () => {
    const parent = await searchProducts(TENANT, { categoryPath: PARENT_PATH });
    const child = await searchProducts(TENANT, { categoryPath: CHILD_PATH });

    expect(parent.total).toBe(TOTAL_PRODUCTS);
    expect(child.total).toBe(TOTAL_PRODUCTS / 2);
  });

  it('does not let one path prefix swallow a sibling', async () => {
    // `/test-mobiles` must not match a hypothetical `/test-mobiles-refurbished`.
    const result = await searchProducts(TENANT, { categoryPath: '/test-mobile' });
    expect(result.total).toBe(0);
  });

  it('resolves a category with its ancestors and children', async () => {
    const child = await getCategoryByPath(TENANT, CHILD_PATH);
    expect(child?.name).toBe('Handsets');
    expect(child?.ancestors.map((a) => a.path)).toEqual([PARENT_PATH]);
    expect(child?.children).toEqual([]);

    const parent = await getCategoryByPath(TENANT, PARENT_PATH);
    expect(parent?.ancestors).toEqual([]);
    expect(parent?.children.map((c) => c.path)).toEqual([CHILD_PATH]);
  });

  it('counts a category by its subtree, so a parent never reads as empty', async () => {
    const parent = await getCategoryByPath(TENANT, PARENT_PATH);
    expect(parent?.count).toBe(TOTAL_PRODUCTS);
  });

  it('carries the translations the nav needs to render Arabic', async () => {
    const rows = await listCategories(TENANT);
    const parent = rows.find((c) => c.path === PARENT_PATH);
    expect(parent?.translations?.['ar-AE']?.name).toBe('الهواتف');
    expect(parent?.depth).toBe(0);
  });

  it('returns nothing for a path that does not exist', async () => {
    await expect(getCategoryByPath(TENANT, '/no-such-category')).resolves.toBeUndefined();
  });
});

/**
 * SPECIFICATIONS, from the attributes tables.
 *
 * `specs` was hardcoded to `{}` in the hydrator, so the specification table on
 * every product page was empty against a real database and filled only for the
 * in-memory demo catalogue. For an electronics store that is the comparison the
 * shopper came to make, so these assert the whole path: typed columns in, one
 * batched query, formatted rows out.
 */
suite('product specifications', () => {
  // The PDP path — one product by slug, through the same hydrator. Fetched this
  // way rather than off a listing page because the default sort decides which
  // page a fixture lands on, and that is not what these tests are about.
  const withSpecs = async () => {
    const product = await getProductBySlug(TENANT, 'listing-fixture-0');
    expect(product, 'fixture product with specs').toBeDefined();
    return product!;
  };

  it('reads each declared type out of its own column', async () => {
    const specs = specsOf(await withSpecs());
    const byLabel = new Map(specs.map((s) => [s.label, s.value]));

    expect(byLabel.get('Display')).toBe('6.9" OLED'); // text
    expect(byLabel.get('Network')).toBe('5G'); // enum
    expect(byLabel.get('Ports')).toBe('2'); // number, no unit
    // A measurement is its number AND its unit — "5,000" alone is a question.
    expect(byLabel.get('RAM')).toBe('12 GB');
    expect(byLabel.get('Battery')).toBe('5,000 mAh');
    // A boolean must not reach the page as `true`, and false is a real answer
    // rather than a missing one.
    expect(byLabel.get('Noise cancelling')).toBe('Yes');
    expect(byLabel.get('Wireless charging')).toBe('No');
  });

  it('drops an attribute that was attached but never filled in', async () => {
    const specs = specsOf(await withSpecs());
    expect(specs.map((s) => s.label)).not.toContain('Unfilled');
    expect(specs).toHaveLength(SPEC_ATTRIBUTES.length - 1);
  });

  it('leads with the key specs, then follows the merchant ordering', async () => {
    const specs = specsOf(await withSpecs());

    // Key specs first (Display p10, Noise cancelling p40), then the rest in
    // `attributes.position` order rather than alphabetically or by insertion.
    expect(specs.map((s) => s.label)).toEqual([
      'Display',
      'Noise cancelling',
      'RAM',
      'Battery',
      'Ports',
      'Wireless charging',
      'Network',
    ]);
    expect(specs.filter((s) => s.isKeySpec).map((s) => s.label)).toEqual([
      'Display',
      'Noise cancelling',
    ]);
  });

  it('exposes the same values through the flat map every caller already renders', async () => {
    const product = await withSpecs();
    expect(product.specs['RAM']).toBe('12 GB');
    expect(product.specs['Noise cancelling']).toBe('Yes');
    expect(Object.keys(product.specs)).toHaveLength(SPEC_ATTRIBUTES.length - 1);
  });

  /**
   * The other 29 products carry no attribute values, and they are hydrated by
   * the same batched query on the same page. A product with nothing to show must
   * come back with nothing rather than an empty-stringed row, so the page can
   * omit the section instead of heading an empty table.
   */
  it('returns no specs for a product that has none, alongside one that does', async () => {
    // Both pages, because the default sort decides which page a fixture lands
    // on and this is about hydration, not ordering.
    const [first, second] = await Promise.all([
      searchProducts(TENANT, { page: 1 }),
      searchProducts(TENANT, { page: 2 }),
    ]);
    const all = [...first.products, ...second.products];

    const bare = all.find((p) => p.slug === 'listing-fixture-2');
    expect(bare).toBeDefined();
    expect(bare!.specs).toEqual({});
    expect(bare!.specDetails).toBeUndefined();
    expect(specsOf(bare!)).toEqual([]);

    // Every one of the 30 came back from two listing queries, and the specified
    // one carries its specs — the batched join fills the whole page at once
    // rather than issuing a query per product.
    expect(all).toHaveLength(TOTAL_PRODUCTS);
    expect(all.find((p) => p.slug === 'listing-fixture-0')!.specDetails).toBeDefined();
    expect(all.filter((p) => p.specDetails).length).toBe(1);
  });
});
