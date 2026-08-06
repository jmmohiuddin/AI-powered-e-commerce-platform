import { NextResponse, type NextRequest } from 'next/server';

/**
 * OPTIMISTIC AUTH REDIRECT
 *
 * Renamed from `middleware.ts` — Next.js 16 calls this convention `proxy`.
 *
 * This checks only that a session cookie *exists*. It does not validate it, and
 * it is not the authorisation boundary — `src/lib/auth.ts` is. The reason is
 * structural rather than a shortcut: this file runs before the request reaches
 * a Node runtime, so it has no Postgres driver and cannot verify anything. A
 * forged cookie sails through here and is rejected by `requireSession()` on the
 * page itself.
 *
 * What it buys is the experience: an unauthenticated visitor lands on the login
 * form immediately, instead of watching a dashboard shell render and then
 * bounce. Security-wise it is worth exactly zero, and pretending otherwise is
 * how people end up shipping an admin with no real check anywhere.
 */
const SESSION_COOKIE = 'voltix_admin_session';

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasCookie = request.cookies.has(SESSION_COOKIE);

  if (pathname.startsWith('/login')) {
    // Already signed in and asking for the login page: send them onward rather
    // than showing a form that will immediately redirect after submission.
    if (hasCookie && pathname === '/login') {
      return NextResponse.redirect(new URL('/', request.url));
    }
    return NextResponse.next();
  }

  if (!hasCookie) {
    const login = new URL('/login', request.url);
    // Preserve where they were going, so signing in lands on the page they
    // actually wanted. `pathname + search` only — never an absolute URL from
    // the request, which would make this an open redirect.
    if (pathname !== '/') login.searchParams.set('next', pathname + request.nextUrl.search);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  // Static assets and the health check are excluded: running this on every
  // image request costs latency and protects nothing.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|healthz|.*\\.(?:svg|png|jpg|webp|ico)$).*)'],
};
