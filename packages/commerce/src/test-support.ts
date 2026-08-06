import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { uuidv7 } from '@voltix/db';
import * as schema from '@voltix/db/schema';
import type { TenantContext } from './types';

/**
 * Integration-test harness.
 *
 * These tests run against a **real** Postgres, as the **restricted application
 * role**, with row-level security active. That combination is the whole point:
 * the properties being tested — tenant isolation, oversell prevention under
 * concurrency, gap-free numbering — are properties of the database and its
 * locking behaviour. A mock proves the mock works.
 *
 * Connecting as `voltix_app` rather than the owner is non-negotiable here. The
 * owner bypasses RLS silently, so an isolation test run as the owner passes
 * while proving nothing.
 */

const APP_URL =
  process.env.DATABASE_URL ??
  'postgres://voltix_app:voltix_app_dev_password@localhost:5433/voltix';
const OWNER_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://voltix:voltix_dev_password@localhost:5433/voltix';

let appPool: Pool | undefined;
let ownerPool: Pool | undefined;

export type Db = NodePgDatabase<typeof schema>;

export function appDb(): Db {
  appPool ??= new Pool({ connectionString: APP_URL, max: 12 });
  return drizzle(appPool, { schema, casing: 'snake_case' });
}

export function ownerDb(): Db {
  ownerPool ??= new Pool({ connectionString: OWNER_URL, max: 4 });
  return drizzle(ownerPool, { schema, casing: 'snake_case' });
}

export async function closeTestPools(): Promise<void> {
  await Promise.all([appPool?.end(), ownerPool?.end()]);
  appPool = undefined;
  ownerPool = undefined;
}

/**
 * Is a usable database reachable?
 *
 * The suite skips rather than fails when Postgres is absent, so `npm test` on a
 * laptop with no containers still runs the 174 pure tests. CI always has the
 * database, so the integration tests always run there — skipping locally is a
 * convenience, not a way to avoid the check.
 */
export async function databaseAvailable(): Promise<boolean> {
  try {
    await appDb().execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

/** Runs `fn` as the application role with the tenant context set. */
export function asTenant<T>(
  tenantId: string,
  fn: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return appDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

export interface Fixture {
  readonly tenantId: string;
  readonly storeId: string;
  readonly warehouseId: string;
  readonly ctx: TenantContext;
  /** Creates a product with one variant at the given price and stock. */
  variant(input: { price: number; onHand: number; cost?: number }): Promise<string>;
  cleanup(): Promise<void>;
}

/**
 * Builds an isolated tenant per test.
 *
 * A fresh tenant rather than a shared one, because these tests assert on stock
 * counts and order numbers — values a neighbouring test would perturb. Setup
 * runs as the owner (creating a tenant is inherently a cross-tenant act); every
 * assertion afterwards runs as the restricted role.
 */
export async function createFixture(label: string): Promise<Fixture> {
  const owner = ownerDb();
  const tenantId = uuidv7();
  const storeId = uuidv7();
  const warehouseId = uuidv7();

  await owner.execute(sql`
    INSERT INTO tenants (id, slug, name, plan, status, country_code, default_currency,
                         default_locale, timezone, vat_rate_bps, prices_include_vat,
                         created_at, updated_at)
    VALUES (${tenantId}, ${`test-${label}-${tenantId.slice(0, 8)}`}, ${`Test ${label}`},
            'growth', 'active', 'AE', 'AED', 'en-AE', 'Asia/Dubai', 500, true, now(), now())
  `);
  await owner.execute(sql`
    INSERT INTO stores (id, tenant_id, name, currency, locale, is_default, created_at, updated_at)
    VALUES (${storeId}, ${tenantId}, 'Test store', 'AED', 'en-AE', true, now(), now())
  `);
  await owner.execute(sql`
    INSERT INTO warehouses (id, tenant_id, code, name, kind, priority, is_active, created_at, updated_at)
    VALUES (${warehouseId}, ${tenantId}, 'DXB-T', 'Dubai test', 'warehouse', 10, true, now(), now())
  `);

  return {
    tenantId,
    storeId,
    warehouseId,
    ctx: {
      tenantId,
      storeId,
      currency: 'AED',
      locale: 'en-AE',
      vatRateBps: 500,
      pricesIncludeVat: true,
    },

    async variant({ price, onHand, cost }) {
      const productId = uuidv7();
      const variantId = uuidv7();
      // UUIDv7 leads with the millisecond timestamp, so the first bytes collide
      // for rows created in the same tick. The tail is the random block.
      const suffix = variantId.replace(/-/g, '').slice(-12);

      await owner.execute(sql`
        INSERT INTO products (id, tenant_id, store_id, slug, title, status, condition,
                              published_at, currency, price_from, rating_count, created_at, updated_at)
        VALUES (${productId}, ${tenantId}, ${storeId}, ${`p-${suffix}`}, ${`Product ${suffix}`},
                'active', 'new', now(), 'AED', ${price}, 0, now(), now())
      `);
      await owner.execute(sql`
        INSERT INTO variants (id, tenant_id, product_id, sku, title, options, price, cost_price,
                              currency, is_active, requires_shipping, position, created_at, updated_at)
        VALUES (${variantId}, ${tenantId}, ${productId}, ${`SKU-${suffix}`}, 'Default', '{}'::jsonb,
                ${price}, ${cost ?? Math.round(price * 0.7)}, 'AED', true, true, 0, now(), now())
      `);
      await owner.execute(sql`
        INSERT INTO stock_levels (id, tenant_id, variant_id, warehouse_id, on_hand, reserved,
                                  incoming, reorder_point, reorder_quantity, allow_backorder,
                                  version, created_at, updated_at)
        VALUES (${uuidv7()}, ${tenantId}, ${variantId}, ${warehouseId}, ${onHand}, 0, 0, 5, 20,
                false, 0, now(), now())
      `);
      return variantId;
    },

    async cleanup() {
      /**
       * Order matters, and the reason is a feature rather than an
       * inconvenience: `stock_movements` and `transactions` reference their
       * variant and order with ON DELETE RESTRICT, because a financial ledger
       * must survive the deletion of the product it refers to. Deleting the
       * tenant therefore cannot cascade through them.
       *
       * Real tenant offboarding has the same shape — anonymise and archive,
       * never blind-cascade — so the fixture tears down explicitly rather than
       * relaxing the constraint to make tests convenient.
       */
      await owner.execute(sql`DELETE FROM stock_movements WHERE tenant_id = ${tenantId}`);
      await owner.execute(sql`DELETE FROM transactions WHERE tenant_id = ${tenantId}`);
      await owner.execute(sql`DELETE FROM stock_reservations WHERE tenant_id = ${tenantId}`);
      await owner.execute(sql`DELETE FROM order_items WHERE tenant_id = ${tenantId}`);
      await owner.execute(sql`DELETE FROM order_events WHERE tenant_id = ${tenantId}`);
      await owner.execute(sql`DELETE FROM payment_intents WHERE tenant_id = ${tenantId}`);
      await owner.execute(sql`DELETE FROM discount_redemptions WHERE tenant_id = ${tenantId}`);
      await owner.execute(sql`DELETE FROM orders WHERE tenant_id = ${tenantId}`);
      await owner.execute(sql`DELETE FROM cart_items WHERE tenant_id = ${tenantId}`);
      await owner.execute(sql`DELETE FROM carts WHERE tenant_id = ${tenantId}`);
      await owner.execute(sql`DELETE FROM stock_levels WHERE tenant_id = ${tenantId}`);
      await owner.execute(sql`DELETE FROM variants WHERE tenant_id = ${tenantId}`);
      await owner.execute(sql`DELETE FROM products WHERE tenant_id = ${tenantId}`);
      await owner.execute(sql`DELETE FROM warehouses WHERE tenant_id = ${tenantId}`);
      await owner.execute(sql`DELETE FROM stores WHERE tenant_id = ${tenantId}`);
      await owner.execute(sql`DELETE FROM counters WHERE tenant_id = ${tenantId}`);
      await owner.execute(sql`DELETE FROM idempotency_keys WHERE tenant_id = ${tenantId}`);
      await owner.execute(sql`DELETE FROM jobs WHERE tenant_id = ${tenantId}`);
      await owner.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
    },
  };
}

export const UAE_ADDRESS = {
  recipientName: 'Aisha Al Mansoori',
  phone: '+971501234567',
  emirate: 'DU' as const,
  area: 'Dubai Marina',
  buildingName: 'Marina Heights Tower',
  flatOrVilla: '2104',
  makani: '2648870219',
};
