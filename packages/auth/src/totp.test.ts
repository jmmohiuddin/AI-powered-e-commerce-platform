import { describe, expect, it, beforeAll } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  fromBase32,
  generateTotpSecret,
  toBase32,
  totpUri,
  verifyTotp,
} from './totp';

/**
 * The TOTP tests check against RFC 6238's published vectors, not against this
 * implementation's own output. That distinction is the whole point: a test that
 * generates the expected code by calling the code under test proves the
 * function is deterministic and nothing else. It would pass just as happily on
 * a broken truncation step.
 */
describe('TOTP (RFC 6238)', () => {
  // RFC 6238 Appendix B uses the ASCII seed "12345678901234567890" for SHA-1.
  const RFC_SECRET = toBase32(Buffer.from('12345678901234567890', 'ascii'));

  // Time, expected code — straight from the RFC's table.
  const VECTORS: ReadonlyArray<[number, string]> = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];

  it.each(VECTORS)('matches the published vector at t=%i', (seconds, expected) => {
    expect(verifyTotp(RFC_SECRET, expected, seconds * 1000)).toBe(true);
  });

  it('rejects a code from a window that is too far in the past', () => {
    // 59s is a valid vector; five minutes later it must be dead. This is the
    // test that would catch a drift window accidentally widened to "any".
    expect(verifyTotp(RFC_SECRET, '287082', (59 + 300) * 1000)).toBe(false);
  });

  it('accepts one window of clock drift in both directions', () => {
    // The phone is 30s fast, then 30s slow. Both must work — this tolerance is
    // the difference between MFA that people use and MFA that people disable.
    expect(verifyTotp(RFC_SECRET, '287082', (59 - 30) * 1000)).toBe(true);
    expect(verifyTotp(RFC_SECRET, '287082', (59 + 30) * 1000)).toBe(true);
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '  ', '00000O']) {
      expect(verifyTotp(RFC_SECRET, bad, 59_000)).toBe(false);
    }
  });

  it('rejects every wrong 6-digit code at a fixed instant', () => {
    // A weak truncation or a modulo bug tends to make many codes valid. Sweeping
    // a thousand neighbours around the correct one would catch that.
    let accepted = 0;
    for (let i = 0; i < 1000; i += 1) {
      const code = String((287082 + i) % 1_000_000).padStart(6, '0');
      if (verifyTotp(RFC_SECRET, code, 59_000)) accepted += 1;
    }
    expect(accepted).toBe(1);
  });

  it('round-trips base32 for arbitrary byte lengths', () => {
    for (let length = 1; length <= 32; length += 1) {
      const bytes = Buffer.alloc(length, length);
      expect(fromBase32(toBase32(bytes)).subarray(0, length)).toEqual(bytes);
    }
  });

  it('builds a scannable otpauth URI', () => {
    const uri = totpUri('JBSWY3DPEHPK3PXP', 'amal@voltix.ae');
    expect(uri).toContain('otpauth://totp/Voltix%3Aamal%40voltix.ae');
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    // Authenticator apps default to SHA1/6/30 but Microsoft Authenticator has
    // historically mis-scanned URIs that omit them. Stating them is free.
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('TOTP secret encryption', () => {
  beforeAll(() => {
    process.env.AUTH_SECRET = 'test-only-secret-of-at-least-32-characters';
  });

  it('round-trips a secret', () => {
    const secret = generateTotpSecret();
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it('produces a different ciphertext each time', () => {
    // A reused IV under GCM is catastrophic — it leaks the XOR of two
    // plaintexts and, worse, the authentication key. Two identical ciphertexts
    // for the same input is the visible symptom.
    const secret = generateTotpSecret();
    expect(encryptSecret(secret)).not.toBe(encryptSecret(secret));
  });

  it('refuses a tampered ciphertext rather than returning garbage', () => {
    const stored = encryptSecret('JBSWY3DPEHPK3PXP');
    const [version, iv, ciphertext, tag] = stored.split('.');
    const flipped = Buffer.from(ciphertext ?? '', 'base64url');
    flipped.writeUInt8(flipped.readUInt8(0) ^ 0xff, 0);
    const tampered = [version, iv, flipped.toString('base64url'), tag].join('.');
    expect(decryptSecret(tampered)).toBeNull();
  });

  it('returns null for a value it cannot parse', () => {
    for (const bad of ['', 'garbage', 'v2.a.b.c', 'v1.only.two']) {
      expect(decryptSecret(bad)).toBeNull();
    }
  });

  it('refuses to encrypt when AUTH_SECRET is too weak', () => {
    const previous = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = 'short';
    expect(() => encryptSecret('x')).toThrow(/AUTH_SECRET/);
    process.env.AUTH_SECRET = previous;
  });
});
