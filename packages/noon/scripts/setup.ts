/**
 * Bootstrap for the noon integration.
 *
 * The sync engine only touches variants that appear in `noon_listings` and
 * warehouses that appear in `noon_warehouse_map`. Both start empty, which is
 * deliberate — an integration that mirrored the whole catalogue the moment
 * credentials were added would publish every draft, discontinued and
 * internal-only SKU the merchant has. This script is how a human opts rows in.
 *
 *   npm run setup --workspace=@voltix/noon -- whoami
 *   npm run setup --workspace=@voltix/noon -- warehouses
 *   npm run setup --workspace=@voltix/noon -- map <voltix-warehouse-code> <noon-warehouse-code> [country]
 *   npm run setup --workspace=@voltix/noon -- link [--all | --sku SKU ...] [--live]
 *   npm run setup --workspace=@voltix/noon -- status
 *
 * Every subcommand is safe to re-run.
 */

import '@voltix/config/load-env';
import { sql } from 'drizzle-orm';
import { closeConnections, dbAdmin, uuidv7 } from '@voltix/db';
import { NoonClient, isProductionTarget, loadNoonConfig } from '../src/index.js';

const [command, ...args] = process.argv.slice(2);

/**
 * Resolves the tenant to operate on.
 *
 * Voltix is deployed for one tenant but the schema is multi-tenant, so this
 * refuses to guess when there is more than one rather than silently picking
 * the first and mapping another merchant's warehouses.
 */
async function resolveTenant(): Promise<string> {
  const explicit = process.env.VOLTIX_TENANT_ID?.trim();
  if (explicit) return explicit;

  const rows = await dbAdmin().transaction(async (tx) => {
    const result = await tx.execute<{ id: string; name: string }>(sql`
      SELECT id, name FROM tenants ORDER BY created_at LIMIT 5
    `);
    return result.rows;
  });

  if (rows.length === 0) throw new Error('No tenants exist. Run the seed first.');
  if (rows.length > 1) {
    throw new Error(
      `${rows.length} tenants found — set VOLTIX_TENANT_ID to choose:\n` +
        rows.map((row) => `  ${row.id}  ${row.name}`).join('\n'),
    );
  }
  return rows[0]!.id;
}

function client(): NoonClient {
  const config = loadNoonConfig();
  console.log(
    `noon: ${config.baseUrl}` +
      (isProductionTarget(config) ? '  ⚠ PRODUCTION — writes affect live listings' : '  (sandbox)'),
  );
  return new NoonClient(config);
}

// ---------------------------------------------------------------------------

/** Confirms the credentials work before anything else is debugged. */
async function whoami(): Promise<void> {
  const warehouses = await client().listWarehouses();
  console.log(`✓ authenticated — ${warehouses.length} warehouse(s) visible to this project`);
}

async function listWarehouses(): Promise<void> {
  const warehouses = await client().listWarehouses();
  if (warehouses.length === 0) {
    console.log('No warehouses. Create one in the noon Partner Portal first.');
    return;
  }
  console.log('\nnoon warehouses:');
  for (const warehouse of warehouses) {
    console.log(
      `  ${warehouse.warehouse_code.padEnd(20)} ${warehouse.display_name}` +
        `  [${warehouse.fulfillment_system_code}]${warehouse.is_active ? '' : '  (inactive)'}`,
    );
  }

  const local = await dbAdmin().transaction(async (tx) => {
    const result = await tx.execute<{ code: string; name: string }>(sql`
      SELECT code, name FROM warehouses WHERE deleted_at IS NULL ORDER BY name
    `);
    return result.rows;
  });

  console.log('\nVoltix warehouses:');
  for (const warehouse of local) console.log(`  ${warehouse.code.padEnd(20)} ${warehouse.name}`);
  console.log('\nMap them with:  … -- map <voltix-code> <noon-code> [country]');
}

async function map(): Promise<void> {
  const [voltixCode, noonCode, country = 'ae'] = args;
  if (!voltixCode || !noonCode) {
    throw new Error('Usage: map <voltix-warehouse-code> <noon-warehouse-code> [country]');
  }

  const tenantId = await resolveTenant();
  const remote = (await client().listWarehouses()).find((w) => w.warehouse_code === noonCode);
  if (!remote) {
    throw new Error(
      `noon has no warehouse "${noonCode}". Run \`warehouses\` to see the valid codes.`,
    );
  }

  await dbAdmin().transaction(async (tx) => {
    const local = await tx.execute<{ id: string }>(sql`
      SELECT id FROM warehouses
       WHERE tenant_id = ${tenantId} AND code = ${voltixCode} AND deleted_at IS NULL
    `);
    const warehouseId = local.rows[0]?.id;
    if (!warehouseId) throw new Error(`No Voltix warehouse with code "${voltixCode}".`);

    await tx.execute(sql`
      INSERT INTO noon_warehouse_map
        (id, tenant_id, warehouse_id, warehouse_code, display_name,
         fulfillment_system_code, country_code, is_active, created_at, updated_at)
      VALUES
        (${uuidv7()}, ${tenantId}, ${warehouseId}, ${noonCode}, ${remote.display_name},
         ${remote.fulfillment_system_code}, ${country.toLowerCase()}, ${remote.is_active},
         now(), now())
      ON CONFLICT (tenant_id, warehouse_id) DO UPDATE
        SET warehouse_code = EXCLUDED.warehouse_code,
            display_name = EXCLUDED.display_name,
            fulfillment_system_code = EXCLUDED.fulfillment_system_code,
            country_code = EXCLUDED.country_code,
            is_active = EXCLUDED.is_active,
            updated_at = now()
    `);
  });

  console.log(`✓ ${voltixCode} → ${noonCode} (${country})`);
}

/**
 * Opts variants into the sync.
 *
 * `--live` marks the listings `live` immediately, which is correct only when
 * the products already exist on noon and were created outside this system.
 * Without it they land as `draft` and the catalogue push has to submit them
 * first — the right default, because marking a listing live that noon has
 * never seen produces a stream of per-item rejections on every sweep.
 */
async function link(): Promise<void> {
  const tenantId = await resolveTenant();
  const all = args.includes('--all');
  const live = args.includes('--live');
  const skus = args.filter((arg, i) => args[i - 1] === '--sku');

  if (!all && skus.length === 0) {
    throw new Error('Specify --all, or one or more --sku SKU. Nothing was changed.');
  }

  const status = live ? 'live' : 'draft';

  const inserted = await dbAdmin().transaction(async (tx) => {
    // Two steps rather than one INSERT … SELECT so the ids are UUIDv7 like
    // every other primary key here. `gen_random_uuid()` would be v4, which the
    // note in db/schema/_shared.ts explains destroys index locality.
    const candidates = await tx.execute<{ id: string; sku: string }>(sql`
      SELECT id, sku FROM variants
       WHERE tenant_id = ${tenantId}
         AND deleted_at IS NULL
         AND is_active
         ${all ? sql`` : sql`AND sku = ANY(${skus}::text[])`}
    `);

    const written: Array<{ sku: string }> = [];
    for (const variant of candidates.rows) {
      const result = await tx.execute<{ sku: string }>(sql`
        INSERT INTO noon_listings
          (id, tenant_id, variant_id, partner_sku, status, sync_enabled, created_at, updated_at)
        VALUES
          (${uuidv7()}, ${tenantId}, ${variant.id}, ${variant.sku},
           ${status}::noon_listing_status, true, now(), now())
        ON CONFLICT (tenant_id, variant_id) DO NOTHING
        RETURNING partner_sku AS sku
      `);
      if (result.rows.length > 0) written.push({ sku: variant.sku });
    }
    return written;
  });

  console.log(`✓ linked ${inserted.length} variant(s) as ${status}`);
  if (inserted.length > 0) {
    console.log(`  ${inserted.slice(0, 10).map((r) => r.sku).join(', ')}${inserted.length > 10 ? ' …' : ''}`);
  }
  if (!live) {
    console.log('  They are drafts: the catalogue push submits them to noon for approval first.');
  }
}

/** What the sync would do right now, without doing it. */
async function status(): Promise<void> {
  const tenantId = await resolveTenant();

  const rows = await dbAdmin().transaction(async (tx) => {
    const summary = await tx.execute<{ status: string; n: number; failing: number }>(sql`
      SELECT status,
             COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE consecutive_failures > 0)::int AS failing
        FROM noon_listings WHERE tenant_id = ${tenantId}
       GROUP BY status ORDER BY status
    `);

    const pending = await tx.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
        FROM noon_listings l
        JOIN stock_levels s ON s.variant_id = l.variant_id AND s.tenant_id = l.tenant_id
        JOIN noon_warehouse_map w ON w.warehouse_id = s.warehouse_id AND w.tenant_id = l.tenant_id
       WHERE l.tenant_id = ${tenantId} AND l.status = 'live' AND l.sync_enabled
         AND NOT s.allow_backorder
         AND l.pushed_qty IS DISTINCT FROM GREATEST(0, s.on_hand - s.reserved)
    `);

    const errors = await tx.execute<{ partner_sku: string; last_error: string }>(sql`
      SELECT partner_sku, last_error FROM noon_listings
       WHERE tenant_id = ${tenantId} AND last_error IS NOT NULL
       ORDER BY last_error_at DESC LIMIT 5
    `);

    const warehouses = await tx.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM noon_warehouse_map WHERE tenant_id = ${tenantId} AND is_active
    `);

    return {
      summary: summary.rows,
      pending: pending.rows[0]?.n ?? 0,
      errors: errors.rows,
      warehouses: warehouses.rows[0]?.n ?? 0,
    };
  });

  console.log(`\nmapped warehouses: ${rows.warehouses}`);
  if (rows.warehouses === 0) console.log('  ⚠ nothing will sync until at least one is mapped');

  console.log('listings:');
  if (rows.summary.length === 0) console.log('  none — run `link` first');
  for (const row of rows.summary) {
    console.log(`  ${row.status.padEnd(18)} ${row.n}${row.failing ? `  (${row.failing} failing)` : ''}`);
  }

  console.log(`\nstock updates the next sweep would send: ${rows.pending}`);

  if (rows.errors.length > 0) {
    console.log('\nrecent rejections:');
    for (const row of rows.errors) console.log(`  ${row.partner_sku}: ${row.last_error}`);
  }
}

// ---------------------------------------------------------------------------

const COMMANDS: Record<string, () => Promise<void>> = {
  whoami,
  warehouses: listWarehouses,
  map,
  link,
  status,
};

async function main(): Promise<void> {
  const handler = command ? COMMANDS[command] : undefined;
  if (!handler) {
    console.log(`Usage: npm run setup --workspace=@voltix/noon -- <command>\n`);
    console.log(`  whoami       verify the credentials authenticate`);
    console.log(`  warehouses   list noon and Voltix warehouses side by side`);
    console.log(`  map          map a Voltix warehouse to a noon warehouse code`);
    console.log(`  link         opt variants into the sync`);
    console.log(`  status       what the sync would do right now`);
    process.exitCode = command ? 1 : 0;
    return;
  }
  await handler();
}

main()
  .catch((error: unknown) => {
    console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => closeConnections());
