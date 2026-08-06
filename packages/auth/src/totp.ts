import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * TOTP — RFC 6238
 *
 * Implemented here rather than pulled in, and that is a deliberate exception to
 * "don't roll your own crypto". The rule exists because primitives are hard to
 * get right; TOTP is not a primitive. It is thirty lines of arithmetic wrapped
 * around HMAC-SHA1, which comes from Node's OpenSSL bindings. What we avoid is
 * a transitive dependency in the authentication path — the single worst place
 * in the codebase to inherit someone else's supply chain.
 *
 * SHA-1 is correct here, not a weakness. TOTP's security comes from the shared
 * secret and the 30-second window, and every authenticator app on a staff
 * member's phone speaks SHA-1. Choosing SHA-256 produces codes that Google
 * Authenticator silently fails to match.
 */

const DIGITS = 6;
const PERIOD_SECONDS = 30;

/**
 * Accept the previous and next window as well as the current one.
 *
 * ±1 step, not more. Phone clocks drift and people start typing at second 29,
 * so a strict single window produces a stream of "invalid code" complaints from
 * users doing everything right. Each extra window widens the brute-force
 * surface proportionally, so three is the usual balance — a 6-digit code with
 * three live windows still means 1 in ~333,000 per attempt, and the login
 * throttle caps attempts at five.
 */
const DRIFT_WINDOWS = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding — the format every authenticator app expects. */
export function toBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function fromBase32(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 20 bytes — the RFC 4226 recommended secret length for HMAC-SHA1. */
export function generateTotpSecret(): string {
  return toBase32(randomBytes(20));
}

function codeAt(secret: Buffer, counter: number): string {
  // 8-byte big-endian counter. BigInt rather than two 32-bit writes because
  // the naive version breaks in 2038 and nobody notices until it does.
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', secret).update(buffer).digest();
  // Dynamic truncation, RFC 4226 §5.3: the low nibble of the last byte picks
  // where to read, which is what stops the code being a fixed slice of the MAC.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

/**
 * Verifies a code against the secret.
 *
 * `now` is injectable so the tests can pin a counter and assert against the
 * RFC's published vectors instead of against whatever this function happens to
 * compute — a test that calls the implementation to derive its own expectation
 * proves only that the function is deterministic.
 */
export function verifyTotp(secretBase32: string, code: string, now = Date.now()): boolean {
  const clean = code.replace(/\D/g, '');
  if (clean.length !== DIGITS) return false;

  const secret = fromBase32(secretBase32);
  if (secret.length === 0) return false;

  const counter = Math.floor(now / 1000 / PERIOD_SECONDS);
  const candidate = Buffer.from(clean);

  // Every window is checked even after a match, so the running time does not
  // reveal *which* window succeeded. Leaking that leaks the phone's clock skew,
  // which is a small fingerprint but a free one to avoid.
  let matched = false;
  for (let drift = -DRIFT_WINDOWS; drift <= DRIFT_WINDOWS; drift += 1) {
    const step = counter + drift;
    // A counter below zero is only reachable in the first 30 seconds of the
    // Unix epoch or with a badly wrong system clock — but `writeBigUInt64BE`
    // *throws* on a negative value, which would turn a bad clock into a 500 on
    // the login endpoint instead of a rejected code.
    if (step < 0) continue;
    const expected = Buffer.from(codeAt(secret, step));
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) {
      matched = true;
    }
  }
  return matched;
}

/** The `otpauth://` URI an authenticator app scans. */
export function totpUri(secretBase32: string, account: string, issuer = 'Voltix'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ───────────────────────── Secret storage ───────────────────────── */

/**
 * The TOTP secret is encrypted at rest with AES-256-GCM.
 *
 * A password hash is one-way, so a database leak costs the attacker a cracking
 * campaign. A TOTP secret is symmetric: read it and you generate valid codes
 * forever, silently, and the victim's phone keeps showing the same numbers. So
 * plaintext here would mean the second factor adds nothing against exactly the
 * breach it is supposed to survive.
 *
 * The key is derived from AUTH_SECRET via HKDF rather than used directly, so
 * the same env value can back other purposes without any two of them sharing
 * key material.
 *
 * The honest limitation: the key lives in the application environment, so a
 * host compromise gets both halves. Beating that needs a KMS or an HSM, which
 * is the right upgrade at the point real money is flowing — see docs/05.
 */
function encryptionKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('AUTH_SECRET must be set to at least 32 characters to store TOTP secrets');
  }
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), 'voltix:totp:v1', 32));
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  // Versioned prefix so a future key rotation can tell old rows from new ones
  // instead of guessing from the field length.
  return ['v1', iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

export function decryptSecret(stored: string): string | null {
  const [version, iv, ciphertext, tag] = stored.split('.');
  if (version !== 'v1' || !iv || !ciphertext || !tag) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // A failed auth tag means the row was tampered with or the key changed.
    // Null, not a throw: the caller treats it as "MFA not usable" and the user
    // is sent to re-enrol rather than shown a stack trace.
    return null;
  }
}
