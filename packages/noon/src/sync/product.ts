/**
 * CATALOGUE PUSH — Voltix products → noon listings.
 *
 * This is the expensive, slow, and least reversible half of the integration,
 * and it is treated differently from stock and price accordingly.
 *
 * WHY CONTENT IS VALIDATED BEFORE IT IS SENT
 * ------------------------------------------
 * noon's mandatory attributes are per category and change without notice. A
 * product missing one is not rejected loudly — it is accepted into review and
 * then quietly never goes live, which looks identical to "noon is slow today"
 * for as long as nobody checks. Fetching the category schema and checking the
 * payload against it converts that into an error at the point of the mistake,
 * with the attribute name in it.
 *
 * WHY AN UNCHANGED PRODUCT IS NEVER RE-SENT
 * -----------------------------------------
 * A content upsert on a live listing can send it back into review, during
 * which it stops accepting stock and price updates. Re-submitting the whole
 * catalogue on a schedule would therefore take the entire shop offline on
 * noon periodically. The content hash makes the sweep a no-op unless a human
 * actually changed something.
 */

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { CategoryAttribute, NoonClient, ProductUpsertRequest } from '../client.js';
import type { SyncOutcome, Tx } from './types.js';
import { emptyOutcome } from './types.js';

export class AttributeValidationError extends Error {
  constructor(
    readonly categoryCode: string,
    readonly problems: string[],
  ) {
    super(
      `[@voltix/noon] Product rejected before sending — category ${categoryCode}: ` +
        problems.join('; '),
    );
    this.name = 'AttributeValidationError';
  }
}

/**
 * Checks a payload against noon's schema for its category.
 *
 * Only the checks noon actually enforces are implemented: presence of
 * mandatory attributes, membership of a SELECT's allowed options, and numeric
 * bounds. Length and regex rules are reported rather than silently trimmed,
 * because truncating a product title to fit is a decision for a merchandiser.
 */
export function validateAttributes(
  categoryCode: string,
  attributes: Record<string, unknown>,
  schema: readonly CategoryAttribute[],
): void {
  const problems: string[] = [];

  for (const attribute of schema) {
    const value = attributes[attribute.attribute_code];
    const missing = value === undefined || value === null || value === '';

    if (attribute.is_mandatory && missing) {
      problems.push(`missing mandatory attribute "${attribute.attribute_code}"`);
      continue;
    }
    if (missing) continue;

    if (attribute.attribute_type === 'ATTRIBUTE_TYPE_SELECT' && attribute.attribute_options.length > 0) {
      const values = Array.isArray(value) ? value : [value];
      for (const candidate of values) {
        if (!attribute.attribute_options.includes(String(candidate))) {
          problems.push(
            `"${attribute.attribute_code}" = "${String(candidate)}" is not one of ` +
              `${attribute.attribute_options.slice(0, 8).join(', ')}` +
              (attribute.attribute_options.length > 8 ? ', …' : ''),
          );
        }
      }
    }

    if (attribute.attribute_type === 'ATTRIBUTE_TYPE_NUMERIC') {
      const numeric = Number(value);
      if (Number.isNaN(numeric)) {
        problems.push(`"${attribute.attribute_code}" must be numeric, got "${String(value)}"`);
      } else {
        if (attribute.number_min != null && numeric < attribute.number_min) {
          problems.push(`"${attribute.attribute_code}" is below the minimum ${attribute.number_min}`);
        }
        if (attribute.number_max != null && numeric > attribute.number_max) {
          problems.push(`"${attribute.attribute_code}" is above the maximum ${attribute.number_max}`);
        }
      }
    }

    if (!attribute.is_multivalued && Array.isArray(value) && value.length > 1) {
      problems.push(`"${attribute.attribute_code}" accepts a single value`);
    }

    if (attribute.attribute_type === 'ATTRIBUTE_TYPE_TEXT' && typeof value === 'string') {
      if (attribute.max_characters != null && value.length > attribute.max_characters) {
        problems.push(
          `"${attribute.attribute_code}" is ${value.length} characters; the maximum is ${attribute.max_characters}`,
        );
      }
      if (attribute.min_characters != null && value.length < attribute.min_characters) {
        problems.push(
          `"${attribute.attribute_code}" is ${value.length} characters; the minimum is ${attribute.min_characters}`,
        );
      }
    }
  }

  if (problems.length > 0) throw new AttributeValidationError(categoryCode, problems);
}

/**
 * Caches category schemas for the life of the process.
 *
 * A full catalogue sweep asks for the same handful of categories thousands of
 * times. These change on noon's release schedule, not ours, so a process-
 * lifetime cache is the right staleness trade — the worker restarts daily.
 */
export class CategorySchemaCache {
  private readonly cache = new Map<string, Promise<CategoryAttribute[]>>();

  constructor(private readonly client: NoonClient) {}

  get(categoryCode: string): Promise<CategoryAttribute[]> {
    let entry = this.cache.get(categoryCode);
    if (!entry) {
      // A failed lookup must not be cached, or one blip poisons the sweep.
      entry = this.client.listCategoryAttributes(categoryCode).catch((error: unknown) => {
        this.cache.delete(categoryCode);
        throw error;
      });
      this.cache.set(categoryCode, entry);
    }
    return entry;
  }
}

/**
 * A stable fingerprint of everything noon would store about a product.
 *
 * Key order is normalised because `JSON.stringify` preserves insertion order,
 * and a row read back in a different column order would otherwise look like a
 * content change and trigger a pointless re-submission into review.
 */
export function contentHash(request: ProductUpsertRequest): string {
  return createHash('sha256').update(stableStringify(request)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);

  return `{${entries.join(',')}}`;
}

export interface ProductPushInput {
  /** Voltix variant ids covered by this request, in `skus[]` order. */
  readonly variantIds: readonly string[];
  readonly request: ProductUpsertRequest;
}

/**
 * Submits one product (all its variants) to noon.
 *
 * Returns `skipped` when the hash matches what noon already accepted. On
 * success the listings move to `pending_approval`: they are not sellable yet,
 * and the stock/price sync deliberately ignores them until noon approves.
 */
export async function pushProduct(
  tx: Tx,
  client: NoonClient,
  schemas: CategorySchemaCache,
  tenantId: string,
  input: ProductPushInput,
): Promise<SyncOutcome> {
  const hash = contentHash(input.request);

  const existing = await tx.execute<{ pushed_content_hash: string | null }>(sql`
    SELECT pushed_content_hash
      FROM noon_listings
     WHERE tenant_id = ${tenantId}
       AND variant_id = ANY(${[...input.variantIds]}::uuid[])
  `);

  const allMatch =
    existing.rows.length === input.variantIds.length &&
    existing.rows.every((row) => row.pushed_content_hash === hash);

  if (allMatch) return { ...emptyOutcome(), skipped: input.variantIds.length };

  validateAttributes(
    input.request.category,
    input.request.attributes,
    await schemas.get(input.request.category),
  );

  const response = await client.upsertProduct(input.request);

  // noon returns one variant row per partner SKU, carrying the identifiers
  // that every later call needs. Matching on partner_sku rather than position
  // because nothing documents that the response preserves request order.
  const byPartnerSku = new Map(response.variants.map((variant) => [variant.partner_sku, variant]));

  for (const variantId of input.variantIds) {
    const row = await tx.execute<{ partner_sku: string }>(sql`
      SELECT partner_sku FROM noon_listings
       WHERE tenant_id = ${tenantId} AND variant_id = ${variantId}
    `);
    const partnerSku = row.rows[0]?.partner_sku;
    if (!partnerSku) continue;

    const returned = byPartnerSku.get(partnerSku);

    await tx.execute(sql`
      UPDATE noon_listings
         SET sku_parent = ${response.sku_parent},
             nsku = ${returned?.sku ?? null},
             psku_code = ${returned?.psku_code ?? null},
             pushed_content_hash = ${hash},
             pushed_content_at = now(),
             status = 'pending_approval',
             consecutive_failures = 0,
             last_error = NULL,
             updated_at = now()
       WHERE tenant_id = ${tenantId} AND variant_id = ${variantId}
    `);
  }

  return { ...emptyOutcome(), accepted: input.variantIds.length };
}
