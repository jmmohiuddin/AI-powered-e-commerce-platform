import { NextResponse, type NextRequest } from 'next/server';

/**
 * CONTENT SECURITY POLICY
 *
 * The one security header that cannot be declared statically in next.config.ts,
 * because a policy worth having is nonce-based and a nonce must be fresh per
 * request. The other five headers stay in next.config.ts, where they also cover
 * static assets.
 *
 * WHY THIS FILE IS `proxy.ts` AND NOT `middleware.ts`: Next 16 deprecated the
 * `middleware` convention and renamed it to `proxy` — same capability, same
 * request/response API, and `next build` warns on the old name. See
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md.
 *
 * HOW THE NONCE REACHES THE MARKUP: it does not travel as a prop. Next reads
 * the `Content-Security-Policy` (or `…-Report-Only`) header off the *request*
 * during render, extracts the `'nonce-…'` source, and stamps it onto its own
 * bootstrap and chunk scripts. That is why the policy is written twice below —
 * onto the request so the renderer can see it, and onto the response so the
 * browser enforces it. Set it only on the response and every Next script is
 * blocked.
 *
 * This works because every page here is already dynamically rendered: the root
 * layout reads the locale cookie (see lib/locale.ts). A statically prerendered
 * page has no request to carry a nonce, and its scripts would be blocked — so
 * if that layout ever stops reading cookies, this policy has to be revisited
 * along with it.
 */

/**
 * ENFORCED BY DEFAULT. `CSP_ENFORCE=false` is the escape hatch, not the switch.
 *
 * This used to be report-only, because the JSON-LD the product page emits
 * through `dangerouslySetInnerHTML` could not be nonced by whoever owned this
 * file. That is fixed: both app-authored script tags — Product on
 * app/products/[slug]/page.tsx and BreadcrumbList on app/category/[...slug] —
 * now read `nonce={(await headers()).get('x-nonce')}`, and they are the only
 * two in the app.
 *
 * Verified before flipping, against a production build with the policy
 * enforced, over every route: every `<script>` carried a nonce equal to the one
 * in the response header, React hydrated and stayed interactive (which is what
 * proves 'strict-dynamic' is doing its job), and no violation was reported.
 *
 * WHY UNSET MEANS ENFORCE. A deployment that forgets this variable should end
 * up protected rather than quietly unprotected — a security header that
 * disappears when configuration is incomplete is the one that is missing on the
 * day it is needed, and nothing about the app looks wrong in the meantime. The
 * inverse default fails silent; this one fails loud, and loud is recoverable.
 *
 * THE CONDITION THIS DEPENDS ON. Enforcement is only safe while every page is
 * dynamically rendered, which is true because the root layout reads the locale
 * cookie (lib/locale.ts). A statically prerendered page has no request to carry
 * a nonce and its scripts would be blocked in production — invisible in `next
 * dev`, where everything renders dynamically. `next build` is the check: every
 * route must be listed as `ƒ (Dynamic)`. If one ever turns into `○ (Static)`,
 * that page will break under this policy.
 */
const ENFORCE = process.env.CSP_ENFORCE !== 'false';

const IS_DEV = process.env.NODE_ENV === 'development';

/**
 * Images may be served from somewhere other than this origin.
 *
 * The same two variables `next.config.ts` builds `images.remotePatterns` from,
 * for the same reason: `CDN_BASE_URL` once a CDN fronts the bucket, and
 * `S3_ENDPOINT` for the bucket itself, which is what a local MinIO setup hits
 * directly. The two lists must agree — an origin `next/image` will fetch but
 * CSP will not render is a blank image with a console error and no clue.
 *
 * Reduced to an origin rather than the full base URL: a CSP source with a path
 * matches by path *prefix*, so a bucket reorganisation would silently start
 * blocking images.
 */
const MEDIA_ORIGINS = [
  ...new Set(
    [process.env.CDN_BASE_URL, process.env.S3_ENDPOINT]
      .map(originOf)
      .filter((origin): origin is string => origin !== null),
  ),
];

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  const policy = [
    `default-src 'self'`,

    // 'strict-dynamic' means the nonce is what matters and host allow-lists are
    // ignored by browsers that understand it: a script Next loads from its own
    // nonced bootstrap inherits trust, and an injected <script src="evil"> does
    // not. 'unsafe-eval' in development only — React rebuilds server stack
    // traces in the browser with eval, and nothing in production does.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${IS_DEV ? ` 'unsafe-eval'` : ''}`,

    // 'unsafe-inline' for styles is a considered concession, not an oversight.
    // The server components style with React's `style` prop, which renders as a
    // style *attribute* — and a nonce cannot be attached to an attribute, so
    // nonce-based style-src would break the layout of every page while
    // providing nothing. The exposure is CSS injection, not script execution.
    `style-src 'self' 'unsafe-inline'`,

    ['img-src', `'self'`, 'blob:', 'data:', ...MEDIA_ORIGINS].join(' '),
    `font-src 'self'`,

    // ws: for the dev server's HMR socket. Payment gateways are not listed
    // because every adapter here redirects to a hosted page rather than
    // embedding a script — adding one that does not means adding it here.
    `connect-src 'self'${IS_DEV ? ' ws:' : ''}`,

    `object-src 'none'`,
    `base-uri 'self'`,

    // The storefront posts to itself and nowhere else. This is what stops an
    // injected form from exfiltrating a filled-in delivery address.
    `form-action 'self'`,

    // Duplicates X-Frame-Options from next.config.ts on purpose: frame-ancestors
    // is the directive modern browsers honour, XFO is what old ones understand.
    `frame-ancestors 'none'`,
    `frame-src 'none'`,

    ...(IS_DEV ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  const header = ENFORCE ? 'content-security-policy' : 'content-security-policy-report-only';

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(header, policy);
  // Also exposed on its own, so a server component that needs to nonce an
  // inline script can read it with `headers().get('x-nonce')` rather than
  // re-parsing the policy.
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(header, policy);
  return response;
}

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export const config = {
  matcher: [
    {
      /*
       * Documents only. Static assets and the image optimiser serve bytes that
       * no policy governs, and running this on them would mint a nonce per
       * asset request for nothing.
       */
      source: '/((?!_next/static|_next/image|favicon.ico|products/.*\\.svg).*)',
      // Prefetches render no HTML, so they need no nonce — and a prefetched
      // response cached against one nonce would carry it into a later document.
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
