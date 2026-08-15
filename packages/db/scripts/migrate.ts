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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SCRIPT REPORTS THE WAY IT DOES
 *
 * It used to print "✓ migrations up to date" unconditionally, immediately after
 * `migrate()` returned. That line is true in both cases and therefore says
 * nothing: a run that altered a production schema and a run that did absolutely
 * nothing produced identical output. That is not a cosmetic problem. It cost
 * this project a real incident review, in which migrations were believed to
 * have been applied to a hosted database by someone who had not applied them,
 * and the transcript could not settle the question either way because the
 * output was the same either way.
 *
 * So the two things a person needs before and after running this — WHICH
 * database, and WHAT changed — are now both stated:
 *
 *   • the target is printed as host and database name (never credentials)
 *     BEFORE anything is applied, because the original accident was someone
 *     assuming local Docker while `.env` pointed at a hosted Neon instance;
 *   • the migrations actually applied are named, by diffing the journal on disk
 *     against the `drizzle.__drizzle_migrations` table either side of the call.
 *     `migrate()` itself returns void and offers no other way to know.
 *
 * There is deliberately NO confirmation prompt on a remote target. CI runs this
 * unattended and a prompt would hang the pipeline; the remedy for the accident
 * is making the truth impossible to miss, not adding a gate that has to be
 * bypassed in the one environment that runs this most often.
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

/**
 * One migration, as the journal records it.
 *
 * `when` is the timestamp drizzle writes into `__drizzle_migrations.created_at`
 * when it applies the file, so it is the join key between what is on disk and
 * what is in the database.
 */
interface JournalEntry {
  readonly when: number;
  readonly tag: string;
}

async function journalEntries(): Promise<JournalEntry[]> {
  const raw = await readFile(join(packageRoot, 'migrations/meta/_journal.json'), 'utf8');
  const parsed = JSON.parse(raw) as { entries?: Array<{ when?: unknown; tag?: unknown }> };
  return (parsed.entries ?? [])
    .filter((e): e is { when: number; tag: string } =>
      typeof e.when === 'number' && typeof e.tag === 'string')
    .map((e) => ({ when: e.when, tag: e.tag }));
}

/**
 * The `created_at` stamps already recorded in the database, as strings.
 *
 * Strings rather than numbers because the column is `bigint`, which node-postgres
 * returns as text to avoid silently losing precision — comparing it as a number
 * would work today and stop working for no visible reason later.
 *
 * Returns an empty set when the tracking table does not exist yet, which is the
 * ordinary state of a database that has never been migrated. That is not an
 * error and must not be reported as one: on a fresh database this is exactly
 * the path a first run takes.
 */
async function appliedStamps(): Promise<Set<string>> {
  // Asked rather than caught. Wrapping the SELECT in a try/catch would treat a
  // dropped connection or a permissions failure as "nothing applied yet", and
  // this function's answer is what decides whether the script reports having
  // changed the schema — the one place a swallowed error would produce a
  // confident, wrong sentence.
  const exists = await dbAdmin().execute<{ present: boolean }>(
    sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`,
  );
  if (!exists.rows[0]?.present) return new Set();

  const rows = await dbAdmin().execute<{ created_at: string }>(
    sql`SELECT created_at FROM drizzle.__drizzle_migrations`,
  );
  return new Set(rows.rows.map((r) => String(r.created_at)));
}

/**
 * The database being written to, in a form that is safe to print.
 *
 * Host and database name only. A connection string carries a password, and a
 * script whose whole purpose is to be pasted into an incident thread must not
 * be the thing that leaks one.
 */
function describeTarget(): { label: string; local: boolean } {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL ?? '';
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const port = parsed.port ? `:${parsed.port}` : '';
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || '(default)';
    return { label: `${host}${port}/${database}`, local: isLocalHost(host) };
  } catch {
    // An unparseable string is still a string somebody configured. Say so, and
    // treat it as remote — the conservative direction, since the cost of a
    // needless warning is nothing and the cost of a missing one is the incident
    // this function exists to prevent.
    return { label: '(unparseable connection string)', local: false };
  }
}

function isLocalHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host === 'host.docker.internal'
  );
}

async function runSqlFile(relativePath: string): Promise<void> {
  const contents = await readFile(join(packageRoot, relativePath), 'utf8');
  await dbAdmin().execute(sql.raw(contents));
  // Honest as it stands: the line is printed only after `execute` resolves, so
  // it claims the file was applied and nothing more. These two files are
  // idempotent by construction and re-running them is a no-op the database does
  // not distinguish, so "applied" is the whole of what can be known here.
  console.log(`  ✓ applied ${relativePath}`);
}

async function main(): Promise<void> {
  const target = describeTarget();

  if (target.local) {
    console.log(`→ target: ${target.label}`);
  } else {
    /**
     * Loud, and above the work rather than after it.
     *
     * The accident this prevents is someone running the script believing it
     * points at Docker. By the time output scrolls past, the migration has
     * already been applied — so this has to be the first thing on screen, and
     * it has to look different from every other line the script prints.
     */
    console.log('');
    console.log('  ╔════════════════════════════════════════════════════════════════╗');
    console.log('  ║  ⚠  REMOTE DATABASE — this is not local Docker                 ║');
    console.log('  ╚════════════════════════════════════════════════════════════════╝');
    console.log(`  ⚠  target: ${target.label}`);
    console.log('  ⚠  Migrations applied here affect every user of that database.');
    console.log('');
  }

  console.log('→ Applying extensions');
  await runSqlFile('sql/extensions.sql');

  console.log('→ Running Drizzle migrations');
  const journal = await journalEntries();
  const before = await appliedStamps();

  await migrate(dbAdmin(), { migrationsFolder: join(packageRoot, 'migrations') });

  const after = await appliedStamps();
  const applied = journal.filter((e) => !before.has(String(e.when)) && after.has(String(e.when)));

  if (applied.length > 0) {
    for (const entry of applied) console.log(`  ✓ applied ${entry.tag}`);
    console.log(`  ✓ ${applied.length} migration(s) applied`);
  } else {
    console.log(`  ✓ no migrations to apply (${after.size} already applied)`);
  }

  /**
   * A pending migration that did not land is a failure, even though `migrate()`
   * did not throw.
   *
   * It is reachable: a file present on disk but absent from the journal is
   * skipped silently by drizzle, and that is precisely the state a bad merge
   * or a hand-edited journal produces. Reporting success there would put this
   * script back in the business of saying "up to date" when it is not.
   */
  const pending = journal.filter((e) => !after.has(String(e.when)));
  if (pending.length > 0) {
    throw new Error(
      `${pending.length} migration(s) still pending after migrate: ${pending
        .map((e) => e.tag)
        .join(', ')}`,
    );
  }

  console.log('→ Applying row-level security policies');
  await runSqlFile('sql/policies.sql');

  console.log(`✓ Database is up to date — ${target.label}`);
}

main()
  .catch((error) => {
    console.error('✗ Migration failed:', error);
    process.exitCode = 1;
  })
  .finally(() => closeConnections());
