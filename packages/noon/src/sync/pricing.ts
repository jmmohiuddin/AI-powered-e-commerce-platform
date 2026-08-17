/**
 * PRICE PUSH — Voltix variant prices → noon.
 *
 * UNITS ARE THE WHOLE RISK HERE
 * -----------------------------
 * Voltix stores an integer count of minor units. noon's pricing API takes a
 * floating-point number of *major* units. Every price that crosses this
 * boundary is one missing division away from being 100× wrong, and noon will
 * accept it: there is no sanity check on their side that a phone costs
 * 129,950 dirhams rather than 1,299.50.
 *
 * `toMajorUnits` is the only conversion, it takes the currency's exponent
 * explicitly, and `guardPrice` refuses to send anything that looks like a
 * unit error. That guard has caught nothing in production and is still worth
 * its lines, because the failure it prevents is unrecoverable in the direction
 * that matters — a listing priced at 1/100th sells out before anyone notices.
 *
 * PER COUNTRY, NOT PER LISTING
 * ----------------------------
 * noon prices a partner SKU per marketplace country. One local price fans out
 * to one upsert per country the merchant sells into, which is read from the
 * warehouse map rather than assumed to be `ae`.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '@voltix/db';
import { minorUnitExponent } from '@voltix/core';
import type { NoonClient, PricingUpsertItem } from '../client.js';
import { chunk, toMajorUnits } from './batch.js';
import { emptyOutcome, mergeOutcomes, type SyncOutcome, type Tx } from './types.js';

export interface DesiredPrice {
  readonly listingId: string;
  readonly partnerSku: string;
  readonly countryCode: string;
  /** Minor units. */
  readonly price: number;
  /** Minor units. Null when there is no struck-through reference price. */
  readonly msrp: number | null;
  readonly currency: string;
  readonly pushedPrice: number | null;
  readonly pushedMsrp: number | null;
}

/**
 * A price this module refuses to send.
 *
 * These are not business rules about what a product may cost — they are
 * tripwires for an arithmetic bug, and they are two rules rather than one
 * because a single absolute ceiling does not catch the error that actually
 * happens.
 *
 * ABSOLUTE. Below AED 0.50 or above AED 100,000 is not a price this merchant
 * charges for a phone or a laptop. It catches a sign flip, a zeroed row, and
 * a 100× slip on anything already costing more than AED 1,000.
 *
 * RELATIVE. The absolute rule alone misses the common case: an AED 49
 * accessory sent as 4,900 is still "plausible" in isolation. So a price that
 * has been published before must not jump by more than 20× in either
 * direction without a human involved. Real repricing — clearances, launch
 * discounts, supplier changes — stays far inside that; a units error never
 * does, because it is always off by exactly 100 or 1,000.
 *
 * The relative rule is skipped for a listing that has never been priced,
 * because there is nothing to compare against. That is the one gap, and it is
 * bounded by the absolute rule.
 */
export class ImplausiblePriceError extends Error {
  constructor(partnerSku: string, detail: string) {
    super(`[@voltix/noon] Refusing to publish ${partnerSku}: ${detail}`);
    this.name = 'ImplausiblePriceError';
  }
}

const MIN_MAJOR = 0.5;
const MAX_MAJOR = 100_000;
const MAX_FOLD_CHANGE = 20;

export function guardPrice(
  partnerSku: string,
  major: number,
  currency: string,
  previousMajor?: number | null,
): number {
  if (!Number.isFinite(major) || major < MIN_MAJOR || major > MAX_MAJOR) {
    throw new ImplausiblePriceError(
      partnerSku,
      `${major} ${currency} is outside the plausible range ` +
        `(${MIN_MAJOR}–${MAX_MAJOR}). This is almost certainly a minor/major unit error.`,
    );
  }

  if (previousMajor != null && previousMajor >= MIN_MAJOR) {
    const fold = major > previousMajor ? major / previousMajor : previousMajor / major;
    if (fold > MAX_FOLD_CHANGE) {
      throw new ImplausiblePriceError(
        partnerSku,
        `${major} ${currency} is a ${fold.toFixed(0)}× change from the last published ` +
          `${previousMajor} ${currency}. Set noon_listings.sync_enabled = false, publish ` +
          `the new price by hand, then re-enable, if this is genuinely intended.`,
      );
    }
  }

  return major;
}

export async function readDesiredPrices(
  tx: Tx,
  tenantId: string,
  variantIds?: readonly string[],
): Promise<DesiredPrice[]> {
  const result = await tx.execute<{
    listing_id: string;
    partner_sku: string;
    country_code: string;
    price: number;
    msrp: number | null;
    currency: string;
    pushed_price: number | null;
    pushed_msrp: number | null;
  }>(sql`
    SELECT DISTINCT
      l.id                  AS listing_id,
      l.partner_sku         AS partner_sku,
      w.country_code        AS country_code,
      v.price               AS price,
      v.compare_at_price    AS msrp,
      v.currency            AS currency,
      l.pushed_price        AS pushed_price,
      l.pushed_msrp         AS pushed_msrp
    FROM noon_listings l
    JOIN variants v
      ON v.id = l.variant_id
     AND v.tenant_id = l.tenant_id
     AND v.deleted_at IS NULL
    JOIN noon_warehouse_map w
      ON w.tenant_id = l.tenant_id
     AND w.is_active
    WHERE l.tenant_id = ${tenantId}
      AND l.status = 'live'
      AND l.sync_enabled
      AND l.consecutive_failures < 10
      AND v.is_active
      ${variantIds && variantIds.length > 0 ? sql`AND l.variant_id = ANY(${variantIds}::uuid[])` : sql``}
  `);

  return result.rows.map((row) => ({
    listingId: row.listing_id,
    partnerSku: row.partner_sku,
    countryCode: row.country_code,
    price: Number(row.price),
    msrp: row.msrp === null ? null : Number(row.msrp),
    currency: row.currency,
    pushedPrice: row.pushed_price === null ? null : Number(row.pushed_price),
    pushedMsrp: row.pushed_msrp === null ? null : Number(row.pushed_msrp),
  }));
}

export function selectChangedPrices(desired: readonly DesiredPrice[]): DesiredPrice[] {
  return desired.filter(
    (row) => row.pushedPrice !== row.price || row.pushedMsrp !== row.msrp,
  );
}

/**
 * Builds the wire item for one desired price.
 *
 * noon treats `msrp` below `price` as invalid, and Voltix's own rule is that a
 * compare-at price which is not above the price is simply not shown. Rather
 * than send a value noon will reject, an inconsistent MSRP is dropped — the
 * listing still gets the correct price, which is the part that matters.
 */
export function toPricingItem(row: DesiredPrice): PricingUpsertItem {
  const exponent = minorUnitExponent(row.currency);
  const price = guardPrice(
    row.partnerSku,
    toMajorUnits(row.price, exponent),
    row.currency,
    row.pushedPrice === null ? null : toMajorUnits(row.pushedPrice, exponent),
  );

  const msrpMajor = row.msrp === null ? null : toMajorUnits(row.msrp, exponent);
  const msrp = msrpMajor !== null && msrpMajor > price ? msrpMajor : null;

  return {
    partner_sku: row.partnerSku,
    country_code: row.countryCode,
    price,
    msrp,
    is_active: true,
  };
}

/**
 * Pushes prices for one tenant.
 *
 * Same transaction shape as `pushStock`: read in a transaction, call noon
 * outside one, record in another. See the note there for why.
 */
export async function pushPrices(
  db: Database,
  client: NoonClient,
  tenantId: string,
  options: { variantIds?: readonly string[] } = {},
): Promise<SyncOutcome> {
  const desired = await db.transaction((tx) => readDesiredPrices(tx, tenantId, options.variantIds));
  const changed = selectChangedPrices(desired);

  let outcome: SyncOutcome = { ...emptyOutcome(), skipped: desired.length - changed.length };

  for (const batch of chunk(changed)) {
    outcome = mergeOutcomes(outcome, await pushPriceBatch(db, client, tenantId, batch));
  }

  return outcome;
}

async function pushPriceBatch(
  db: Database,
  client: NoonClient,
  tenantId: string,
  batch: DesiredPrice[],
): Promise<SyncOutcome> {
  const result = await client.upsertPricing(batch.map(toPricingItem));
  const byKey = new Map(batch.map((row) => [`${row.countryCode}/${row.partnerSku}`, row]));

  await db.transaction(async (tx) => {
    for (const item of result.accepted) {
      const row = byKey.get(item.key);
      if (!row) continue;
      await tx.execute(sql`
        UPDATE noon_listings
           SET pushed_price = ${row.price},
               pushed_msrp = ${row.msrp},
               pushed_price_currency = ${row.currency},
               pushed_price_at = now(),
               consecutive_failures = 0,
               last_error = NULL,
               updated_at = now()
         WHERE id = ${row.listingId} AND tenant_id = ${tenantId}
      `);
    }

    for (const item of result.rejected) {
      const row = byKey.get(item.key);
      if (!row) continue;
      await tx.execute(sql`
        UPDATE noon_listings
           SET last_error = ${item.message || item.statusCode},
               last_error_at = now(),
               consecutive_failures = consecutive_failures + 1,
               updated_at = now()
         WHERE id = ${row.listingId} AND tenant_id = ${tenantId}
      `);
    }
  });

  return {
    skipped: 0,
    accepted: result.accepted.length,
    rejected: result.rejected.map((item) => ({ key: item.key, reason: item.message })),
    failedBatches: 0,
  };
}
