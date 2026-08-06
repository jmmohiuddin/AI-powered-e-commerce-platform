'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  addItem,
  completeCheckout,
  getCart,
  getOrCreateCart,
  removeItem,
  updateItemQuantity,
} from '@voltix/commerce';
import { isDomainError, normaliseUaePhone, type UaeAddress } from '@voltix/core';
import {
  deliveryFee,
  ensureCartSession,
  inTenant,
  paymentRegistry,
  tenantContext,
} from '@/lib/session';

/**
 * SERVER ACTIONS — the mutation surface.
 *
 * Every one runs on the server with the tenant context set, so row-level
 * security applies to the whole call. The client sends intent ("add this
 * variant"), never state ("the total is X") — anything the client says about
 * money is recomputed before it matters.
 *
 * Errors come back as a returned value rather than a thrown exception, because
 * a thrown error in a Server Action reaches the user as a generic "something
 * went wrong" boundary. "Only 2 left — please reduce the quantity" is worth far
 * more than that: it is the difference between a recovered sale and an
 * abandoned one.
 */

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Where the gateway wants the shopper to go next. */
  redirectUrl?: string;
}

function fail(error: unknown): ActionResult {
  if (isDomainError(error)) return { ok: false, error: error.publicMessage };
  console.error('[action]', error);
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

export async function addToCart(variantId: string, quantity = 1): Promise<ActionResult> {
  try {
    const sessionToken = await ensureCartSession();
    const ctx = tenantContext();

    await inTenant(async (tx) => {
      const cartId = await getOrCreateCart(tx, ctx, { sessionToken });
      await addItem(tx, ctx, cartId, { variantId, quantity });
    });

    revalidatePath('/cart');
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function setCartQuantity(itemId: string, quantity: number): Promise<ActionResult> {
  try {
    const sessionToken = await ensureCartSession();
    const ctx = tenantContext();

    await inTenant(async (tx) => {
      const cartId = await getOrCreateCart(tx, ctx, { sessionToken });
      await updateItemQuantity(tx, ctx, cartId, itemId, quantity);
    });

    revalidatePath('/cart');
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function removeFromCart(itemId: string): Promise<ActionResult> {
  try {
    const sessionToken = await ensureCartSession();
    const ctx = tenantContext();

    await inTenant(async (tx) => {
      const cartId = await getOrCreateCart(tx, ctx, { sessionToken });
      await removeItem(tx, cartId, itemId);
    });

    revalidatePath('/cart');
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Places the order.
 *
 * The idempotency key is generated here, server-side, per submission. Letting
 * the client supply it would mean a client bug could replay someone else's
 * order; generating it inside `completeCheckout` would defeat the purpose,
 * since a retry needs the *same* key.
 */
export async function placeOrder(formData: FormData): Promise<ActionResult> {
  const ctx = tenantContext();
  let confirmation: string | undefined;

  try {
    const sessionToken = await ensureCartSession();

    const phone = normaliseUaePhone(String(formData.get('phone') ?? ''));
    if (!phone) {
      return { ok: false, error: 'Enter a valid UAE mobile number, for example 050 123 4567.' };
    }

    const address: UaeAddress = {
      recipientName: String(formData.get('recipientName') ?? '').trim(),
      phone,
      emirate: String(formData.get('emirate') ?? 'DU') as UaeAddress['emirate'],
      area: String(formData.get('area') ?? '').trim(),
      buildingName: String(formData.get('buildingName') ?? '').trim() || undefined,
      flatOrVilla: String(formData.get('flatOrVilla') ?? '').trim() || undefined,
      makani: String(formData.get('makani') ?? '').replace(/\s/g, '') || undefined,
      landmark: String(formData.get('landmark') ?? '').trim() || undefined,
    };

    const provider = String(formData.get('paymentProvider') ?? 'cod');
    const email = String(formData.get('email') ?? '').trim() || undefined;
    const note = String(formData.get('customerNote') ?? '').trim() || undefined;

    const registry = paymentRegistry();
    if (!registry.has(provider as never)) {
      return { ok: false, error: 'That payment method is not available. Please choose another.' };
    }

    const idempotencyKey = randomUUID();
    // `||` not `??`: an empty STOREFRONT_URL would make the gateway return and
    // cancel URLs relative, and a payment provider given a relative redirect
    // sends the shopper nowhere.
    const origin = process.env.STOREFRONT_URL || 'http://localhost:3000';

    const result = await inTenant(async (tx) => {
      const cartId = await getOrCreateCart(tx, ctx, { sessionToken });

      // Recompute with shipping applied, so `expectedTotal` is the number the
      // shopper actually saw on the page they submitted from.
      const preview = await getCart(tx, ctx, cartId);
      const shippingCost = deliveryFee(address.emirate, preview.pricing.subtotal.amount);
      const priced = await getCart(tx, ctx, cartId, { shippingCost });

      return completeCheckout(
        tx,
        ctx,
        { type: 'guest', label: address.recipientName },
        {
          cartId,
          idempotencyKey,
          expectedTotal: priced.pricing.total.amount,
          paymentProvider: provider,
          phone,
          ...(email ? { email } : {}),
          shippingAddress: address,
          shippingCost,
          ...(note ? { customerNote: note } : {}),
          channel: 'web',
        },
        registry.get(provider as never),
        {
          returnUrl: `${origin}/checkout/return`,
          cancelUrl: `${origin}/cart`,
          webhookUrl: `${origin}/api/webhooks/${provider}`,
        },
      );
    });

    // A redirect gateway hands the shopper to a hosted page. Returned rather
    // than redirected here so the client can show the handover.
    if (result.payment.kind === 'requires_action') {
      return { ok: true, redirectUrl: result.payment.redirectUrl };
    }

    confirmation = `/checkout/confirmation/${result.orderNumber}?phone=${encodeURIComponent(phone)}`;
  } catch (error) {
    return fail(error);
  }

  // `redirect` throws internally, so it sits outside the try — inside, the
  // catch would swallow it and the shopper would watch a spinner after a
  // perfectly successful order.
  revalidatePath('/cart');
  redirect(confirmation!);
}
