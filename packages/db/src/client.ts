import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

let primary: Database | undefined;
let replica: Database | undefined;
let admin: Database | undefined;
let primaryPool: Pool | undefined;
let adminPool: Pool | undefined;

function createPool(connectionString: string, max: number): Pool {
  return new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    /**
     * Long enough for a suspended database to wake, short enough that a genuine
     * outage still fails rather than hanging.
     *
     * 5s was tuned for an always-warm local Postgres and is wrong for managed
     * providers that auto-suspend on idle — Neon's free tier parks the compute
     * after a few minutes, and the first connection afterwards pays a cold
     * start of roughly 5–10s. At a 5s ceiling that first request is guaranteed
     * to fail, so the first visitor after a quiet period reliably sees an
     * error on an otherwise healthy store.
     *
     * Overridable because the right number is a property of the deployment,
     * not of this code: a provisioned always-on instance can safely go back
     * to 5s.
     */
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS || 15_000),
    // Postgres kills idle-in-transaction sessions; keepalive avoids surprise
    // ECONNRESET on connections parked behind a load balancer.
    keepAlive: true,
    // Any TLS-requesting sslmode gets full verification. Node's bundled CA
    // store covers Neon/RDS/Cloud SQL certificates, and `verify-full` in the
    // URL keeps node-postgres's own parsing in agreement with this option —
    // its `require` semantics are changing to libpq's weaker no-verify
    // meaning, which is exactly the downgrade we do not want.
    ssl: /sslmode=(require|verify-ca|verify-full)/.test(connectionString)
      ? { rejectUnauthorized: true }
      : undefined,
  });
}

/**
 * Primary (read-write) handle. Pool size is deliberately small: Postgres
 * degrades past a few hundred connections, and a serverless deployment
 * multiplies pool size by instance count. Production fronts this with PgBouncer
 * in transaction mode (see docs/10-deployment.md).
 */
export function db(): Database {
  if (!primary) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    primaryPool = createPool(url, Number(process.env.DATABASE_POOL_MAX ?? 10));
    primary = drizzle(primaryPool, { schema, casing: 'snake_case' });
  }
  return primary;
}

/**
 * Read-only handle pointed at a replica when one is configured.
 *
 * Use for catalogue browsing, search and reporting. Do NOT use for anything
 * that reads-then-writes: replica lag means a cart total read here could be
 * stale, and "eventual consistency" is not a defence when a customer is
 * charged the wrong amount.
 */
export function dbRead(): Database {
  const url = process.env.DATABASE_REPLICA_URL;
  if (!url) return db();
  if (!replica) {
    replica = drizzle(createPool(url, Number(process.env.DATABASE_REPLICA_POOL_MAX ?? 20)), {
      schema,
      casing: 'snake_case',
    });
  }
  return replica;
}

/**
 * Owner connection. Bypasses row-level security.
 *
 * For migrations, the seed, and the small number of background jobs that
 * legitimately operate across every tenant — the nightly demand forecast reads
 * sales history for all of them. Deliberately a separate function with a
 * separate connection string, so reaching for it is a visible choice in a diff
 * rather than something that happens by accident.
 *
 * Never use this to serve a request. If a request path needs it, the tenant
 * scoping is wrong somewhere upstream.
 */
export function dbAdmin(): Database {
  if (!admin) {
    const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_ADMIN_URL is not set');
    adminPool = createPool(url, Number(process.env.DATABASE_ADMIN_POOL_MAX ?? 4));
    admin = drizzle(adminPool, { schema, casing: 'snake_case' });
  }
  return admin;
}

/**
 * Runs `fn` inside a transaction with the tenant context set, so Postgres
 * row-level security can enforce isolation independently of application code.
 *
 * `set_config(..., true)` scopes the setting to the transaction, which means a
 * pooled connection cannot leak one tenant's context into another tenant's
 * next query — the failure mode that makes hand-rolled multi-tenancy dangerous.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>,
  database: Database = db(),
): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/**
 * Read-side equivalent of `withTenant`, routed to the replica when configured.
 *
 * Exists because catalogue reads must *also* carry the tenant context. With
 * row-level security active, a read that forgets it does not leak — it returns
 * zero rows, which is safe but looks like an empty catalogue. That failure mode
 * is quiet enough to reach production, so the wrapper is the only sanctioned
 * way to read tenant data.
 */
export async function withTenantRead<T>(
  tenantId: string,
  fn: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return dbRead().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/** Liveness probe used by the health endpoint and by CI before running tests. */
export async function ping(database: Database = db()): Promise<boolean> {
  try {
    await database.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

/** Graceful shutdown — lets in-flight queries finish before the process exits. */
export async function closeConnections(): Promise<void> {
  await Promise.all([primaryPool?.end(), adminPool?.end()]);
  primary = undefined;
  replica = undefined;
  admin = undefined;
  primaryPool = undefined;
  adminPool = undefined;
}
