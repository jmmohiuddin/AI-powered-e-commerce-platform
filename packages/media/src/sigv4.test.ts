import { describe, expect, it } from 'vitest';
import { amzDate, canonicalQuery, canonicalUri, deriveSigningKey, sha256Hex, signRequest } from './sigv4';

/**
 * What this file can and cannot prove.
 *
 * The pieces with published correct answers — the key derivation vector, the
 * encoding rules, the empty-payload hash — are asserted against those answers
 * rather than against whatever the code currently emits, because a test written
 * from the implementation passes just as happily when the implementation is
 * wrong.
 *
 * A complete end-to-end signature is not asserted here: AWS's `get-vanilla`
 * vector signs a request without `x-amz-content-sha256`, which every S3 request
 * this module makes carries, so matching it would mean testing a code path we
 * never take. The authoritative check on the assembled signature is a real PUT
 * against MinIO — see storage.integration.test.ts and docs/08-media.md.
 */
const AWS_EXAMPLE = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 's3',
} as const;

describe('sigv4', () => {
  it('derives the signing key AWS publishes for the reference credentials', () => {
    // Vector from the AWS SigV4 documentation ("Examples of how to derive a
    // signing key"), service `iam`, date 20150830.
    const key = deriveSigningKey(AWS_EXAMPLE.secretAccessKey, '20150830', 'us-east-1', 'iam');
    expect(key.toString('hex')).toBe(
      'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9',
    );
  });

  it('hashes an empty payload to the documented constant', () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('encodes path segments but never the separators', () => {
    expect(canonicalUri('/bucket/products/a b.jpg')).toBe('/bucket/products/a%20b.jpg');
    // encodeURIComponent leaves these alone; AWS does not.
    expect(canonicalUri("/bucket/o'brien(1).jpg")).toBe('/bucket/o%27brien%281%29.jpg');
  });

  it('sorts query parameters by name', () => {
    expect(canonicalQuery(new URLSearchParams('b=2&a=1&c=3'))).toBe('a=1&b=2&c=3');
    expect(canonicalQuery(new URLSearchParams())).toBe('');
  });

  it('formats the timestamp without separators or milliseconds', () => {
    expect(amzDate(new Date(Date.UTC(2026, 7, 14, 9, 15, 0, 123)))).toBe('20260814T091500Z');
  });

  it('signs the scope, the body and the caller’s headers', () => {
    const at = new Date(Date.UTC(2026, 0, 1));
    const sign = (body: Uint8Array, headers: Record<string, string> = {}) =>
      signRequest(
        { method: 'PUT', url: 'http://localhost:9000/bucket/a.jpg', headers, body },
        AWS_EXAMPLE,
        at,
      );

    const plain = sign(new TextEncoder().encode('first'));
    expect(plain['x-amz-date']).toBe('20260101T000000Z');
    expect(plain['x-amz-content-sha256']).toBe(sha256Hex('first'));
    expect(plain.Authorization).toContain(
      'Credential=AKIDEXAMPLE/20260101/us-east-1/s3/aws4_request',
    );
    expect(plain.Authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date');

    // A different body must not reuse a signature — the payload hash is inside
    // the canonical request precisely so it cannot.
    expect(sign(new TextEncoder().encode('second')).Authorization).not.toBe(plain.Authorization);

    const typed = sign(new TextEncoder().encode('first'), { 'content-type': 'image/jpeg' });
    expect(typed.Authorization).toContain(
      'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date',
    );
  });
});
