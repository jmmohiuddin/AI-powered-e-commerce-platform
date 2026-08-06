/**
 * Migration runner.
 *
 * Three phases, in order:
 *   1. extensions.sql — must exist before any table that uses `vector` or GIN
 *      trigram indexes.
 *   2. Drizzle migrations from ./migrations (generated, committed, reviewed).
 *   3. policies.sql — row-level security and grants, applied idempotently after
 *      the tables exist.
 *
 * Phase 3 is separate because RLS policies reference tables by name and must be
 * re-asserted whenever a new tenant-owned table appears. Making the file
 * idempotent (DROP POLICY IF EXISTS … CREATE POLICY) means re-running it is
 * always safe, which is the property you want at 3am during a rollback.
 */
// Must be first: populates process.env from the repo-root .env before
// any module below reads a connection string at import time.
import '@voltix/config/load-env';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { closeConnections, dbAdmin } from '../src/client';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');

async function runSqlFile(relativePath: string): Promise<void> {
  const contents = await readFile(join(packageRoot, relativePath), 'utf8');
  await dbAdmin().execute(sql.raw(contents));
  console.log(`  ✓ applied ${relativePath}`);
}

async function main(): Promise<void> {
  console.log('→ Applying extensions');
  await runSqlFile('sql/extensions.sql');

  console.log('→ Running Drizzle migrations');
  await migrate(dbAdmin(), { migrationsFolder: join(packageRoot, 'migrations') });
  console.log('  ✓ migrations up to date');

  console.log('→ Applying row-level security policies');
  await runSqlFile('sql/policies.sql');

  console.log('✓ Database is up to date');
}

main()
  .catch((error) => {
    console.error('✗ Migration failed:', error);
    process.exitCode = 1;
  })
  .finally(() => closeConnections());
