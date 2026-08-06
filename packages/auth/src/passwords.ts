import { hash, verify } from '@node-rs/argon2';
import { timingSafeEqual } from 'node:crypto';

/**
 * PASSWORD HASHING
 *
 * Argon2id, not bcrypt. Two concrete reasons rather than fashion:
 *
 *  • **bcrypt silently truncates at 72 bytes.** A long passphrase — exactly what
 *    you want staff using — is cut off, and the user is never told. Two
 *    different passwords sharing a 72-byte prefix are the same password.
 *  • **Argon2 is memory-hard.** bcrypt is CPU-hard but cheap on memory, which
 *    is what makes GPU and ASIC cracking economic. Argon2id forces an attacker
 *    to buy RAM per guess.
 *
 * Parameters below are the OWASP baseline: 19 MiB, 2 iterations, parallelism 1.
 * They are deliberately *not* maximal — a login that takes 800 ms is a login
 * page that feels broken, and staff sign in many times a day. Measure on the
 * real deployment target and raise `memoryCost` until a hash costs ~250 ms.
 */
const OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length < 12) {
    // Length beats character-class rules: "correct horse battery staple" is
    // stronger and more memorable than "P@ssw0rd!". NIST dropped the
    // composition requirements years ago; this keeps only the floor.
    throw new Error('Password must be at least 12 characters');
  }
  if (plaintext.length > 1024) {
    // Argon2 will happily hash a 10 MB string and tie up the event loop doing
    // it. An unbounded password field is a free denial-of-service.
    throw new Error('Password must be at most 1024 characters');
  }
  return hash(plaintext, OPTIONS);
}

/**
 * Verifies a password.
 *
 * Never throws on a bad hash — a corrupt or legacy value returns false rather
 * than a 500, because an exception here is an oracle telling an attacker that
 * the account exists and its record is unusual.
 */
export async function verifyPassword(plaintext: string, digest: string | null): Promise<boolean> {
  if (!digest) {
    // Deliberate work for an account with no password set (SSO-only, or simply
    // absent). Returning immediately makes account enumeration trivial from
    // response timing alone.
    await hash('timing-equalisation-dummy-value', OPTIONS).catch(() => undefined);
    return false;
  }
  try {
    return await verify(digest, plaintext, OPTIONS);
  } catch {
    return false;
  }
}

/** Constant-time comparison for tokens we hash ourselves. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
