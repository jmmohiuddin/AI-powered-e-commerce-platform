/**
 * Removes the demo catalogue that `packages/db/scripts/seed.ts` creates.
 *
 * The seed exists so `npm install && npm run dev` gives a working store on a
 * fresh checkout. Once a real catalogue is imported those six products are no
 * longer scaffolding — they are six phones and mice the shop does not sell,
 * sitting in search results and the sitemap next to the stock it does.
 *
 * Deliberately a separate script rather than a flag on the import:
 *
 *  • **Different blast radius.** Importing adds rows. This one removes them,
 *    and the two should not be one keystroke apart.
 *  • **It must be able to refuse.** `stock_movements`, `serial_units`,
 *    `purchase_order_items` and `cart_items` reference a variant with
 *    ON DELETE RESTRICT. This script clears the first four itself, because a
 *    demo product's opening-balance movement is bookkeeping for stock that was
 *    never real. It does *not* touch orders: `order_items` holds the variant
 *    with ON DELETE SET NULL and keeps its own price and title snapshot, so a
 *    real order that once contained a demo product survives the deletion with
 *    its history intact.
 *
 * Brands and categories are soft-deleted rather than dropped. They are
 * referenced by nothing once the products are gone, but a category is the kind
 * of row a merchant reaches for again ("we do sell smartphones now"), and
 * `deleted_at` is the schema's own answer to that.
 *
 * Usage, from the repository root:
 *
 *     npm run db:remove-demo -- --dry-run
 *     npm run db:remove-demo -- --confirm
 */
// Must be first: populates process.env from the repo-root .env before any
// module below reads a connection string at import time.
import '@phoyev/config/load-env';
import { sql } from 'drizzle-orm';
import { closeConnections, dbAdmin } from '@phoyev/db';

const TENANT_ID = '01920000-0000-7000-8000-000000000001';

/** Exactly the slugs in `PRODUCTS` in packages/db/scripts/seed.ts. */
const DEMO_PRODUCT_SLUGS = [
  'samsung-galaxy-s25-ultra',
  'xiaomi-redmi-note-14-pro',
  'anker-nano-ii-65w-charger',
  'logitech-mx-master-3s',
  'soundcore-liberty-4-nc',
  'samsung-t7-shield-1tb',
] as const;

/** The seed's brands. Named explicitly so a real Samsung listing later is safe. */
const DEMO_BRAND_SLUGS = [
  'samsung',
  'apple',
  'xiaomi',
  'anker',
  'logitech',
  'soundcore',
] as const;

const DEMO_CATEGORY_SLUGS = [
  'smartphones',
  'audio',
  'chargers-cables',
  'computer-accessories',
  'storage',
] as const;

const flags = new Set(process.argv.slice(2));
const DRY_RUN = !flags.has('--confirm');

async function main(): Promise<void> {
  const d = dbAdmin();

  const products = await d.execute<{ id: string; slug: string; title: string }>(sql`
    SELECT id, slug, title FROM products
    WHERE tenant_id = ${TENANT_ID}
      AND slug IN ${DEMO_PRODUCT_SLUGS}
      AND deleted_at IS NULL
  `);

  if (products.rows.length === 0) {
    console.log('Nothing to do — the demo catalogue is already gone.');
    return;
  }

  console.log(`Found ${products.rows.length} demo products:`);
  for (const row of products.rows) console.log(`  ${row.slug} — ${row.title}`);

  // Reported before deleting, not discovered halfway through. If a demo
  // product was genuinely sold, the merchant should see that before the row
  // that explains the sale is detached from it.
  const sold = await d.execute<{ slug: string; n: number }>(sql`
    SELECT p.slug, count(oi.id)::int AS n
    FROM products p
    JOIN variants v ON v.product_id = p.id
    JOIN order_items oi ON oi.variant_id = v.id
    WHERE p.tenant_id = ${TENANT_ID} AND p.slug IN ${DEMO_PRODUCT_SLUGS}
    GROUP BY p.slug
  `);
  if (sold.rows.length > 0) {
    console.log();
    console.log('⚠ These demo products appear on real orders:');
    for (const row of sold.rows) console.log(`    ${row.slug} — ${row.n} order line(s)`);
    console.log('  The orders keep their own price and title snapshot, so history survives.');
  }

  if (DRY_RUN) {
    console.log();
    console.log('DRY RUN — nothing was deleted. Re-run with --confirm to apply.');
    return;
  }

  const ids = products.rows.map((row) => row.id);

  // Order matters: every RESTRICT reference has to go before the product does.
  const variantScope = sql`SELECT id FROM variants WHERE product_id IN ${ids}`;
  await d.execute(sql`DELETE FROM stock_movements      WHERE variant_id IN (${variantScope})`);
  await d.execute(sql`DELETE FROM serial_units         WHERE variant_id IN (${variantScope})`);
  await d.execute(sql`DELETE FROM purchase_order_items WHERE variant_id IN (${variantScope})`);
  await d.execute(sql`DELETE FROM cart_items           WHERE variant_id IN (${variantScope})`);

  const deleted = await d.execute<{ slug: string }>(sql`
    DELETE FROM products WHERE id IN ${ids} RETURNING slug
  `);
  console.log();
  console.log(`✓ Deleted ${deleted.rows.length} demo products (variants, stock and media cascaded)`);

  const brands = await d.execute<{ slug: string }>(sql`
    UPDATE brands SET deleted_at = now(), updated_at = now()
    WHERE tenant_id = ${TENANT_ID} AND slug IN ${DEMO_BRAND_SLUGS} AND deleted_at IS NULL
    RETURNING slug
  `);
  const categories = await d.execute<{ slug: string }>(sql`
    UPDATE categories SET deleted_at = now(), updated_at = now()
    WHERE tenant_id = ${TENANT_ID} AND slug IN ${DEMO_CATEGORY_SLUGS} AND deleted_at IS NULL
    RETURNING slug
  `);
  console.log(`✓ Hid ${brands.rows.length} demo brands, ${categories.rows.length} demo categories`);

  const remaining = await d.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM products
    WHERE tenant_id = ${TENANT_ID} AND deleted_at IS NULL
  `);
  console.log();
  console.log(`Catalogue now holds ${remaining.rows[0]?.n ?? 0} products.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeConnections);
