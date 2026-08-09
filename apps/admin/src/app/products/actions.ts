'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { withTenant } from '@voltix/db';
import { adjustStock, createProduct, setProductStatus, updateProduct } from '@voltix/commerce';
import { DomainError } from '@voltix/core';
import { actorFor, requestOrigin, requirePermission, tenantContextFor } from '../../lib/auth';

/**
 * PRODUCT ACTIONS
 *
 * Same three rules as the order actions: permission is checked server-side per
 * action (hiding a button is not enforcing anything — a Server Action is a POST
 * endpoint addressable by its own id), the tenant comes from the session rather
 * than the form, and every mutation goes through the domain layer so a rule
 * cannot be bypassed by calling from a different screen.
 */

export interface ActionResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly message?: string;
}

/**
 * Parses a price typed by a human into integer minor units.
 *
 * The form shows AED because that is what a merchant thinks in; the domain
 * stores fils because floats cannot hold money. This is the only place that
 * conversion happens, and it rounds rather than truncating so 49.995 does not
 * silently become 49.99.
 */
function toMinorUnits(raw: FormDataEntryValue | null, field: string): number | undefined {
  const text = String(raw ?? '').trim();
  if (!text) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) {
    throw new DomainError('VALIDATION_FAILED', `${field} invalid`, {
      publicMessage: `${field} must be a number, like 49.90`,
    });
  }
  return Math.round(value * 100);
}

function toResult(error: unknown): ActionResult {
  if (error instanceof DomainError) {
    return { ok: false, error: error.publicMessage ?? error.message };
  }
  console.error('[product action]', error);
  return { ok: false, error: 'Something went wrong. Nothing was saved.' };
}

export async function createProductAction(formData: FormData): Promise<ActionResult> {
  const session = await requirePermission('product:write');
  const ctx = tenantContextFor(session);
  const actor = actorFor(session, await requestOrigin());

  let slug: string;
  try {
    const price = toMinorUnits(formData.get('price'), 'Price');
    const cost = toMinorUnits(formData.get('costPrice'), 'Cost');
    const onHandRaw = String(formData.get('onHand') ?? '').trim();
    const warrantyRaw = String(formData.get('warrantyMonths') ?? '').trim();

    const created = await withTenant(session.tenantId, (tx) =>
      createProduct(
        tx,
        ctx,
        actor,
        {
          title: String(formData.get('title') ?? ''),
          subtitle: String(formData.get('subtitle') ?? '') || undefined,
          description: String(formData.get('description') ?? '') || undefined,
          brandId: String(formData.get('brandId') ?? '') || undefined,
          categoryId: String(formData.get('categoryId') ?? '') || undefined,
          condition: String(formData.get('condition') ?? 'new'),
          warrantyMonths: warrantyRaw ? Number(warrantyRaw) : undefined,
        },
        {
          sku: String(formData.get('sku') ?? ''),
          title: String(formData.get('variantTitle') ?? '') || 'Default',
          // -1 rather than a local throw: the domain owns the message, so the
          // form and an API get the same wording for the same mistake.
          price: price ?? -1,
          costPrice: cost,
          onHand: onHandRaw ? Number(onHandRaw) : 0,
        },
      ),
    );
    slug = created.slug;
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/products');
  // Outside the try/catch: redirect() signals by throwing, so catching around
  // it swallows the navigation and leaves the merchant on a form that appeared
  // to do nothing.
  redirect(`/products/${slug}`);
}

export async function updateProductAction(
  productId: string,
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const session = await requirePermission('product:write');
  const ctx = tenantContextFor(session);
  const actor = actorFor(session, await requestOrigin());

  try {
    const warrantyRaw = String(formData.get('warrantyMonths') ?? '').trim();
    await withTenant(session.tenantId, (tx) =>
      updateProduct(tx, ctx, actor, productId, {
        title: String(formData.get('title') ?? ''),
        subtitle: String(formData.get('subtitle') ?? '') || undefined,
        description: String(formData.get('description') ?? '') || undefined,
        brandId: String(formData.get('brandId') ?? '') || undefined,
        categoryId: String(formData.get('categoryId') ?? '') || undefined,
        condition: String(formData.get('condition') ?? 'new'),
        warrantyMonths: warrantyRaw ? Number(warrantyRaw) : undefined,
      }),
    );
  } catch (error) {
    return toResult(error);
  }

  revalidatePath(`/products/${slug}`);
  revalidatePath('/products');
  return { ok: true, message: 'Saved.' };
}

export async function setStatusAction(
  productId: string,
  slug: string,
  status: 'draft' | 'active' | 'archived',
): Promise<ActionResult> {
  const session = await requirePermission('product:write');
  const ctx = tenantContextFor(session);
  const actor = actorFor(session, await requestOrigin());

  try {
    await withTenant(session.tenantId, (tx) =>
      setProductStatus(tx, ctx, actor, productId, status),
    );
  } catch (error) {
    return toResult(error);
  }

  revalidatePath(`/products/${slug}`);
  revalidatePath('/products');
  return {
    ok: true,
    message:
      status === 'active'
        ? 'Published — this product is now live on the storefront.'
        : status === 'draft'
          ? 'Unpublished — removed from the storefront.'
          : 'Archived.',
  };
}

/**
 * Adjusts stock for one variant.
 *
 * Requires `inventory:adjust` rather than `product:write`: changing a count is
 * a different act from editing a description, and plenty of staff should be
 * able to do one and not the other.
 */
export async function adjustStockAction(
  variantId: string,
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const session = await requirePermission('inventory:adjust');
  const ctx = tenantContextFor(session);
  const actor = actorFor(session, await requestOrigin());

  const deltaRaw = String(formData.get('delta') ?? '').trim();
  const reason = String(formData.get('reason') ?? 'manual_adjustment');
  const delta = Number(deltaRaw);

  if (!deltaRaw || !Number.isInteger(delta) || delta === 0) {
    return { ok: false, error: 'Enter a whole number of units — negative to remove.' };
  }

  let balanceAfter: number;
  try {
    const result = await withTenant(session.tenantId, (tx) =>
      adjustStock(tx, ctx, actor, {
        variantId,
        delta,
        reason: reason as
          | 'stocktake'
          | 'damage'
          | 'theft'
          | 'manual_adjustment'
          | 'purchase_received',
        note: String(formData.get('note') ?? '') || undefined,
      }),
    );
    balanceAfter = result.balanceAfter;
  } catch (error) {
    return toResult(error);
  }

  revalidatePath(`/products/${slug}`);
  revalidatePath('/inventory');
  return { ok: true, message: `Stock is now ${balanceAfter}.` };
}

/** Brands and categories for the create/edit pickers. */
export async function catalogueOptions(): Promise<{
  brands: { id: string; name: string }[];
  categories: { id: string; name: string }[];
}> {
  const session = await requirePermission('product:read');
  return withTenant(session.tenantId, async (tx) => {
    const brands = await tx.execute<{ id: string; name: string }>(sql`
      SELECT id, name FROM brands WHERE tenant_id = ${session.tenantId} ORDER BY name
    `);
    const categories = await tx.execute<{ id: string; name: string }>(sql`
      SELECT id, name FROM categories WHERE tenant_id = ${session.tenantId} ORDER BY name
    `);
    return { brands: brands.rows, categories: categories.rows };
  });
}
