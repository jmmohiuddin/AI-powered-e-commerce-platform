import { sql } from 'drizzle-orm';
import { uuidv7 } from '@voltix/db';
import { DomainError } from '@voltix/core';
import type { ActorContext, TenantContext, Tx } from './types';

/**
 * PRODUCT MEDIA
 *
 * The write side of product photography. Until this existed the `media` table
 * was only ever populated by the seed script, which is why the storefront had
 * nothing to render and drew a generated gradient instead.
 *
 * Three rules, for the same reason the catalogue module has three:
 *
 * 1. **Position is dense and starts at zero.** It decides which photograph is
 *    the tile image and the Open Graph preview, so it is not decoration. Every
 *    mutation renumbers the whole set rather than leaving gaps, because gaps
 *    make "move this one to the front" a query about the *other* rows.
 *
 * 2. **The bytes are not this module's problem.** Uploading to object storage
 *    and writing the row are separate steps on purpose: storage is not
 *    transactional and the database is. The order is upload-then-insert, so a
 *    failure leaves an orphaned object — wasted bytes — rather than a media row
 *    pointing at nothing, which is a broken product page.
 *
 * 3. **Deleting returns the URL.** The caller needs it to remove the object
 *    afterwards. Doing that here would mean an un-rollbackable side effect
 *    inside a transaction: if the surrounding transaction then aborted, the row
 *    would come back and its bytes would not.
 */

/**
 * Beyond this many, a merchant is uploading a catalogue rather than a product,
 * and every one of them is fetched by the PDP.
 */
export const MAX_IMAGES_PER_PRODUCT = 12;

const MAX_ALT_LENGTH = 300;

export interface ProductImageInput {
  readonly productId: string;
  readonly url: string;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly blurDataUrl?: string | undefined;
  readonly altText?: string | undefined;
}

export interface ProductImageRow {
  readonly id: string;
  readonly url: string;
  readonly altText: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly position: number;
}

function normaliseAlt(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_ALT_LENGTH) {
    throw new DomainError('VALIDATION_FAILED', 'Alt text too long', {
      publicMessage: `Describe the image in ${MAX_ALT_LENGTH} characters or fewer.`,
    });
  }
  return trimmed;
}

/** Locks the product row, so two concurrent uploads cannot claim one position. */
async function lockProduct(tx: Tx, ctx: TenantContext, productId: string): Promise<void> {
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT id FROM products
    WHERE tenant_id = ${ctx.tenantId} AND id = ${productId} AND deleted_at IS NULL
    FOR UPDATE
  `);
  if (!rows.rows[0]) throw new DomainError('NOT_FOUND', `Product ${productId} not found`);
}

export async function listProductImages(
  tx: Tx,
  ctx: TenantContext,
  productId: string,
): Promise<ProductImageRow[]> {
  const rows = await tx.execute<{
    id: string;
    url: string;
    alt_text: string | null;
    width: number | null;
    height: number | null;
    position: number;
  }>(sql`
    SELECT id, url, alt_text, width, height, position FROM media
    WHERE tenant_id = ${ctx.tenantId} AND product_id = ${productId} AND kind = 'image'
    ORDER BY position, created_at
  `);

  return rows.rows.map((r) => ({
    id: r.id,
    url: r.url,
    altText: r.alt_text,
    width: r.width,
    height: r.height,
    position: Number(r.position),
  }));
}

/**
 * Appends an image to a product, at the end of the existing order.
 *
 * Appending rather than prepending: the first photograph a merchant uploads is
 * almost always the one they want as the tile image, and silently demoting it
 * when they add a detail shot is a surprise they have to undo.
 */
export async function addProductImage(
  tx: Tx,
  ctx: TenantContext,
  _actor: ActorContext,
  input: ProductImageInput,
): Promise<ProductImageRow> {
  await lockProduct(tx, ctx, input.productId);

  const url = input.url.trim();
  if (!url) {
    throw new DomainError('VALIDATION_FAILED', 'Image URL is required', {
      publicMessage: 'The upload did not produce a file. Try again.',
    });
  }

  const counts = await tx.execute<{ n: number; next: number }>(sql`
    SELECT count(*)::int AS n, coalesce(max(position) + 1, 0)::int AS next FROM media
    WHERE tenant_id = ${ctx.tenantId} AND product_id = ${input.productId} AND kind = 'image'
  `);
  const count = Number(counts.rows[0]?.n ?? 0);
  if (count >= MAX_IMAGES_PER_PRODUCT) {
    throw new DomainError('VALIDATION_FAILED', `Image limit reached for ${input.productId}`, {
      publicMessage: `A product can have ${MAX_IMAGES_PER_PRODUCT} images. Remove one before adding another.`,
    });
  }

  const id = uuidv7();
  const position = Number(counts.rows[0]?.next ?? 0);
  const altText = normaliseAlt(input.altText);

  await tx.execute(sql`
    INSERT INTO media
      (id, tenant_id, product_id, kind, url, width, height, blur_data_url, alt_text,
       position, created_at, updated_at)
    VALUES (${id}, ${ctx.tenantId}, ${input.productId}, 'image', ${url},
            ${input.width ?? null}, ${input.height ?? null}, ${input.blurDataUrl ?? null},
            ${altText}, ${position}, now(), now())
  `);

  return {
    id,
    url,
    altText,
    width: input.width ?? null,
    height: input.height ?? null,
    position,
  };
}

/**
 * Sets an image's alt text.
 *
 * Its own operation rather than part of a general update, because it is the
 * only field a merchant edits after upload and because an empty value is
 * meaningful: it clears the override and the storefront falls back to the
 * localised product title.
 */
export async function setProductImageAlt(
  tx: Tx,
  ctx: TenantContext,
  _actor: ActorContext,
  mediaId: string,
  altText: string | undefined,
): Promise<void> {
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT id FROM media WHERE tenant_id = ${ctx.tenantId} AND id = ${mediaId} FOR UPDATE
  `);
  if (!rows.rows[0]) throw new DomainError('NOT_FOUND', `Media ${mediaId} not found`);

  await tx.execute(sql`
    UPDATE media SET alt_text = ${normaliseAlt(altText)}, updated_at = now()
    WHERE tenant_id = ${ctx.tenantId} AND id = ${mediaId}
  `);
}

/**
 * Rewrites the display order.
 *
 * Takes the complete list rather than a move instruction. A "move image 4 to
 * position 1" API has to define what happens when the client's idea of the
 * order is stale, and the answer is always wrong for somebody; sending the
 * whole order makes the request idempotent and the conflict visible.
 */
export async function reorderProductImages(
  tx: Tx,
  ctx: TenantContext,
  _actor: ActorContext,
  productId: string,
  orderedIds: readonly string[],
): Promise<void> {
  await lockProduct(tx, ctx, productId);

  const existing = await listProductImages(tx, ctx, productId);
  const known = new Set(existing.map((image) => image.id));

  if (orderedIds.length !== known.size || orderedIds.some((id) => !known.has(id))) {
    // Refuse rather than reorder a subset: applying a stale order would silently
    // drop whichever image was uploaded in another tab a second ago to the end.
    throw new DomainError('CONFLICT', 'Reorder does not match the stored images', {
      publicMessage: 'The images changed while you were reordering them. Refresh and try again.',
    });
  }

  for (const [position, id] of orderedIds.entries()) {
    await tx.execute(sql`
      UPDATE media SET position = ${position}, updated_at = now()
      WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
    `);
  }
}

/**
 * Removes an image and closes the gap its position left.
 *
 * Returns the URL so the caller can delete the stored object once the
 * transaction it is running in has actually committed.
 */
export async function removeProductImage(
  tx: Tx,
  ctx: TenantContext,
  _actor: ActorContext,
  mediaId: string,
): Promise<{ url: string; productId: string }> {
  const rows = await tx.execute<{ url: string; product_id: string | null }>(sql`
    SELECT url, product_id FROM media
    WHERE tenant_id = ${ctx.tenantId} AND id = ${mediaId}
    FOR UPDATE
  `);
  const row = rows.rows[0];
  if (!row || !row.product_id) throw new DomainError('NOT_FOUND', `Media ${mediaId} not found`);

  await tx.execute(sql`
    DELETE FROM media WHERE tenant_id = ${ctx.tenantId} AND id = ${mediaId}
  `);

  // Renumber densely so positions stay 0..n-1. Leaving a hole works for
  // ordering but makes every later "insert at position k" reason about gaps.
  const remaining = await listProductImages(tx, ctx, row.product_id);
  for (const [position, image] of remaining.entries()) {
    if (image.position !== position) {
      await tx.execute(sql`
        UPDATE media SET position = ${position}, updated_at = now()
        WHERE tenant_id = ${ctx.tenantId} AND id = ${image.id}
      `);
    }
  }

  return { url: row.url, productId: row.product_id };
}
