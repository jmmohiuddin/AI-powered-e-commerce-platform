'use server';

import { revalidatePath } from 'next/cache';
import { withTenant } from '@voltix/db';
import {
  addProductImage,
  listProductImages,
  removeProductImage,
  reorderProductImages,
  setProductImageAlt,
} from '@voltix/commerce';
import { prepareImage, resolveStorage } from '@voltix/media';
import { DomainError } from '@voltix/core';
import { actorFor, requirePermission, requestOrigin, tenantContextFor } from '../../lib/auth';
import type { ActionResult } from './actions';

/**
 * PRODUCT IMAGE ACTIONS
 *
 * Same three rules as the other product actions — permission checked server
 * side per action, tenant taken from the session rather than the form, every
 * mutation through the domain layer — plus one specific to files.
 *
 * **The bytes are validated here, before anything is stored.** A Server Action
 * is a POST endpoint that anyone holding a session can address directly, so
 * "the form only offers a file picker with an accept attribute" constrains
 * nothing. `prepareImage` decides what the file actually is by decoding it,
 * strips EXIF, and bounds the dimensions; only then does it reach storage.
 *
 * **Upload first, insert second.** Object storage is not transactional. If the
 * upload succeeds and the insert fails we have leaked an object, which costs a
 * fraction of a cent; the other order leaves a media row pointing at nothing,
 * which is a broken product page. The cheap failure is the one to choose.
 */

function toResult(error: unknown): ActionResult {
  if (error instanceof DomainError) {
    return { ok: false, error: error.publicMessage ?? error.message };
  }
  console.error('[product media action]', error);
  return { ok: false, error: 'Something went wrong. Nothing was saved.' };
}

/** Both screens that show images have to refresh, and so does the storefront tile. */
function revalidateProduct(slug: string): void {
  revalidatePath(`/products/${slug}`);
  revalidatePath(`/products/${slug}/edit`);
  revalidatePath('/products');
}

export async function uploadProductImagesAction(
  productId: string,
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const session = await requirePermission('product:write');
  const ctx = tenantContextFor(session);
  const actor = actorFor(session, await requestOrigin());

  const files = formData.getAll('images').filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) return { ok: false, error: 'Choose at least one image.' };

  const storage = resolveStorage();
  let added = 0;

  try {
    for (const file of files) {
      // Sequential rather than parallel: `prepareImage` is CPU-bound in sharp
      // and a merchant selecting twelve photographs at once would otherwise
      // occupy every thread in the pool and stall unrelated requests.
      const prepared = await prepareImage(new Uint8Array(await file.arrayBuffer()));
      const key = `products/${productId}/${crypto.randomUUID()}.${prepared.extension}`;
      const stored = await storage.put(key, prepared.body, prepared.contentType);

      await withTenant(session.tenantId, (tx) =>
        addProductImage(tx, ctx, actor, {
          productId,
          url: stored.url,
          width: prepared.width,
          height: prepared.height,
          blurDataUrl: prepared.blurDataUrl,
          // Left unset deliberately. A filename is not alt text, and
          // "IMG_4821.jpg" read aloud is worse than the product title the
          // storefront falls back to.
        }),
      );
      added += 1;
    }
  } catch (error) {
    const result = toResult(error);
    revalidateProduct(slug);
    // Partial success is reported as such: some images did upload, and telling
    // the merchant "nothing was saved" when four of six landed sends them
    // straight into creating duplicates.
    return added > 0
      ? { ok: false, error: `${added} image${added === 1 ? '' : 's'} uploaded, then: ${result.error}` }
      : result;
  }

  revalidateProduct(slug);
  return { ok: true, message: `Uploaded ${added} image${added === 1 ? '' : 's'}.` };
}

export async function setImageAltAction(
  mediaId: string,
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const session = await requirePermission('product:write');
  const ctx = tenantContextFor(session);
  const actor = actorFor(session, await requestOrigin());

  try {
    await withTenant(session.tenantId, (tx) =>
      setProductImageAlt(tx, ctx, actor, mediaId, String(formData.get('altText') ?? '')),
    );
  } catch (error) {
    return toResult(error);
  }

  revalidateProduct(slug);
  return { ok: true, message: 'Description saved.' };
}

export async function reorderImagesAction(
  productId: string,
  slug: string,
  orderedIds: string[],
): Promise<ActionResult> {
  const session = await requirePermission('product:write');
  const ctx = tenantContextFor(session);
  const actor = actorFor(session, await requestOrigin());

  try {
    await withTenant(session.tenantId, (tx) =>
      reorderProductImages(tx, ctx, actor, productId, orderedIds),
    );
  } catch (error) {
    return toResult(error);
  }

  revalidateProduct(slug);
  return { ok: true, message: 'Order saved.' };
}

export async function deleteImageAction(mediaId: string, slug: string): Promise<ActionResult> {
  const session = await requirePermission('product:write');
  const ctx = tenantContextFor(session);
  const actor = actorFor(session, await requestOrigin());

  let removedUrl: string;
  try {
    const removed = await withTenant(session.tenantId, (tx) =>
      removeProductImage(tx, ctx, actor, mediaId),
    );
    removedUrl = removed.url;
  } catch (error) {
    return toResult(error);
  }

  /**
   * The object is deleted only after the row is gone and committed, and a
   * failure here is swallowed on purpose: the merchant's intent — "this image
   * is no longer on my product" — has already been satisfied. An orphaned
   * object costs storage; an error message after a successful delete costs
   * trust in the button.
   */
  try {
    const storage = resolveStorage();
    const key = storage.keyFor(removedUrl);
    if (key) await storage.remove(key);
  } catch (error) {
    console.error('[product media action] orphaned object', removedUrl, error);
  }

  revalidateProduct(slug);
  return { ok: true, message: 'Image removed.' };
}

/** The current images for a product, for the management UI. */
export async function productImages(productId: string) {
  const session = await requirePermission('product:read');
  const ctx = tenantContextFor(session);
  return withTenant(session.tenantId, (tx) => listProductImages(tx, ctx, productId));
}
