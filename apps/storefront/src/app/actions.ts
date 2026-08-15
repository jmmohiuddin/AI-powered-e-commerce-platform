'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  addItem,
  completeCheckout,
  failureReason,
  getCart,
  getOrCreateCart,
  removeItem,
  updateItemQuantity,
} from '@voltix/commerce';
import { isDomainError, normaliseUaePhone, type UaeAddress } from '@voltix/core';
import { track } from '@/lib/analytics';
import {
  cartSessionToken,
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
  /**
   * Minor units the shopper must pay now before a cash-on-delivery order will
   * be accepted. Set only when the checkout refused for that reason, so the
   * form can open the deposit step instead of showing a dead-end error.
   */
  advanceDue?: number;
}

function fail(error: unknown): ActionResult {
  if (isDomainError(error)) {
    // A deposit demand is not a failure the shopper has to recover from on
    // their own — it is a step. The amount travels with the message so the form
    // can ask for a card rather than making them guess what to change.
    if (error.code === 'ADVANCE_REQUIRED') {
      const advanceDue = Number(error.details?.advanceDue ?? 0);
      return { ok: false, error: error.publicMessage, advanceDue };
    }
    return { ok: false, error: error.publicMessage };
  }
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

  /**
   * Hoisted only so the failure path can name them.
   *
   * A `checkout_failed` row that cannot say which payment method or which
   * emirate it happened in is a count with no lead attached, and the failure
   * path is the half of the funnel worth instrumenting well.
   */
  let provider = 'cod';
  let emirate = 'DU';

  try {
    const sessionToken = await ensureCartSession();

    await track({
      type: 'checkout_started',
      sessionId: sessionToken,
      currency: ctx.currency,
    });

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

    provider = String(formData.get('paymentProvider') ?? 'cod');
    emirate = address.emirate;
    const email = String(formData.get('email') ?? '').trim() || undefined;
    const note = String(formData.get('customerNote') ?? '').trim() || undefined;

    /**
     * The buyer's TRN, when they are buying for a business.
     *
     * Spaces and dashes are stripped here because shoppers type the number the
     * way it is printed on their certificate. `completeCheckout` validates it
     * and refuses a malformed one — deliberately not silently dropped, since a
     * dropped TRN produces a simplified invoice the business cannot reclaim
     * VAT against, and they only discover that at their own filing.
     */
    const trn = String(formData.get('recipientTrn') ?? '').replace(/[\s-]/g, '') || undefined;

    const registry = paymentRegistry();
    if (!registry.has(provider as never)) {
      return { ok: false, error: 'That payment method is not available. Please choose another.' };
    }

    /**
     * The card the shopper picked for a cash-on-delivery deposit.
     *
     * Validated the same way as the main provider and never trusted further
     * than that: `completeCheckout` decides whether a deposit is owed at all
     * and how large it is. This only answers "with what".
     */
    const advanceProvider = String(formData.get('advancePaymentProvider') ?? '').trim();
    if (advanceProvider && !registry.has(advanceProvider as never)) {
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
          ...(trn ? { recipientTrn: trn } : {}),
          ...(advanceProvider ? { advancePaymentProvider: advanceProvider } : {}),
          channel: 'web',
        },
        registry.get(provider as never),
        {
          returnUrl: `${origin}/checkout/return`,
          cancelUrl: `${origin}/cart`,
          webhookUrl: `${origin}/api/webhooks/${provider}`,
          ...(advanceProvider
            ? { advanceWebhookUrl: `${origin}/api/webhooks/${advanceProvider}` }
            : {}),
        },
        advanceProvider ? registry.get(advanceProvider as never) : undefined,
      );
    });

    /**
     * Recorded on the order, not on the payment.
     *
     * A redirect card order is placed here and settles minutes later in the
     * webhook, so waiting for money would push every card sale out of the day
     * it happened and make the funnel disagree with the order list. Settlement
     * is its own event: `payment_settled` is what closes the loop.
     *
     * A replayed idempotent request is skipped — the double-tap that produced
     * it is one order and must not read as two.
     */
    if (!result.replayed) {
      await track({
        type: 'order_placed',
        sessionId: sessionToken,
        value: result.total,
        currency: result.currency,
        properties: {
          orderNumber: result.orderNumber,
          // Required by L-03: supplies must be attributable to the emirate they
          // were received in, and that cannot be reconstructed afterwards.
          emirate,
          channel: 'web',
          paymentProvider: provider,
          advanceDue: result.advanceDue ?? 0,
          codDue: result.codDue ?? 0,
          riskScore: result.riskScore ?? null,
          settled: result.payment.kind !== 'requires_action',
        },
      });
    }

    // A redirect gateway hands the shopper to a hosted page. Returned rather
    // than redirected here so the client can show the handover.
    if (result.payment.kind === 'requires_action') {
      return { ok: true, redirectUrl: result.payment.redirectUrl };
    }

    confirmation = `/checkout/confirmation/${result.orderNumber}?phone=${encodeURIComponent(phone)}`;
  } catch (error) {
    const { reason, step } = failureReason(error);
    const details: Record<string, unknown> = isDomainError(error) ? (error.details ?? {}) : {};
    const sessionId = await cartSessionToken();

    await track({
      type: 'checkout_failed',
      sessionId,
      currency: ctx.currency,
      properties: { reason, step, paymentProvider: provider, emirate },
    });

    /**
     * A refused cash-on-delivery order is recorded twice, on purpose.
     *
     * It is a checkout failure like any other and belongs in that funnel, and
     * it is separately the number this business is trying to move — refused COD
     * is the loss the whole risk model exists to prevent. Deriving one from the
     * other later means every COD report carries a filter that someone will
     * eventually get wrong.
     */
    if (details.codRefused === true) {
      await track({
        type: 'cod_refused',
        sessionId,
        currency: ctx.currency,
        properties: {
          reason: details.reason ?? null,
          riskScore: details.score ?? null,
          emirate,
        },
      });
    }

    return fail(error);
  }

  // `redirect` throws internally, so it sits outside the try — inside, the
  // catch would swallow it and the shopper would watch a spinner after a
  // perfectly successful order.
  revalidatePath('/cart');
  redirect(confirmation!);
}
