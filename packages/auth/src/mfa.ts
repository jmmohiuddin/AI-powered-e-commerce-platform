import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { decryptSecret, encryptSecret, generateTotpSecret, totpUri, verifyTotp } from './totp';
import type { Tx } from './types';

/**
 * MFA ENROLMENT AND CHALLENGE
 *
 * Enrolment is two-step by design: generate a secret, then require a working
 * code before storing it. Saving the secret at generation time is the common
 * shortcut and it produces the worst possible outcome — an account marked as
 * MFA-protected whose owner never successfully scanned the QR, and who is now
 * locked out of a system with no self-service reset.
 */

export interface EnrolmentChallenge {
  readonly secret: string;
  readonly uri: string;
}

export function beginEnrolment(email: string): EnrolmentChallenge {
  const secret = generateTotpSecret();
  return { secret, uri: totpUri(secret, email) };
}

/**
 * Confirms enrolment. Returns the recovery codes, which are shown exactly once.
 *
 * Recovery codes are not optional politeness. A phone is lost, stolen, wiped or
 * replaced regularly, and without them the only recovery path is another
 * administrator — which fails completely for a single-owner store, the exact
 * shape of most merchants on this platform.
 */
export async function completeEnrolment(
  tx: Tx,
  userId: string,
  secret: string,
  code: string,
  /**
   * The session to mark as verified.
   *
   * Enrolling *is* a successful challenge — the user just proved possession of
   * the factor with a live code. Demanding another one thirty seconds later is
   * friction with no security value, and it is where people abandon setup.
   */
  sessionId?: string,
): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; error: string }> {
  if (!verifyTotp(secret, code)) {
    return { ok: false, error: 'That code is not valid. Check your authenticator and try again.' };
  }

  const recoveryCodes = Array.from({ length: 10 }, () =>
    // 10 bytes → 16 base32 chars, grouped for legibility because these get
    // written down on paper and typed back in months later.
    randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})/, '$1-'),
  );

  await tx.execute(sql`
    UPDATE users
    SET totp_secret = ${encryptSecret(secret)},
        mfa_enabled_at = now(),
        mfa_recovery_codes = ${JSON.stringify(recoveryCodes.map(hashRecoveryCode))}::jsonb,
        updated_at = now()
    WHERE id = ${userId}
  `);

  if (sessionId) await markVerified(tx, sessionId);

  return { ok: true, recoveryCodes };
}

/**
 * Recovery codes are hashed, like any other credential.
 *
 * Plain SHA-256 rather than Argon2, for the same reason as session tokens: the
 * input is 40 bits of CSPRNG output with no dictionary behind it, so stretching
 * buys latency and nothing else.
 */
function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.replace(/[^A-F0-9]/gi, '').toUpperCase()).digest('hex');
}

export type MfaResult =
  | { ok: true; usedRecoveryCode: boolean }
  | { ok: false; error: string };

/**
 * Verifies a challenge and marks the session as having satisfied MFA.
 *
 * Accepts either a TOTP code or an unused recovery code. A consumed recovery
 * code is deleted from the list, not marked — a single-use credential that is
 * still readable in the row it was consumed from is a single-use credential in
 * name only.
 */
export async function verifyMfaChallenge(
  tx: Tx,
  userId: string,
  sessionId: string,
  code: string,
): Promise<MfaResult> {
  const rows = await tx.execute<{
    totp_secret: string | null;
    mfa_recovery_codes: string[] | null;
  }>(sql`
    SELECT totp_secret, mfa_recovery_codes FROM users WHERE id = ${userId} LIMIT 1
  `);

  const row = rows.rows[0];
  const stored = row?.totp_secret ? decryptSecret(row.totp_secret) : null;

  if (stored && verifyTotp(stored, code)) {
    await markVerified(tx, sessionId);
    return { ok: true, usedRecoveryCode: false };
  }

  const hashes = Array.isArray(row?.mfa_recovery_codes) ? row.mfa_recovery_codes : [];
  const attempted = hashRecoveryCode(code);
  if (hashes.includes(attempted)) {
    await tx.execute(sql`
      UPDATE users
      SET mfa_recovery_codes = ${JSON.stringify(hashes.filter((h) => h !== attempted))}::jsonb,
          updated_at = now()
      WHERE id = ${userId}
    `);
    await markVerified(tx, sessionId);
    return { ok: true, usedRecoveryCode: true };
  }

  return { ok: false, error: 'That code is not valid.' };
}

async function markVerified(tx: Tx, sessionId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE sessions SET mfa_verified_at = now(), updated_at = now() WHERE id = ${sessionId}
  `);
}

/** Whether this user has completed enrolment. */
export async function hasMfaEnrolled(tx: Tx, userId: string): Promise<boolean> {
  const rows = await tx.execute<{ enrolled: boolean }>(sql`
    SELECT (mfa_enabled_at IS NOT NULL AND totp_secret IS NOT NULL) AS enrolled
    FROM users WHERE id = ${userId} LIMIT 1
  `);
  return rows.rows[0]?.enrolled === true;
}
