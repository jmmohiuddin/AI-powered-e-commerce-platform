/**
 * Authentication and transport for the noon Partner API.
 *
 * THE FLOW
 * --------
 * 1. Sign a short-lived RS256 JWT with the service account's private key.
 *    Claims: `sub` = key_id, `iat` = now, `jti` = a fresh UUID.
 * 2. POST it to `/identity/public/v1/api/login` with the project code.
 * 3. noon replies with `Set-Cookie`. Every subsequent call carries those
 *    cookies. There is no bearer token and no refresh token.
 *
 * WHY THE JWT IS NOT THE CREDENTIAL
 * ---------------------------------
 * The signed assertion is spent at login and never sent again — it exists to
 * prove possession of the private key without transmitting it. `jti` and `iat`
 * make each one single-use and short-lived, so capturing one in a proxy log
 * buys an attacker nothing. This is why the client signs a new assertion on
 * every login rather than caching one.
 *
 * WHY SESSIONS ARE REFRESHED REACTIVELY
 * -------------------------------------
 * noon documents no cookie lifetime. Anything this client believed about
 * expiry would be a guess that silently rots when they change it, so instead
 * the session is treated as valid until the server says otherwise: a 401 on
 * any call triggers exactly one re-login and one replay. If the replay also
 * 401s, the key is genuinely rejected and the error surfaces.
 */

import { createSign, randomUUID } from 'node:crypto';
import type { NoonConfig } from './config.js';
import { NoonApiError } from './errors.js';

const LOGIN_PATH = '/identity/public/v1/api/login';

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

/**
 * Builds the RS256 assertion noon's login endpoint expects.
 *
 * Hand-rolled with `node:crypto` rather than pulling in `jsonwebtoken`. The
 * payload is three claims and the signature is one `createSign` call; a
 * dependency here would add a transitive tree to a package that handles a
 * signing key, for no benefit.
 */
export function createLoginAssertion(
  keyId: string,
  privateKey: string,
  now: Date = new Date(),
): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      sub: keyId,
      iat: Math.floor(now.getTime() / 1000),
      jti: randomUUID(),
    }),
  );

  const signingInput = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey);

  return `${signingInput}.${base64url(signature)}`;
}

/**
 * Reduces a `Set-Cookie` response to the `Cookie` request header.
 *
 * Only the `name=value` pair before the first `;` is kept — the attributes
 * (Path, HttpOnly, Secure, Expires) are instructions to a browser, and echoing
 * them back in a request header is malformed.
 */
export function cookieHeaderFrom(response: Response): string {
  const setCookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter((value): value is string => Boolean(value));

  return setCookies.map((cookie) => cookie.split(';')[0]).join('; ');
}

export interface RequestOptions {
  /** Appended to the path as a query string. Omitted when empty. */
  readonly query?: Record<string, string | undefined>;
}

/**
 * An authenticated connection to one noon project.
 *
 * Holds the session cookie and knows how to re-establish it. Construct one per
 * process and share it: each instance is a login, and logins are rate-limited
 * alongside everything else at 1,500 requests per 60 seconds.
 */
export class NoonSession {
  private cookie: string | null = null;

  /**
   * In-flight login, shared by every caller that arrives while it is running.
   *
   * Without this, a worker that claims ten jobs at once cold-starts ten
   * simultaneous logins, nine of which are wasted and any of which may land
   * last and overwrite a newer cookie with an older one.
   */
  private loginInFlight: Promise<void> | null = null;

  constructor(private readonly config: NoonConfig) {}

  /** Exposed for tests and for the `whoami` health check. */
  get isAuthenticated(): boolean {
    return this.cookie !== null;
  }

  private async login(): Promise<void> {
    if (this.loginInFlight) return this.loginInFlight;

    this.loginInFlight = (async () => {
      const { keyId, privateKey, projectCode } = this.config.credentials;
      const response = await this.fetchRaw(LOGIN_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: createLoginAssertion(keyId, privateKey),
          default_project_code: projectCode,
        }),
      });

      if (!response.ok) {
        throw new NoonApiError(
          `noon login failed with HTTP ${response.status}`,
          response.status,
          await safeBody(response),
          LOGIN_PATH,
        );
      }

      const cookie = cookieHeaderFrom(response);
      if (!cookie) {
        // A 200 with no Set-Cookie means every later call would 401 in a loop.
        // Failing here points at the real problem instead.
        throw new NoonApiError(
          'noon login returned 200 but set no session cookie',
          response.status,
          null,
          LOGIN_PATH,
        );
      }
      this.cookie = cookie;
    })().finally(() => {
      this.loginInFlight = null;
    });

    return this.loginInFlight;
  }

  private async fetchRaw(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      return await fetch(`${this.config.baseUrl}${path}`, {
        ...init,
        headers: {
          'User-Agent': this.config.userAgent,
          Accept: 'application/json',
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: controller.signal,
      });
    } catch (cause) {
      const aborted = (cause as Error).name === 'AbortError';
      throw new NoonApiError(
        aborted
          ? `noon request to ${path} timed out after ${this.config.timeoutMs}ms`
          : `noon request to ${path} failed: ${(cause as Error).message}`,
        0,
        null,
        path,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * POSTs JSON to a gateway path and returns the decoded body.
   *
   * Most noon endpoints are POSTs, including the collection reads — their
   * filters travel in the body rather than the query string.
   */
  post<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    return this.call<T>('POST', path, body, options);
  }

  /** GET, for the few single-resource reads that take their key in the path. */
  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.call<T>('GET', path, undefined, options);
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    options: RequestOptions,
  ): Promise<T> {
    const url = `${path}${buildQuery(options.query)}`;

    if (!this.cookie) await this.login();

    let response = await this.send(method, url, body);

    // One re-login, one replay. See the note at the top of this file.
    if (response.status === 401) {
      this.cookie = null;
      await this.login();
      response = await this.send(method, url, body);
    }

    if (!response.ok) {
      throw new NoonApiError(
        `noon ${url} responded with HTTP ${response.status}`,
        response.status,
        await safeBody(response),
        url,
      );
    }

    return (await response.json()) as T;
  }

  private send(method: 'GET' | 'POST', url: string, body: unknown): Promise<Response> {
    return this.fetchRaw(url, {
      method,
      headers: {
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
  }
}

function buildQuery(query: Record<string, string | undefined> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

/** Reads an error body without letting a malformed one mask the real status. */
async function safeBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    try {
      return await response.text();
    } catch {
      return null;
    }
  }
}
