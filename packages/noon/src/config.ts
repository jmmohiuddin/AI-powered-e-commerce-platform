/**
 * noon Partner API credentials and endpoint configuration.
 *
 * WHAT NOON ACTUALLY ISSUES
 * -------------------------
 * The Partner Portal does not hand out an API key/secret pair. A service
 * account of type `apijwt` produces a JSON file containing three fields:
 *
 *   { "key_id": "...", "private_key": "-----BEGIN PRIVATE KEY-----...",
 *     "project_code": "..." }
 *
 * `private_key` is an RSA private key in PKCS#8 PEM. It is used to *sign* a
 * short-lived assertion (see auth.ts); it is never transmitted. That is the
 * whole reason this file goes to some length to keep it off disk-adjacent
 * surfaces and out of error messages: unlike a bearer secret, a leaked signing
 * key cannot be rotated by the holder noticing unusual traffic — it mints
 * valid credentials silently until someone revokes the key in the portal.
 *
 * TWO WAYS TO SUPPLY IT
 * ---------------------
 * `NOON_CREDENTIALS_FILE` points at the downloaded JSON. Preferred in
 * development, where the file is already on disk and keeping a multi-line PEM
 * in `.env` is miserable.
 *
 * `NOON_KEY_ID` / `NOON_PRIVATE_KEY` / `NOON_PROJECT_CODE` supply the same
 * three values inline. Required on Vercel and in CI, which have environment
 * variables but no filesystem to put a credentials file on. The PEM's newlines
 * may be written as literal `\n`, because most secret managers mangle real
 * ones — `normalisePem` puts them back.
 */

import { readFileSync } from 'node:fs';

/** Production gateway. Every service is mounted under its own path prefix. */
export const NOON_PRODUCTION_URL = 'https://noon-api-gateway.noon.partners';

/**
 * Sandbox gateway. Serves fixed, non-destructive fixtures — a stock update
 * here does not touch a live listing. Point `NOON_API_BASE_URL` at this while
 * building, because the alternative first integration test is one that
 * zeroes the quantity on a product that is currently for sale.
 */
export const NOON_SANDBOX_URL = 'https://sandbox-api-gateway.noon.partners';

export interface NoonCredentials {
  /** Service account identifier. Becomes the `sub` claim of the signed JWT. */
  readonly keyId: string;
  /** RSA private key, PKCS#8 PEM. Signs the login assertion; never sent. */
  readonly privateKey: string;
  /** Scopes the session to one seller project. */
  readonly projectCode: string;
}

export interface NoonConfig {
  readonly credentials: NoonCredentials;
  readonly baseUrl: string;
  /**
   * noon requires a User-Agent and uses it to attribute traffic when a rate
   * limit is tripped. An anonymous default makes "which of your integrations
   * is hammering us" unanswerable, so this identifies the app by name.
   */
  readonly userAgent: string;
  readonly timeoutMs: number;
}

class MissingCredentialError extends Error {
  constructor(detail: string) {
    super(
      `[@voltix/noon] ${detail}\n` +
        `  → Partner Portal → User & Access → Project users → +Add new → Service account\n` +
        `    Type: apijwt, Role: Project Owner, then download the credentials JSON.\n` +
        `  → Set NOON_CREDENTIALS_FILE to its path, or set NOON_KEY_ID,\n` +
        `    NOON_PRIVATE_KEY and NOON_PROJECT_CODE.`,
    );
    this.name = 'MissingCredentialError';
  }
}

/**
 * Secret managers, `.env` parsers and JSON all disagree about newlines in a
 * PEM. Accept the two encodings that actually occur and reject anything that
 * is not a private key, because the failure mode otherwise is an opaque
 * "error:1E08010C:DECODER routines::unsupported" from OpenSSL at first login.
 */
function normalisePem(raw: string): string {
  const pem = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
  const trimmed = pem.trim();
  if (!trimmed.startsWith('-----BEGIN')) {
    throw new MissingCredentialError(
      'NOON_PRIVATE_KEY does not look like a PEM private key ' +
        '(expected it to start with "-----BEGIN").',
    );
  }
  return trimmed;
}

function fromFile(path: string): NoonCredentials {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (cause) {
    // The message deliberately names the path but never the contents: this
    // throw site is one `console.error` away from a log aggregator.
    throw new MissingCredentialError(
      `Could not read the credentials file at ${path}: ${(cause as Error).message}`,
    );
  }

  const keyId = parsed.key_id;
  const privateKey = parsed.private_key;
  const projectCode = parsed.project_code;

  if (typeof keyId !== 'string' || typeof privateKey !== 'string' || typeof projectCode !== 'string') {
    throw new MissingCredentialError(
      `The credentials file at ${path} is missing one of key_id, private_key or project_code.`,
    );
  }

  return { keyId, privateKey: normalisePem(privateKey), projectCode };
}

function fromEnvironment(env: NodeJS.ProcessEnv): NoonCredentials {
  const keyId = env.NOON_KEY_ID?.trim();
  const privateKey = env.NOON_PRIVATE_KEY;
  const projectCode = env.NOON_PROJECT_CODE?.trim();

  if (!keyId || !privateKey || !projectCode) {
    const missing = [
      !keyId && 'NOON_KEY_ID',
      !privateKey && 'NOON_PRIVATE_KEY',
      !projectCode && 'NOON_PROJECT_CODE',
    ].filter(Boolean);
    throw new MissingCredentialError(`Missing ${missing.join(', ')}.`);
  }

  return { keyId, privateKey: normalisePem(privateKey), projectCode };
}

export function loadNoonConfig(env: NodeJS.ProcessEnv = process.env): NoonConfig {
  const file = env.NOON_CREDENTIALS_FILE?.trim();
  const credentials = file ? fromFile(file) : fromEnvironment(env);

  return {
    credentials,
    baseUrl: (env.NOON_API_BASE_URL?.trim() || NOON_PRODUCTION_URL).replace(/\/+$/, ''),
    userAgent: env.NOON_USER_AGENT?.trim() || 'VoltixCommerce/0.1 (+https://voltix.ae)',
    timeoutMs: Number.parseInt(env.NOON_API_TIMEOUT_MS?.trim() || '20000', 10),
  };
}

/**
 * True when the integration is pointed at production. The sync engine calls
 * this before it is allowed to mutate a live listing from a non-production
 * deployment — see `assertSafeTarget` in sync/guards.ts.
 */
export function isProductionTarget(config: NoonConfig): boolean {
  return config.baseUrl === NOON_PRODUCTION_URL;
}
