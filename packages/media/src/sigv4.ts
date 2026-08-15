import { createHash, createHmac } from 'node:crypto';

/**
 * AWS SIGNATURE V4, the small subset S3 object requests need.
 *
 * Hand-rolled rather than pulled from `@aws-sdk/client-s3`, which is ~40
 * transitive packages and a client abstraction we would use three methods of.
 * The signing algorithm is a fixed, published spec that has not changed since
 * 2012, and the whole of it that matters here is below. It is covered by the
 * AWS test vector in sigv4.test.ts and exercised end to end against MinIO.
 *
 * S3 specifics that are easy to get wrong and are deliberate here:
 *
 *  • The payload hash goes in `x-amz-content-sha256` *and* the canonical
 *    request. S3 rejects UNSIGNED-PAYLOAD over plain HTTP endpoints, so we
 *    always hash the body — uploads are a few hundred kilobytes, not streams.
 *  • Path segments are encoded once, and `/` is left alone. Encoding the
 *    separators produces a signature that matches nothing.
 *  • Header names are lowercased and sorted; values are trimmed. A stray
 *    capital in `Content-Type` is a SignatureDoesNotMatch that reads like a
 *    credentials problem.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';

export interface SigningCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  readonly service: string;
}

export interface SignableRequest {
  readonly method: string;
  /** Absolute URL, already including the bucket for path-style addressing. */
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array | undefined;
}

export function sha256Hex(input: Uint8Array | string): string {
  return createHash('sha256').update(input).digest('hex');
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * The four-step key derivation. Exported so it can be checked against AWS's
 * published vector — it is the part of the algorithm with no visible failure
 * mode short of a rejected request.
 */
export function deriveSigningKey(
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request');
}

/**
 * RFC 3986 encoding. `encodeURIComponent` leaves `!'()*` unescaped, and AWS
 * expects them escaped — a filename with an apostrophe would otherwise sign
 * correctly and be rejected.
 */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function canonicalUri(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => uriEncode(decodeURIComponent(segment)))
    .join('/');
}

export function canonicalQuery(search: URLSearchParams): string {
  return [...search.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** `20260814T091500Z`, the only timestamp format the signature accepts. */
export function amzDate(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

/**
 * Returns the headers to send, including `Authorization`.
 *
 * The caller's headers are merged rather than replaced so a `Content-Type` set
 * at the call site is signed along with everything else.
 */
export function signRequest(
  request: SignableRequest,
  credentials: SigningCredentials,
  now = new Date(),
): Record<string, string> {
  const url = new URL(request.url);
  const timestamp = amzDate(now);
  const date = timestamp.slice(0, 8);
  const scope = `${date}/${credentials.region}/${credentials.service}/aws4_request`;
  const payloadHash = sha256Hex(request.body ?? new Uint8Array());

  const headers: Record<string, string> = {
    ...request.headers,
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': timestamp,
  };

  const canonicalHeaderNames = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const lowered = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = canonicalHeaderNames
    .map((name) => `${name}:${(lowered.get(name) ?? '').trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = canonicalHeaderNames.join(';');

  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [ALGORITHM, timestamp, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = deriveSigningKey(
    credentials.secretAccessKey,
    date,
    credentials.region,
    credentials.service,
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    ...headers,
    Authorization:
      `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
