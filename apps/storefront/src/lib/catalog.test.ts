import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The rule these cover: demo data may reach a developer, never a shopper.
 *
 * The interesting case is not a database that is down — that path already
 * rethrew in production — but a database that answers correctly with nothing.
 * An empty tenant used to serve six fabricated products from a live store, and
 * the shopper only found out at add-to-cart, because the demo variant ids are
 * slugs where the cart expects uuids.
 */
vi.mock('./repository', () => ({
  listProducts: async () => [],
  getProductBySlug: async () => undefined,
  listCategories: async () => [],
  searchProducts: async () => ({
    products: [],
    total: 0,
    intent: 'browse',
    facets: { brands: [], categories: [], priceRange: { min: 0, max: 0 } },
  }),
  relatedProducts: async () => [],
}));

/** Re-imported per case: `USE_DATABASE` is read once, at module load. */
async function catalogueWith(nodeEnv: string, databaseUrl: string) {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', nodeEnv);
  vi.stubEnv('DATABASE_URL', databaseUrl);
  return import('./catalog');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('catalogue fallbacks in production', () => {
  it('serves an empty catalogue rather than demo products when the tenant has no rows', async () => {
    const catalog = await catalogueWith('production', 'postgres://localhost/voltix');

    await expect(catalog.listProducts()).resolves.toEqual([]);
    await expect(catalog.listCategories()).resolves.toEqual([]);
    await expect(catalog.getProduct('samsung-galaxy-s25-ultra')).resolves.toBeUndefined();

    const search = await catalog.searchProducts({});
    expect(search.products).toEqual([]);
    expect(search.total).toBe(0);
  });

  it('does not invent a product page for a slug that only exists in the demo data', async () => {
    const catalog = await catalogueWith('production', 'postgres://localhost/voltix');

    // The slug is a real one from DEMO_PRODUCTS — that is the point. Before the
    // fix this resolved to a fully rendered page for a product the store does
    // not sell.
    await expect(catalog.getProduct('anker-nano-ii-65w-charger')).resolves.toBeUndefined();
  });

  it('still refuses demo data when DATABASE_URL is missing entirely', async () => {
    const catalog = await catalogueWith('production', '');

    await expect(catalog.listProducts()).resolves.toEqual([]);
    await expect(catalog.listCategories()).resolves.toEqual([]);
    await expect(catalog.getProduct('samsung-galaxy-s25-ultra')).resolves.toBeUndefined();
  });

  it('returns no related products for a demo-shaped id', async () => {
    const catalog = await catalogueWith('production', 'postgres://localhost/voltix');
    const demoShaped = { id: 'p-galaxy-s25', categorySlug: 'smartphones', brand: 'Samsung', tags: [] };

    await expect(
      catalog.relatedProducts(demoShaped as Parameters<typeof catalog.relatedProducts>[0]),
    ).resolves.toEqual([]);
  });
});

describe('catalogue fallbacks in development', () => {
  it('still serves the demo catalogue, so a fresh clone runs without a database', async () => {
    const catalog = await catalogueWith('development', '');

    const products = await catalog.listProducts();
    expect(products.length).toBeGreaterThan(0);
    expect(await catalog.listCategories()).not.toHaveLength(0);
    await expect(catalog.getProduct('samsung-galaxy-s25-ultra')).resolves.toBeDefined();
  });

  it('falls back to demo data when a configured database returns nothing', async () => {
    const catalog = await catalogueWith('development', 'postgres://localhost/voltix');

    expect(await catalog.listProducts()).not.toHaveLength(0);
    expect(await catalog.listCategories()).not.toHaveLength(0);
  });
});
