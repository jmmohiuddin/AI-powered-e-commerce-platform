'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { dbAdmin } from '@voltix/db';
import { login, revokeSession, SESSION_COOKIE } from '@voltix/auth';
import { getSession, requestOrigin } from '../../lib/auth';

export interface LoginState {
  readonly error?: string;
  /**
   * Echoed back so the form can refill the field.
   *
   * React resets uncontrolled inputs when a form action completes, so without
   * this a failed attempt wipes the email as well as the password and the user
   * retypes both. Only the email comes back — returning the password would put
   * a live credential into the server-action response payload.
   */
  readonly email?: string;
}

/**
 * Only same-origin relative paths are honoured as a post-login destination.
 *
 * `?next=https://evil.example` on a login link is the classic open-redirect
 * phish: the URL is genuinely yours, the user signs in for real, and then lands
 * on an attacker's clone asking them to "confirm" their password. Rejecting
 * anything that is not a single-slash-prefixed path closes it — note the
 * `//host` check, because `//evil.example` is protocol-relative and absolutely
 * does leave the site.
 */
function safeRedirect(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}

export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const next = safeRedirect(String(formData.get('next') ?? ''));

  if (!email || !password) {
    return { error: 'Enter your email and password.', email };
  }

  const origin = await requestOrigin();
  const result = await dbAdmin().transaction((tx) =>
    login(tx, { email, password, ...origin }),
  );

  if (!result.ok) {
    return { error: result.error, email };
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, result.session.token, {
    httpOnly: true,
    // `strict`, not `lax`. The admin has no legitimate inbound links from other
    // sites, so there is nothing to break — and strict is the one setting that
    // makes cross-site request forgery structurally impossible rather than
    // merely mitigated by a token the framework might forget to check.
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: result.session.expiresAt,
  });

  // `requiresMfa` is a property of the *role*, not of whether this user has
  // enrolled. An owner who has never set up a second factor is sent to enrol
  // rather than waved through — keying this on enrolment would mean the most
  // privileged accounts are the ones that skip the check.
  //
  // Outside a try/catch deliberately: redirect() signals by throwing, so
  // catching around it swallows the navigation and leaves the user staring at
  // a form that appeared to do nothing.
  redirect(result.requiresMfa ? '/login/verify' : next);
}

export async function signOut(): Promise<void> {
  const session = await getSession();
  if (session) {
    await dbAdmin().transaction((tx) => revokeSession(tx, session.sessionId));
  }
  // Cleared regardless. If the row is already gone the cookie is still a
  // pointer to nothing, and leaving it behind means the proxy keeps waving the
  // browser toward a dashboard that will only bounce it back here.
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/login');
}
