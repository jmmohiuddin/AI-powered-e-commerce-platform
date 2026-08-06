import 'server-only';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { dbAdmin } from '@voltix/db';
import { resolveSession, sessionCan, SESSION_COOKIE, type SessionUser } from '@voltix/auth';

/**
 * THE AUTHORISATION BOUNDARY
 *
 * Every page and every Server Action calls `requireSession()` or
 * `requirePermission()`. The proxy at the app root is a *fast redirect*, not a
 * security control — Next's own documentation is explicit that proxy checks are
 * optimistic. Two reasons that matters here:
 *
 *  • The proxy runs on the edge runtime, where the Postgres driver does not.
 *    Any check it performs is limited to "is a cookie present", which a forged
 *    cookie satisfies.
 *  • Server Actions are POST endpoints reachable by their own action id. An
 *    attacker does not have to load the page whose route the proxy guards.
 *
 * So the proxy improves the experience (no flash of an empty dashboard) and
 * this module enforces the rule. If they ever disagree, this one wins.
 */

/**
 * `cache()` deduplicates within a single request render.
 *
 * A dashboard page, its layout, and four server components all asking "who is
 * this?" would otherwise be five identical round trips per navigation. This is
 * per-request memoisation, not a cross-request cache — a revoked session is
 * still gone on the very next request.
 */
export const getSession = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  // Deliberately the owner connection. Session resolution decides *which
  // tenant* the caller is, so it cannot run inside a tenant-scoped transaction
  // without circular reasoning. This is the one query in the admin that runs
  // outside RLS; everything downstream is scoped by the tenant it returns.
  return dbAdmin().transaction((tx) => resolveSession(tx, token));
});

export async function requireSession(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) redirect('/login');

  // A privileged role that has not cleared its second factor is signed in but
  // not yet trusted. Sending them to the challenge rather than to the login
  // page avoids asking for a password they already gave.
  if (!session.mfaSatisfied) redirect('/login/verify');

  return session;
}

/**
 * Guards a page or action behind a specific permission.
 *
 * Throws rather than redirecting when the session is valid but under-privileged
 * — a warehouse user who reaches an order-refund URL should be told no, not
 * bounced to a login form that will let them straight back in to the same wall.
 */
export async function requirePermission(permission: string): Promise<SessionUser> {
  const session = await requireSession();
  if (!sessionCan(session, permission)) {
    throw new Error(`FORBIDDEN: ${permission}`);
  }
  return session;
}

/** Non-throwing variant, for hiding UI that would fail if clicked. */
export async function can(permission: string): Promise<boolean> {
  const session = await getSession();
  return session ? sessionCan(session, permission) : false;
}

/**
 * The caller's IP and user agent, for the audit trail and login throttling.
 *
 * `x-forwarded-for` is trusted only because this app is deployed behind a proxy
 * that overwrites it. Read directly from an internet-facing origin the header
 * is client-controlled and every rate limit keyed on it is bypassable by
 * sending a different value — set `TRUST_PROXY=false` in that case.
 */
export async function requestOrigin(): Promise<{ ipAddress?: string; userAgent?: string }> {
  const h = await headers();
  const trustProxy = process.env.TRUST_PROXY !== 'false';
  const forwarded = trustProxy ? h.get('x-forwarded-for')?.split(',')[0]?.trim() : undefined;
  return {
    ipAddress: forwarded || h.get('x-real-ip') || undefined,
    userAgent: h.get('user-agent') ?? undefined,
  };
}

/** The tenant context for commerce services, derived from the session. */
export function tenantContextFor(session: SessionUser) {
  return {
    tenantId: session.tenantId,
    currency: process.env.DEFAULT_CURRENCY ?? 'AED',
    locale: process.env.DEFAULT_LOCALE ?? 'en-AE',
    vatRateBps: Number(process.env.VAT_RATE_BPS ?? 500),
    // VAT_PRICES_INCLUSIVE — the same name the storefront and .env.example
    // use. These were different names for one rule, so setting it to 'false'
    // would have been honoured on the storefront and ignored here, making the
    // admin's totals disagree with the customer's.
    pricesIncludeVat: process.env.VAT_PRICES_INCLUSIVE !== 'false',
  };
}

/** The actor stamp written onto every audit row and order event. */
export function actorFor(
  session: SessionUser,
  origin: { ipAddress?: string; userAgent?: string } = {},
) {
  return {
    type: 'staff' as const,
    id: session.userId,
    label: session.name,
    ipAddress: origin.ipAddress,
    userAgent: origin.userAgent,
  };
}
