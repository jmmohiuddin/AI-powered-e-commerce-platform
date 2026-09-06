/**
 * Import — the Semul Miah master product catalogue.
 *
 * Loads `data/semul-catalog.json`, which was derived from
 * `Semul_Miah_Master_Product_Catalog_updated.xlsx` (147 SKUs de-duplicated from
 * thirteen Oskar General Trading purchase invoices, Apr–Sep 2026). The JSON is
 * the checked-in source of truth so an import is reproducible without a
 * spreadsheet toolchain on the machine running it.
 *
 * Three rules, borrowed from the seed for the same reasons:
 *
 *  1. **Idempotent, keyed on SKU.** Re-running must not create a second copy of
 *     anything. A merchant re-runs this after fixing one row, and an importer
 *     you are afraid to run twice is one nobody runs.
 *  2. **Writes through the domain, not around it.** Products go in via
 *     `createProduct` / `addProductImage` / `setProductStatus` rather than raw
 *     INSERTs, so stock ledgers, slug allocation and the sellable-variant check
 *     behave exactly as they do when a human uses the admin panel. The seed
 *     predates those functions; new bulk writes should not.
 *  3. **A failed image is not a failed product.** Photography is fetched from
 *     third-party sites that rate-limit and go down. An unreachable image logs
 *     a warning and leaves the product live with the storefront's placeholder,
 *     because a catalogue that refuses to load over one 403 is worse than one
 *     with a missing photo.
 *
 * Usage, from the repository root:
 *
 *     npm run db:import-catalog            # create/update, publish live
 *     npm run db:import-catalog -- --draft # same, but leave everything draft
 *     npm run db:import-catalog -- --dry-run
 *     npm run db:import-catalog -- --skip-images
 */
// Must be first: populates process.env from the repo-root .env before any
// module below reads a connection string at import time.
import '@voltix/config/load-env';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { closeConnections, dbAdmin, uuidv7, withTenant } from '@voltix/db';
import { prepareImage, resolveStorage } from '@voltix/media';
import { addProductImage } from '../src/media';
import { createProduct, setProductStatus } from '../src/catalogue';
import type { ActorContext, TenantContext } from '../src/types';

/**
 * The tenant the storefront serves. Shared with the seed rather than
 * re-declared, conceptually: both write the same store, and an import that
 * invented its own tenant would land in a catalogue nobody can see.
 */
const TENANT_ID = '01920000-0000-7000-8000-000000000001';
const STORE_ID = '01920000-0000-7000-8000-000000000002';

const CATALOGUE_PATH = fileURLToPath(new URL('../data/semul-catalog.json', import.meta.url));

/** Third-party image hosts refuse a default fetch agent; this is a real browser UA. */
const FETCH_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const IMAGE_TIMEOUT_MS = 30_000;

interface CatalogueBrand {
  readonly slug: string;
  readonly name: string;
  readonly defaultWarrantyMonths: number;
}

interface CatalogueCategory {
  readonly slug: string;
  readonly name: string;
  readonly nameAr: string;
  readonly position: number;
}

interface CatalogueProduct {
  readonly sku: string;
  readonly barcode: string | null;
  readonly brand: string;
  readonly category: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly description: string;
  readonly metaDescription: string;
  readonly variantTitle: string;
  readonly costFils: number;
  readonly priceFils: number;
  readonly onHand: number;
  readonly imageUrl: string | null;
  readonly sourceUrl: string | null;
  readonly tags: readonly string[];
  readonly imageNote?: string;
}

interface Catalogue {
  readonly source: string;
  readonly markupMultiplier: number;
  readonly brands: readonly CatalogueBrand[];
  readonly categories: readonly CatalogueCategory[];
  readonly products: readonly CatalogueProduct[];
}

const argv = process.argv.slice(2);
const flags = new Set(argv);
const DRY_RUN = flags.has('--dry-run');
const SKIP_IMAGES = flags.has('--skip-images');
const PUBLISH = !flags.has('--draft');
/** `--limit=5` imports the first five rows. For smoke-testing a new environment
 *  before committing the whole catalogue to it. */
const LIMIT = Number(argv.find((a) => a.startsWith('--limit='))?.slice(8) ?? Number.NaN);

const ctx: TenantContext = {
  tenantId: TENANT_ID,
  storeId: STORE_ID,
  currency: 'AED',
  locale: 'en-AE',
  vatRateBps: 500,
  pricesIncludeVat: true,
};

/**
 * `system`, not a staff user.
 *
 * Stock movements carry an actor, and attributing 367 opening units to whoever
 * happened to run the script would put a person's name against a number they
 * did not count. An import is the system acting on a supplier document.
 */
const actor: ActorContext = { type: 'system', label: 'catalogue-import' };

function aed(fils: number): string {
  return `AED ${(fils / 100).toFixed(2)}`;
}

async function main(): Promise<void> {
  const file: Catalogue = JSON.parse(await readFile(CATALOGUE_PATH, 'utf8'));
  const catalogue: Catalogue = Number.isInteger(LIMIT)
    ? { ...file, products: file.products.slice(0, LIMIT) }
    : file;

  console.log(`→ Importing ${catalogue.products.length} products`);
  console.log(`  source: ${catalogue.source}`);
  console.log(
    `  pricing: cost × ${catalogue.markupMultiplier}, rounded to whole dirhams, VAT-inclusive`,
  );
  if (DRY_RUN) console.log('  DRY RUN — nothing will be written');
  if (SKIP_IMAGES) console.log('  images skipped');
  if (Number.isInteger(LIMIT)) console.log(`  limited to the first ${LIMIT} rows`);
  console.log(`  status on completion: ${PUBLISH ? 'active (live)' : 'draft'}`);
  console.log();

  const d = dbAdmin();

  /* ── Store must exist ─────────────────────────────────────────────── */

  const store = await d.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM stores WHERE id = ${STORE_ID} AND tenant_id = ${TENANT_ID}
  `);
  if (Number(store.rows[0]?.n ?? 0) === 0) {
    throw new Error(
      `Store ${STORE_ID} does not exist. Run \`npm run db:seed\` first — it creates the tenant, ` +
        'store and warehouses this import writes into.',
    );
  }

  /* ── Brands ───────────────────────────────────────────────────────── */

  const brandIds = new Map<string, string>();
  for (const brand of catalogue.brands) {
    const id = uuidv7();
    if (!DRY_RUN) {
      await d.execute(sql`
        INSERT INTO brands (id, tenant_id, slug, name, default_warranty_months, created_at, updated_at)
        VALUES (${id}, ${TENANT_ID}, ${brand.slug}, ${brand.name}, ${brand.defaultWarrantyMonths},
                now(), now())
        ON CONFLICT (tenant_id, slug) DO UPDATE SET name = excluded.name, updated_at = now()
      `);
    }
    const row = await d.execute<{ id: string }>(sql`
      SELECT id FROM brands WHERE tenant_id = ${TENANT_ID} AND slug = ${brand.slug}
    `);
    brandIds.set(brand.slug, row.rows[0]?.id ?? id);
  }
  console.log(`✓ ${catalogue.brands.length} brands`);

  /* ── Categories ───────────────────────────────────────────────────── */

  const categoryIds = new Map<string, string>();
  for (const category of catalogue.categories) {
    const id = uuidv7();
    if (!DRY_RUN) {
      await d.execute(sql`
        INSERT INTO categories
          (id, tenant_id, slug, name, path, depth, position, is_visible, translations,
           created_at, updated_at)
        VALUES (${id}, ${TENANT_ID}, ${category.slug}, ${category.name}, ${`/${category.slug}`},
                0, ${category.position}, true,
                ${JSON.stringify({ 'ar-AE': { name: category.nameAr } })}::jsonb, now(), now())
        ON CONFLICT (tenant_id, slug) DO UPDATE SET
          name = excluded.name,
          position = excluded.position,
          translations = excluded.translations,
          updated_at = now()
      `);
    }
    const row = await d.execute<{ id: string }>(sql`
      SELECT id FROM categories WHERE tenant_id = ${TENANT_ID} AND slug = ${category.slug}
    `);
    categoryIds.set(category.slug, row.rows[0]?.id ?? id);
  }
  console.log(`✓ ${catalogue.categories.length} categories`);
  console.log();

  /* ── Products ─────────────────────────────────────────────────────── */

  const storage = SKIP_IMAGES || DRY_RUN ? undefined : resolveStorage();

  let created = 0;
  let skipped = 0;
  let images = 0;
  const failures: string[] = [];
  const withoutImage: string[] = [];

  for (const [index, product] of catalogue.products.entries()) {
    const position = `[${String(index + 1).padStart(3, ' ')}/${catalogue.products.length}]`;

    // SKU is the identity here, not the title: two colours of the same cable
    // share almost every word of their name but are different things to buy.
    const existing = await d.execute<{ product_id: string }>(sql`
      SELECT product_id FROM variants
      WHERE tenant_id = ${TENANT_ID} AND sku = ${product.sku} AND deleted_at IS NULL
    `);
    if (existing.rows[0]) {
      skipped += 1;
      console.log(`${position} · ${product.sku} already imported`);
      continue;
    }

    if (DRY_RUN) {
      created += 1;
      console.log(
        `${position} + ${product.sku} — ${product.title} — ${aed(product.priceFils)} (cost ${aed(product.costFils)}), ${product.onHand} in stock`,
      );
      continue;
    }

    let productId: string;
    let slug: string;
    try {
      ({ id: productId, slug } = await withTenant(
        TENANT_ID,
        (tx) =>
          createProduct(
            tx,
            ctx,
            actor,
            {
              title: product.title,
              ...(product.subtitle ? { subtitle: product.subtitle } : {}),
              description: product.description,
              brandId: brandIds.get(product.brand)!,
              categoryId: categoryIds.get(product.category)!,
              condition: 'new',
            },
            {
              sku: product.sku,
              title: product.variantTitle,
              price: product.priceFils,
              costPrice: product.costFils,
              onHand: product.onHand,
            },
          ),
        d,
      ));
    } catch (error) {
      failures.push(`${product.sku}: ${(error as Error).message}`);
      console.error(`${position} ✗ ${product.sku} — ${(error as Error).message}`);
      continue;
    }

    // Fields `createProduct` does not carry. Barcode is the one that matters
    // operationally: it is how a scanner at the counter finds the variant, and
    // how noon and Amazon match the listing to a GTIN.
    await d.execute(sql`
      UPDATE variants SET barcode = ${product.barcode}, mpn = ${product.sku}, updated_at = now()
      WHERE tenant_id = ${TENANT_ID} AND product_id = ${productId}
    `);
    await d.execute(sql`
      UPDATE products SET
        meta_title = ${`${product.title} — Voltix UAE`},
        meta_description = ${product.metaDescription},
        tags = ${JSON.stringify(product.tags)}::jsonb,
        updated_at = now()
      WHERE tenant_id = ${TENANT_ID} AND id = ${productId}
    `);

    /* ── Photography ────────────────────────────────────────────────── */

    if (product.imageUrl && storage) {
      try {
        const bytes = await fetchImage(product.imageUrl);
        const prepared = await prepareImage(bytes);
        const key = `products/${productId}/${crypto.randomUUID()}.${prepared.extension}`;
        const stored = await storage.put(key, prepared.body, prepared.contentType);

        await withTenant(
          TENANT_ID,
          (tx) =>
            addProductImage(tx, ctx, actor, {
              productId,
              url: stored.url,
              width: prepared.width,
              height: prepared.height,
              blurDataUrl: prepared.blurDataUrl,
              altText: product.title,
            }),
          d,
        );
        images += 1;
      } catch (error) {
        withoutImage.push(`${product.sku} (fetch failed: ${(error as Error).message})`);
        console.warn(`${position} ! ${product.sku} — image failed: ${(error as Error).message}`);
      }
    } else if (!product.imageUrl) {
      withoutImage.push(`${product.sku} (${product.imageNote ?? 'no source photo'})`);
    }

    if (PUBLISH) {
      await withTenant(
        TENANT_ID,
        (tx) => setProductStatus(tx, ctx, actor, productId, 'active'),
        d,
      );
    }

    created += 1;
    console.log(`${position} + ${product.sku} — ${product.title} (/${slug}) — ${aed(product.priceFils)}`);
  }

  /* ── Report ───────────────────────────────────────────────────────── */

  console.log();
  console.log(`✓ ${created} products ${DRY_RUN ? 'would be created' : 'created'}`);
  if (skipped > 0) console.log(`  ${skipped} already present, left untouched`);
  if (!DRY_RUN && !SKIP_IMAGES) console.log(`  ${images} images uploaded`);

  if (withoutImage.length > 0) {
    console.log();
    console.log(`⚠ ${withoutImage.length} products have no photograph — upload one in the admin:`);
    for (const line of withoutImage) console.log(`    ${line}`);
  }

  if (failures.length > 0) {
    console.log();
    console.log(`✗ ${failures.length} products failed:`);
    for (const line of failures) console.log(`    ${line}`);
    process.exitCode = 1;
  }

  const total = await d.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM products WHERE tenant_id = ${TENANT_ID} AND deleted_at IS NULL
  `);
  console.log();
  console.log(`Catalogue now holds ${total.rows[0]?.n ?? 0} products.`);
}

/**
 * Fetches image bytes with a timeout and a browser user-agent.
 *
 * The timeout is not defensive decoration: several of the source hosts accept
 * the connection and then never respond, and without an abort the import hangs
 * on product 63 of 147 with no output.
 */
async function fetchImage(url: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { 'user-agent': FETCH_UA, accept: 'image/*' },
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const type = response.headers.get('content-type') ?? '';
  // A 200 with an HTML body is a bot-check page, not a photograph. Catching it
  // here gives a clear message instead of "unreadable image" from sharp.
  if (!type.startsWith('image/')) throw new Error(`served ${type || 'unknown type'}, not an image`);

  return new Uint8Array(await response.arrayBuffer());
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeConnections);
