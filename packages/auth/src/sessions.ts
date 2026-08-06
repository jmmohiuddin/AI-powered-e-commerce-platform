import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@voltix/db';
import { hasPermission, roleRequiresMfa, type PermissionPattern } from '@voltix/core';
import type { Tx } from './types';

/**
 * SESSION MANAGEMENT
 *
 * Opaque random tokens in an httpOnly cookie, with only the SHA-256 stored.
 *
 * Why not a JWT: an admin that can refund money and read customer PII needs
 * revocation to be instant. A signed token is valid until it expires — you
 * cannot un-issue one. The usual answer is a denylist, which is a session table
 * with worse ergonomics and an extra failure mode. Here, DELETE means gone.
 *
 * Why only the hash is stored: the same reasoning as password hashing, applied
 * to bearer credentials. A leaked database dump — via backup, log, or SQL
 * injection — hands the attacker every live session if the raw token is on
 * disk. SHA-256 (not Argon2) is right here because the input is 256 bits of
 * CSPRNG output: there is no dictionary to attack, so key-stretching only buys
 * latency on every single request.
 */

/** 32 bytes = 256 bits. Base64url so it survives a cookie unescaped. */
const TOKEN_BYTES = 32;

/**
 * Eight hours — one shift.
 *
 * Long enough that nobody is re-authenticating mid-task, short enough that a
 * laptop left open in a mall kiosk stops being an open till overnight. Rolled
 * forward on activity, so an actually-busy user is never kicked out.
 */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** Refresh the expiry at most once a minute — otherwise every page view writes. */
const TOUCH_INTERVAL_MS = 60 * 1000;

export const SESSION_COOKIE = 'voltix_admin_session';

export interface SessionUser {
  readonly userId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly name: string;
  readonly roleKey: string;
  readonly roleName: string;
  readonly permissions: readonly string[];
  readonly mfaSatisfied: boolean;
  readonly expiresAt: Date;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssuedSession {
  /** Give this to the browser. It is never recoverable from the database. */
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
}

export async function createSession(
  tx: Tx,
  input: {
    userId: string;
    tenantId: string;
    sessionEpoch: string;
    mfaVerified: boolean;
    ipAddress?: string;
    userAgent?: string;
  },
): Promise<IssuedSession> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const sessionId = uuidv7();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await tx.execute(sql`
    INSERT INTO sessions
      (id, user_id, tenant_id, token_hash, session_epoch, mfa_verified_at,
       ip_address, user_agent, last_seen_at, expires_at, created_at, updated_at)
    VALUES (${sessionId}, ${input.userId}, ${input.tenantId}, ${hashToken(token)},
            ${input.sessionEpoch}, ${input.mfaVerified ? sql`now()` : null},
            ${input.ipAddress ?? null}, ${input.userAgent ?? null},
            now(), ${expiresAt}, now(), now())
  `);

  return { token, sessionId, expiresAt };
}

/**
 * Resolves a cookie token to a live session, or null.
 *
 * Runs as the *admin* connection deliberately. Session lookup is the step that
 * decides which tenant you are, so it cannot itself run inside a tenant-scoped
 * transaction — that would be circular. Everything after this point is
 * tenant-scoped; this one query is the trust boundary.
 *
 * The join to `users` is not an optimisation, it is the epoch check: a password
 * change bumps `users.session_epoch`, and every session carrying the old value
 * stops resolving on the very next request. One UPDATE logs out every device.
 */
export async function resolveSession(tx: Tx, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;

  const rows = await tx.execute<{
    session_id: string;
    user_id: string;
    tenant_id: string;
    email: string;
    name: string;
    role_key: string;
    role_name: string;
    permissions: string[];
    mfa_verified_at: Date | null;
    mfa_enabled_at: Date | null;
    expires_at: Date;
    last_seen_at: Date;
  }>(sql`
    SELECT s.id AS session_id, s.user_id, s.tenant_id, s.expires_at, s.last_seen_at,
           s.mfa_verified_at, u.email, u.name, u.mfa_enabled_at,
           r.key AS role_key, r.name AS role_name, r.permissions
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    JOIN memberships m ON m.user_id = s.user_id AND m.tenant_id = s.tenant_id
    JOIN roles r ON r.id = m.role_id
    WHERE s.token_hash = ${hashToken(token)}
      AND s.revoked_at IS NULL
      AND s.expires_at > now()
      AND s.session_epoch = u.session_epoch
      AND u.deleted_at IS NULL
      AND m.accepted_at IS NOT NULL
    LIMIT 1
  `);

  const row = rows.rows[0];
  if (!row) return null;

  // Roles that can move money must have cleared a second factor *in this
  // session*. Having MFA enabled on the account is not the same as having used
  // it — a stolen session cookie would otherwise inherit the privilege.
  const mfaSatisfied = roleRequiresMfa(row.role_key) ? row.mfa_verified_at !== null : true;

  // Sliding expiry, written at most once a minute. Without the interval guard
  // every page view becomes a write, and a dashboard that polls turns the
  // sessions table into the hottest relation in the database.
  const staleness = Date.now() - new Date(row.last_seen_at).getTime();
  let expiresAt = new Date(row.expires_at);
  if (staleness > TOUCH_INTERVAL_MS) {
    expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await tx.execute(sql`
      UPDATE sessions SET last_seen_at = now(), expires_at = ${expiresAt}, updated_at = now()
      WHERE id = ${row.session_id}
    `);
  }

  return {
    sessionId: row.session_id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    email: row.email,
    name: row.name,
    roleKey: row.role_key,
    roleName: row.role_name,
    permissions: Array.isArray(row.permissions) ? row.permissions : [],
    mfaSatisfied,
    expiresAt,
  };
}

export async function revokeSession(tx: Tx, sessionId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE sessions SET revoked_at = now(), updated_at = now()
    WHERE id = ${sessionId} AND revoked_at IS NULL
  `);
}

/** Sign out everywhere. Used on password change and by an admin disabling a user. */
export async function revokeAllSessions(tx: Tx, userId: string): Promise<number> {
  const result = await tx.execute(sql`
    UPDATE sessions SET revoked_at = now(), updated_at = now()
    WHERE user_id = ${userId} AND revoked_at IS NULL
  `);
  return result.rowCount ?? 0;
}

/**
 * Deletes sessions that expired more than a week ago.
 *
 * Kept for a week rather than deleted on expiry because "when was this account
 * last used, and from where" is a question incident response asks about the
 * recent past, and a table that self-erases cannot answer it.
 */
export async function sweepExpiredSessions(tx: Tx): Promise<number> {
  const result = await tx.execute(sql`
    DELETE FROM sessions WHERE expires_at < now() - interval '7 days'
  `);
  return result.rowCount ?? 0;
}

/** Permission check against the session's role, honouring `*` and `order:*`. */
export function sessionCan(session: SessionUser, permission: string): boolean {
  if (!session.mfaSatisfied) return false;
  return hasPermission(session.permissions as PermissionPattern[], permission as never);
}
