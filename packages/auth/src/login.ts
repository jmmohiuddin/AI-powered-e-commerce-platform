import { sql } from 'drizzle-orm';
import { uuidv7 } from '@voltix/db';
import { roleRequiresMfa } from '@voltix/core';
import { verifyPassword } from './passwords';
import { createSession, type IssuedSession } from './sessions';
import type { Tx } from './types';

/**
 * SIGN-IN
 *
 * Three defences, each covering a different attack:
 *
 *  • **Per-account lockout** stops credential stuffing against one victim.
 *  • **Per-IP lockout** stops password spraying across many accounts, which a
 *    per-account counter never sees because no single account gets many tries.
 *  • **A uniform failure message** stops account enumeration. "No such user" and
 *    "wrong password" are the same string here, and the password verification
 *    runs even when the user does not exist so the timing matches too.
 */

const MAX_ATTEMPTS_PER_EMAIL = 5;
const MAX_ATTEMPTS_PER_IP = 20;
const LOCKOUT_WINDOW = '15 minutes';

/**
 * Deliberately vague, and identical for every failure mode.
 *
 * A friendlier "that email isn't registered" is a free user-enumeration oracle:
 * an attacker learns which addresses have staff accounts before guessing a
 * single password. The support cost of the vague message is far lower than the
 * cost of publishing your staff directory.
 */
const GENERIC_FAILURE = 'Incorrect email or password.';

export type LoginResult =
  | {
      ok: true;
      session: IssuedSession;
      /**
       * True when this *role* demands a second factor, whether or not the user
       * has enrolled yet.
       *
       * The distinction matters and getting it wrong is a silent hole: keying
       * the redirect on "has the user enrolled" means a privileged account that
       * has never set up MFA skips the challenge entirely and lands on the
       * dashboard. The requirement belongs to the role, and an unenrolled user
       * is sent to enrol rather than waved through.
       */
      requiresMfa: boolean;
      /** True only when a secret is already registered — enrol vs challenge. */
      mfaEnrolled: boolean;
      roleKey: string;
      userId: string;
      tenantId: string;
    }
  | { ok: false; error: string; lockedOut?: boolean };

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  /** Restrict sign-in to one tenant. Omit to use the user's only membership. */
  readonly tenantId?: string;
}

async function recentFailures(tx: Tx, input: LoginInput): Promise<{ email: number; ip: number }> {
  const rows = await tx.execute<{ email_failures: number; ip_failures: number }>(sql`
    SELECT
      count(*) FILTER (WHERE email = ${input.email.toLowerCase()})::int AS email_failures,
      count(*) FILTER (WHERE ip_address = ${input.ipAddress ?? null})::int AS ip_failures
    FROM login_attempts
    WHERE succeeded = false
      AND created_at > now() - interval '${sql.raw(LOCKOUT_WINDOW)}'
  `);
  return {
    email: Number(rows.rows[0]?.email_failures ?? 0),
    ip: Number(rows.rows[0]?.ip_failures ?? 0),
  };
}

async function record(tx: Tx, input: LoginInput, succeeded: boolean): Promise<void> {
  await tx.execute(sql`
    INSERT INTO login_attempts (id, email, ip_address, succeeded, created_at)
    VALUES (${uuidv7()}, ${input.email.toLowerCase()}, ${input.ipAddress ?? null}, ${succeeded}, now())
  `);
}

export async function login(tx: Tx, input: LoginInput): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase();

  const failures = await recentFailures(tx, { ...input, email });
  if (failures.email >= MAX_ATTEMPTS_PER_EMAIL || failures.ip >= MAX_ATTEMPTS_PER_IP) {
    // Not recorded as another attempt: doing so would let an attacker extend
    // a victim's lockout indefinitely by continuing to hammer the endpoint,
    // turning a defence into a denial-of-service against the real user.
    return {
      ok: false,
      lockedOut: true,
      error: 'Too many sign-in attempts. Try again in 15 minutes.',
    };
  }

  const rows = await tx.execute<{
    id: string;
    password_hash: string | null;
    session_epoch: string;
    mfa_enabled_at: Date | null;
    tenant_id: string | null;
    role_key: string | null;
  }>(sql`
    SELECT u.id, u.password_hash, u.session_epoch, u.mfa_enabled_at,
           m.tenant_id, r.key AS role_key
    FROM users u
    LEFT JOIN memberships m ON m.user_id = u.id AND m.accepted_at IS NOT NULL
      ${input.tenantId ? sql`AND m.tenant_id = ${input.tenantId}` : sql``}
    LEFT JOIN roles r ON r.id = m.role_id
    WHERE lower(u.email) = ${email} AND u.deleted_at IS NULL
    LIMIT 1
  `);

  const user = rows.rows[0];

  // Runs even when `user` is undefined — verifyPassword hashes a dummy value
  // for a null digest, so a missing account costs the same wall-clock time as
  // a wrong password. Without this, response latency alone reveals which
  // addresses are registered.
  const passwordOk = await verifyPassword(input.password, user?.password_hash ?? null);

  if (!user || !passwordOk) {
    await record(tx, { ...input, email }, false);
    return { ok: false, error: GENERIC_FAILURE };
  }

  if (!user.tenant_id) {
    await record(tx, { ...input, email }, false);
    // A valid password with no accepted membership: the account exists but has
    // no access. Same generic message — revealing "your invitation is pending"
    // still confirms the account is real.
    return { ok: false, error: GENERIC_FAILURE };
  }

  await record(tx, { ...input, email }, true);

  const session = await createSession(tx, {
    userId: user.id,
    tenantId: user.tenant_id,
    sessionEpoch: user.session_epoch,
    // The session starts *without* MFA satisfied. A privileged role can sign in
    // but sees nothing until the second factor is presented; `resolveSession`
    // enforces that, so forgetting to check here is not exploitable.
    mfaVerified: false,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  await tx.execute(sql`UPDATE users SET last_login_at = now() WHERE id = ${user.id}`);

  return {
    ok: true,
    session,
    requiresMfa: roleRequiresMfa(user.role_key ?? ''),
    mfaEnrolled: user.mfa_enabled_at !== null,
    roleKey: user.role_key ?? '',
    userId: user.id,
    tenantId: user.tenant_id,
  };
}

/**
 * Changes a password and invalidates every existing session.
 *
 * The epoch bump is the important half. Changing a password while leaving old
 * sessions alive means the person you just locked out — an ex-employee, or
 * whoever stole the laptop that prompted the change — keeps their access.
 */
export async function changePassword(
  tx: Tx,
  userId: string,
  newHash: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE users
    SET password_hash = ${newHash},
        session_epoch = (session_epoch::bigint + 1)::text,
        updated_at = now()
    WHERE id = ${userId}
  `);
}
