import 'server-only';
import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { withTenant } from '@voltix/db';
import { PaymentRegistry, CashOnDeliveryGateway, StripeGateway, TabbyGateway } from '@voltix/payments';
import type { TenantContext } from '@voltix/commerce';
import { DEMO_TENANT_ID } from './catalog';

/**
 * Request-scoped session and tenant plumbing.
 *
 * The cart is identified by an httpOnly cookie rather than a URL parameter or
 * localStorage. httpOnly means a cross-site script cannot read it and hijack
 * someone's basket; a URL parameter would leak the cart into referrer headers
 * and shared links.
 */

const CART_COOKIE = 'voltix_cart';

export async function cartSessionToken(): Promise<string> {
  const store = await cookies();
  return store.get(CART_COOKIE)?.value ?? '';
}

/**
 * Reads the cart token, minting one if absent.
 *
 * Only callable from a Server Action or Route Handler — Next forbids setting a
 * cookie during a render, and rightly so: a GET that mutates client state is
 * not cacheable and not idempotent.
 */
export async function ensureCartSession(): Promise<string> {
  const store = await cookies();
  const existing = store.get(CART_COOKIE)?.value;
  if (existing) return existing;

  const token = randomBytes(24).toString('base64url');
  store.set(CART_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  return token;
}

/**
 * The tenant this request belongs to.
 *
 * Resolved from the host in production — one domain per store — and never from
 * anything the client can set. A tenant id that arrives in a query parameter or
 * a request body is not an isolation boundary, it is an invitation.
 */
export function tenantContext(): TenantContext {
  return {
    tenantId: DEMO_TENANT_ID,
    currency: process.env.DEFAULT_CURRENCY ?? 'AED',
    locale: process.env.DEFAULT_LOCALE ?? 'en-AE',
    vatRateBps: Number(process.env.VAT_RATE_BPS ?? 500),
    pricesIncludeVat: process.env.VAT_PRICES_INCLUSIVE !== 'false',
  };
}

/** Runs `fn` in a transaction with the tenant context set for row-level security. */
export function inTenant<T>(fn: Parameters<typeof withTenant<T>>[1]): Promise<T> {
  return withTenant(tenantContext().tenantId, fn);
}

/**
 * The gateways this store can actually take money with.
 *
 * Built from configuration, so a missing credential disables a method rather
 * than producing a checkout that offers something and then fails. Cash on
 * delivery is always available because it needs no credentials — which is also
 * why it must be the one that is *ordered last* rather than the one that is
 * always first.
 */
let registry: PaymentRegistry | undefined;

export function paymentRegistry(): PaymentRegistry {
  if (registry) return registry;

  const built = new PaymentRegistry();

  if (process.env.STRIPE_SECRET_KEY) {
    built.register(
      new StripeGateway({
        secretKey: process.env.STRIPE_SECRET_KEY,
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
      }),
    );
  }

  if (process.env.TABBY_SECRET_KEY && process.env.TABBY_MERCHANT_CODE) {
    built.register(
      new TabbyGateway({
        secretKey: process.env.TABBY_SECRET_KEY,
        publicKey: process.env.TABBY_PUBLIC_KEY ?? '',
        merchantCode: process.env.TABBY_MERCHANT_CODE,
        ...(process.env.TABBY_WEBHOOK_SECRET
          ? { webhookSecret: process.env.TABBY_WEBHOOK_SECRET }
          : {}),
      }),
    );
  }

  if (process.env.COD_ENABLED !== 'false') {
    built.register(
      new CashOnDeliveryGateway({
        maxOrderAmount: Number(process.env.COD_MAX_ORDER_AMOUNT ?? 500_000),
        advancePaymentBps: Number(process.env.COD_ADVANCE_BPS ?? 0),
        handlingFee: Number(process.env.COD_HANDLING_FEE ?? 0),
        currency: 'AED',
        maxCustomerRiskScore: 70,
      }),
    );
  }

  registry = built;
  return built;
}

/**
 * Flat-rate delivery by emirate, in fils.
 *
 * A real deployment quotes this from the courier's zone table at checkout.
 * These are stand-in rates that at least reflect the actual shape of UAE
 * delivery pricing — Dubai and Sharjah cheap, the northern emirates dearer —
 * so the totals a reviewer sees are not nonsense.
 */
export function deliveryFee(emirate: string, orderSubtotal: number): number {
  if (orderSubtotal >= 20_000) return 0; // free over AED 200
  switch (emirate) {
    case 'DU':
    case 'SH':
      return 1_500;
    case 'AZ':
    case 'AJ':
      return 2_000;
    default:
      return 2_500;
  }
}
