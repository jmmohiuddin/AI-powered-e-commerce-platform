'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { dbAdmin } from '@voltix/db';
import {
  beginEnrolment,
  completeEnrolment,
  SESSION_COOKIE,
  resolveSession,
  verifyMfaChallenge,
} from '@voltix/auth';

export interface MfaState {
  readonly error?: string;
  readonly recoveryCodes?: readonly string[];
}

/**
 * Resolves the *unverified* session.
 *
 * `getSession()` in lib/auth is not usable here: `requireSession()` redirects
 * anyone without MFA to this very page, so calling it from the page's own
 * action is an infinite bounce. This deliberately accepts a session that has
 * not yet satisfied its second factor — that is precisely who is standing here.
 */
async function pendingSession() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect('/login');
  return dbAdmin().transaction((tx) => resolveSession(tx, token));
}

export async function submitMfaCode(_prev: MfaState, formData: FormData): Promise<MfaState> {
  const session = await pendingSession();
  if (!session) redirect('/login');

  const code = String(formData.get('code') ?? '').trim();
  if (!code) return { error: 'Enter the 6-digit code from your authenticator.' };

  const result = await dbAdmin().transaction((tx) =>
    verifyMfaChallenge(tx, session.userId, session.sessionId, code),
  );

  if (!result.ok) return { error: result.error };
  redirect('/');
}

/**
 * Enrolment. The secret travels through a hidden form field between the two
 * steps rather than being written to the database up front — so an abandoned
 * enrolment leaves no trace, and an account is never marked MFA-protected with
 * a secret nobody successfully scanned.
 */
export async function enrol(_prev: MfaState, formData: FormData): Promise<MfaState> {
  const session = await pendingSession();
  if (!session) redirect('/login');

  const secret = String(formData.get('secret') ?? '');
  const code = String(formData.get('code') ?? '').trim();
  if (!secret) return { error: 'Enrolment expired. Reload the page and scan again.' };
  if (!code) return { error: 'Enter the 6-digit code shown in your authenticator app.' };

  const result = await dbAdmin().transaction((tx) =>
    completeEnrolment(tx, session.userId, secret, code, session.sessionId),
  );

  if (!result.ok) return { error: result.error };

  // Deliberately NOT redirecting: the recovery codes are shown exactly once and
  // navigating away from them silently is how people end up locked out of a
  // store they own. The page renders them and requires an explicit confirmation.
  return { recoveryCodes: result.recoveryCodes };
}

export async function newEnrolmentSecret(email: string) {
  return beginEnrolment(email);
}
