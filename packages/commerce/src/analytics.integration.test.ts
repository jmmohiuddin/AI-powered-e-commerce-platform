import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@voltix/core';
import {
  failureReason,
  MAX_SEARCH_QUERY_LENGTH,
  normaliseSearchQuery,
  recordAnalyticsEvent,
  recordSearchQuery,
} from './analytics';
import {
  asTenant,
  closeTestPools,
  createFixture,
  databaseAvailable,
  ownerDb,
  type Fixture,
} from './test-support';

/**
 * THE FUNNEL WRITER.
 *
 * `analytics_events` shipped in the first migration and nothing ever wrote to
 * it, so these tests are less about the INSERT than about the two properties
 * that make the record trustworthy: that a row lands under the tenant that
 * caused it, and that no personal data rides along in the payload.
 *
 * The last test is the important one. Analytics is the only subsystem here that
 * is allowed to fail silently, and that permission is worth nothing unless it
 * is enforced somewhere a reviewer can see it.
 */

const available = await databaseAvailable();
const suite = available ? describe : describe.skip;

if (!available) {
  console.warn(
    '\n  ⚠ Postgres unreachable — analytics integration tests skipped.\n' +
      '    Run `npm run infra:up && npm run db:migrate` to enable them.\n',
  );
}

suite('analytics events', () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await createFixture('analytics');
  });

  afterAll(async () => {
    await ownerDb().execute(sql`DELETE FROM analytics_events WHERE tenant_id = ${fx.tenantId}`);
    await ownerDb().execute(sql`DELETE FROM search_queries WHERE tenant_id = ${fx.tenantId}`);
    await fx.cleanup();
    await closeTestPools();
  });

  it('writes an event under the acting tenant', async () => {
    await asTenant(fx.tenantId, (tx) =>
      recordAnalyticsEvent(tx, fx.ctx, {
        type: 'checkout_started',
        sessionId: 'sess-analytics-1',
        currency: 'AED',
      }),
    );

    const rows = await ownerDb().execute(sql`
      SELECT type, session_id, tenant_id, country_code, properties
      FROM analytics_events
      WHERE tenant_id = ${fx.tenantId} AND session_id = 'sess-analytics-1'
    `);

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      type: 'checkout_started',
      tenant_id: fx.tenantId,
      country_code: 'AE',
      properties: {},
    });
  });

  it('stores the emirate on a placed order, because L-03 cannot be backfilled', async () => {
    await asTenant(fx.tenantId, (tx) =>
      recordAnalyticsEvent(tx, fx.ctx, {
        type: 'order_placed',
        sessionId: 'sess-analytics-2',
        value: 419900,
        currency: 'AED',
        properties: { emirate: 'SH', paymentProvider: 'cod', orderNumber: '10001' },
      }),
    );

    const rows = await ownerDb().execute(sql`
      SELECT value, currency, properties
      FROM analytics_events
      WHERE tenant_id = ${fx.tenantId} AND session_id = 'sess-analytics-2'
    `);

    const row = rows.rows[0] as { value: string; currency: string; properties: Record<string, unknown> };
    // `value` is a bigint and comes back as a string from pg — minor units, so
    // an order of AED 4,199.00 is 419900 fils and never a float.
    expect(Number(row.value)).toBe(419900);
    expect(row.currency).toBe('AED');
    expect(row.properties.emirate).toBe('SH');
  });

  it('is invisible to another tenant', async () => {
    const other = await createFixture('analytics-other');
    try {
      const rows = await asTenant(other.tenantId, (tx) =>
        tx.execute(sql`SELECT id FROM analytics_events WHERE session_id = 'sess-analytics-1'`),
      );
      expect(rows.rows).toHaveLength(0);
    } finally {
      await other.cleanup();
    }
  });

  /**
   * The discovery events exist to be *counted per product*, and
   * `analytics_events_product_idx` is on `(product_id, type)` — so an id buried
   * in `properties` would make the only query anyone runs against these rows a
   * sequential scan of the largest table in the system.
   */
  it('puts the product and variant in their own columns, not in properties', async () => {
    const variantId = await fx.variant({ price: 129_900, onHand: 3 });
    const owned = await ownerDb().execute<{ product_id: string }>(
      sql`SELECT product_id FROM variants WHERE id = ${variantId}`,
    );
    const productId = owned.rows[0]!.product_id;

    await asTenant(fx.tenantId, (tx) =>
      recordAnalyticsEvent(tx, fx.ctx, {
        type: 'product_viewed',
        sessionId: 'sess-analytics-view',
        productId,
        variantId,
        properties: { brand: 'Samsung', inStock: true, locale: 'ar-AE' },
      }),
    );

    const rows = await ownerDb().execute<{
      product_id: string | null;
      variant_id: string | null;
      properties: Record<string, unknown>;
    }>(sql`
      SELECT product_id, variant_id, properties FROM analytics_events
      WHERE tenant_id = ${fx.tenantId} AND type = 'product_viewed'
    `);

    expect(rows.rows[0]).toMatchObject({ product_id: productId, variant_id: variantId });
    expect(rows.rows[0]!.properties).not.toHaveProperty('productId');
  });

  it('records what was typed in the search_query column', async () => {
    await asTenant(fx.tenantId, (tx) =>
      recordAnalyticsEvent(tx, fx.ctx, {
        type: 'search_performed',
        sessionId: 'sess-analytics-search',
        searchQuery: 'usb c cable',
        properties: { resultCount: 0, intent: 'navigational', strategy: 'lexical' },
      }),
    );

    const rows = await ownerDb().execute<{ search_query: string | null }>(sql`
      SELECT search_query FROM analytics_events
      WHERE tenant_id = ${fx.tenantId} AND type = 'search_performed'
    `);
    expect(rows.rows[0]!.search_query).toBe('usb c cable');
  });

  it('carries no personal data in the payload', async () => {
    const rows = await ownerDb().execute(sql`
      SELECT properties::text AS body FROM analytics_events WHERE tenant_id = ${fx.tenantId}
    `);

    // A phone number is the identity key on this storefront, so it is the thing
    // most likely to be added "just for debugging" and the thing that turns a
    // reporting table into a personal-data export.
    for (const row of rows.rows as Array<{ body: string }>) {
      expect(row.body).not.toMatch(/\+9715\d{8}/);
      expect(row.body).not.toMatch(/@/);
    }
  });
});

suite('search query log', () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await createFixture('searchlog');
  });

  afterAll(async () => {
    await ownerDb().execute(sql`DELETE FROM search_queries WHERE tenant_id = ${fx.tenantId}`);
    await fx.cleanup();
  });

  /**
   * The row this table exists for. A search that returned nothing is the only
   * demand signal in the system that arrives already written in the customer's
   * own words, and until now nothing wrote one down.
   */
  it('records a zero-result search with the outcome that makes it a report', async () => {
    await asTenant(fx.tenantId, (tx) =>
      recordSearchQuery(tx, fx.ctx, {
        sessionId: 'sess-search-1',
        query: '  Pixel   9 Pro  ',
        resultCount: 0,
        strategy: 'lexical',
        latencyMs: 42,
      }),
    );

    const rows = await ownerDb().execute<{
      query: string;
      normalised_query: string;
      result_count: number;
      strategy: string | null;
      latency_ms: number | null;
      clicked_product_id: string | null;
    }>(sql`
      SELECT query, normalised_query, result_count, strategy, latency_ms, clicked_product_id
      FROM search_queries WHERE tenant_id = ${fx.tenantId} AND session_id = 'sess-search-1'
    `);

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      // Verbatim, because a merchandiser reading the report wants what was
      // typed — spacing and capitals included.
      query: '  Pixel   9 Pro  ',
      normalised_query: 'pixel 9 pro',
      result_count: 0,
      strategy: 'lexical',
    });
    expect(Number(rows.rows[0]!.latency_ms)).toBe(42);
    // Left null on purpose: nothing here observes a click, and a zero value
    // would read as "nobody clicked" rather than "we did not look".
    expect(rows.rows[0]!.clicked_product_id).toBeNull();
  });

  /**
   * A first-time visitor has no cart cookie, and the page records the search
   * anyway with a null session. Dropping it would restrict the zero-result
   * report to people who had already started a basket — the shoppers least
   * likely to be the ones who could not find anything.
   */
  it('accepts a search from a browser with no session', async () => {
    await asTenant(fx.tenantId, (tx) =>
      recordSearchQuery(tx, fx.ctx, { sessionId: null, query: 'anker charger', resultCount: 4 }),
    );

    const rows = await ownerDb().execute<{ session_id: string | null; result_count: number }>(sql`
      SELECT session_id, result_count FROM search_queries
      WHERE tenant_id = ${fx.tenantId} AND query = 'anker charger'
    `);
    expect(rows.rows[0]!.session_id).toBeNull();
    expect(Number(rows.rows[0]!.result_count)).toBe(4);
  });

  /**
   * The query arrives in a URL and lands verbatim in an unbounded `text`
   * column, so without a ceiling this is a way to write kilobytes per request
   * into the store's highest-volume reporting table.
   */
  it('refuses a query too long to be a search', async () => {
    const absurd = 'a'.repeat(MAX_SEARCH_QUERY_LENGTH + 1);
    await asTenant(fx.tenantId, (tx) =>
      recordSearchQuery(tx, fx.ctx, { query: absurd, resultCount: 0 }),
    );

    const rows = await ownerDb().execute(sql`
      SELECT id FROM search_queries WHERE tenant_id = ${fx.tenantId} AND length(query) > 200
    `);
    expect(rows.rows).toHaveLength(0);
  });

  it('is invisible to another tenant', async () => {
    const other = await createFixture('searchlog-other');
    try {
      const rows = await asTenant(other.tenantId, (tx) =>
        tx.execute(sql`SELECT id FROM search_queries WHERE session_id = 'sess-search-1'`),
      );
      expect(rows.rows).toHaveLength(0);
    } finally {
      await other.cleanup();
    }
  });
});

/**
 * The grouping key behind the whole report.
 *
 * If two spellings of the same request land on different rows, the zero-result
 * list becomes a long tail of near-duplicates and nobody reads it — so these
 * assertions are about whether the report is usable, not about string tidiness.
 */
describe('normaliseSearchQuery', () => {
  it('folds casing and whitespace', () => {
    expect(normaliseSearchQuery('  iPhone   16  PRO ')).toBe('iphone 16 pro');
  });

  it('keeps internal punctuation, because a part number is not a phrase', () => {
    // SM-S928B and SMS928B are different orders from a distributor. Merging
    // them would hide a real gap in the catalogue behind a spelling rule.
    expect(normaliseSearchQuery('SM-S928B')).toBe('sm-s928b');
  });

  /**
   * Arabic is a first-class locale here, and it is where a lowercase-and-trim
   * normaliser fails hardest: one word, four legitimate spellings.
   */
  it('folds the Arabic spellings that mean the same word', () => {
    const withHarakat = 'سمَّاعات'; // سمّاعات, vowelled
    const plain = 'سماعات'; // سماعات
    expect(normaliseSearchQuery(withHarakat)).toBe(plain);

    // Alef with hamza, and alef-maqsura, both as typed by real keyboards.
    expect(normaliseSearchQuery('أيفون')).toBe('ايفون');
    expect(normaliseSearchQuery('شاشة')).toBe('شاشه');

    // Tatweel is decorative stretching with no phonetic value.
    expect(normaliseSearchQuery('كـــابل')).toBe(
      'كابل',
    );
  });

  it('reads Arabic-Indic digits as the numbers they are', () => {
    expect(normaliseSearchQuery('ايفون ١٦')).toBe(
      'ايفون 16',
    );
  });
});

describe('failureReason', () => {
  it('names the step, not just the code', () => {
    expect(failureReason(new DomainError('OUT_OF_STOCK', 'x'))).toEqual({
      reason: 'OUT_OF_STOCK',
      step: 'stock',
    });
    expect(failureReason(new DomainError('RISK_BLOCKED', 'x'))).toEqual({
      reason: 'RISK_BLOCKED',
      step: 'risk',
    });
    expect(failureReason(new DomainError('ADVANCE_REQUIRED', 'x'))).toEqual({
      reason: 'ADVANCE_REQUIRED',
      step: 'payment',
    });
  });

  it('degrades to UNKNOWN rather than throwing inside a failure handler', () => {
    // This runs in a catch block. An analytics helper that throws while
    // describing an error would replace a useful message with a stack trace.
    expect(failureReason(new Error('plain'))).toEqual({ reason: 'UNKNOWN', step: 'unknown' });
    expect(failureReason(undefined)).toEqual({ reason: 'UNKNOWN', step: 'unknown' });
    expect(failureReason(null)).toEqual({ reason: 'UNKNOWN', step: 'unknown' });
    expect(failureReason('a string')).toEqual({ reason: 'UNKNOWN', step: 'unknown' });
  });
});
