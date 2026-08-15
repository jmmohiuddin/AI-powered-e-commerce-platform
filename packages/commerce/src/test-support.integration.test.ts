import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { closeTestPools, createFixture, databaseAvailable, ownerDb } from './test-support';

/**
 * A REGRESSION GUARD ON THE TEST HARNESS ITSELF.
 *
 * Worth its runtime because the bug it covers cost more than the tests it
 * supports. `createFixture` built its tenant slug from `tenantId.slice(0, 8)`,
 * and on a UUIDv7 those characters are the top 32 bits of a millisecond
 * timestamp — they change roughly once a minute. Two fixtures with the same
 * label inside that window collided on `tenants_slug_key`.
 *
 * It never failed the same way twice, so it read as concurrent suites treading
 * on each other and was dismissed as exactly that, more than once, by more than
 * one person. An intermittent failure in shared infrastructure does not stay
 * contained: it teaches everyone to re-run a red suite instead of reading it.
 */

const available = await databaseAvailable();
const suite = available ? describe : describe.skip;

if (!available) {
  console.warn('\n  ⚠ Postgres unreachable — test-support integration tests skipped.\n');
}

suite('createFixture', () => {
  it('gives two same-label fixtures distinct slugs', async () => {
    // Back to back, deliberately: sequential creation inside one millisecond
    // window is precisely the case the old suffix could not distinguish.
    const a = await createFixture('collision');
    const b = await createFixture('collision');

    try {
      expect(a.tenantId).not.toBe(b.tenantId);

      const rows = await ownerDb().execute<{ slug: string }>(sql`
        SELECT slug FROM tenants WHERE id IN (${a.tenantId}, ${b.tenantId})
      `);

      const slugs = rows.rows.map((r) => r.slug);
      expect(slugs).toHaveLength(2);
      expect(new Set(slugs).size).toBe(2);
    } finally {
      await a.cleanup();
      await b.cleanup();
      await closeTestPools();
    }
  });
});
