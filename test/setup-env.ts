import '@voltix/config/load-env';

/**
 * Vitest setup: load the repo `.env`, then redirect the database at a *test*
 * database before any client is constructed.
 *
 * Two separate problems this solves.
 *
 * **Loading `.env` at all.** Integration suites skip themselves when Postgres
 * is unreachable, which is right on a laptop with no containers — but it
 * becomes a silent lie if the only reason it is unreachable is that nobody told
 * the test process where the database lives. Without this the whole suite went
 * green having tested nothing.
 *
 * **Not letting them find the *production* database.** Once `.env` points at a
 * hosted Postgres, loading it is exactly how `createFixture` ends up creating
 * tenants in the live database and `cleanup` ends up deleting from it. That
 * happened: 21 abandoned test tenants accumulated in production because cleanup
 * only runs in `afterAll` and every timed-out run leaked one. It was also
 * unusably slow — a few hundred queries per test, each a cross-region round
 * trip.
 *
 * So the app's own connection strings are overwritten here with the test ones.
 * `packages/commerce/src/test-support.ts` reads the same variables directly;
 * this file covers the suites that go through `@voltix/db` instead, which reads
 * `DATABASE_URL` at import time.
 */

const TEST_APP_URL =
  process.env.DATABASE_TEST_URL ??
  'postgres://voltix_app:voltix_app_dev_password@localhost:5433/voltix';
const TEST_ADMIN_URL =
  process.env.DATABASE_TEST_ADMIN_URL ??
  'postgres://voltix:voltix_dev_password@localhost:5433/voltix';

process.env.DATABASE_URL = TEST_APP_URL;
process.env.DATABASE_ADMIN_URL = TEST_ADMIN_URL;
// A replica would be a third way to reach the wrong database.
delete process.env.DATABASE_REPLICA_URL;

export {};
