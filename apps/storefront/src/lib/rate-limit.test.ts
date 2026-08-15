import { afterEach, describe, expect, it, vi } from 'vitest';

// `clientIdentifier` needs a request scope that does not exist in a unit test;
// the limiter itself does not, and that is the part with the logic in it.
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

async function limiterWithoutRedis() {
  vi.resetModules();
  vi.stubEnv('REDIS_URL', '');
  return import('./rate-limit');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('order lookup limiter', () => {
  it('allows a handful of genuine lookups and then stops the walk', async () => {
    const { limitOrderLookup } = await limiterWithoutRedis();

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const verdict = await limitOrderLookup('203.0.113.9');
      expect(verdict.allowed, `attempt ${attempt}`).toBe(true);
    }

    const blocked = await limitOrderLookup('203.0.113.9');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts per caller, so one enumerator cannot lock everyone out', async () => {
    const { limitOrderLookup } = await limiterWithoutRedis();

    for (let attempt = 1; attempt <= 11; attempt += 1) await limitOrderLookup('203.0.113.9');

    await expect(limitOrderLookup('198.51.100.4')).resolves.toMatchObject({ allowed: true });
  });

  it('keeps its own budget separate from search', async () => {
    const { limitOrderLookup, limitSearch } = await limiterWithoutRedis();

    for (let attempt = 1; attempt <= 11; attempt += 1) await limitOrderLookup('203.0.113.9');

    await expect(limitSearch('203.0.113.9')).resolves.toMatchObject({ allowed: true });
  });
});

describe('search limiter', () => {
  it('is loose enough for a person and tight enough for a scraper', async () => {
    const { limitSearch } = await limiterWithoutRedis();

    for (let attempt = 1; attempt <= 60; attempt += 1) {
      expect((await limitSearch('203.0.113.9')).allowed, `attempt ${attempt}`).toBe(true);
    }

    await expect(limitSearch('203.0.113.9')).resolves.toMatchObject({ allowed: false });
  });
});

describe('when the counter store is unreachable', () => {
  /**
   * A REDIS_URL pointing at a closed port is the honest way to exercise this:
   * the connection is refused, `consume` catches, and the two policies must
   * then disagree — search stays open, order lookup shuts.
   */
  async function limiterWithBrokenRedis() {
    vi.resetModules();
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:1');
    return import('./rate-limit');
  }

  it('denies order lookup — an enumeration oracle must not fail open', async () => {
    const { limitOrderLookup } = await limiterWithBrokenRedis();
    const verdict = await limitOrderLookup('203.0.113.9');

    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('allows search — losing the front door costs more than the scraping', async () => {
    const { limitSearch } = await limiterWithBrokenRedis();

    await expect(limitSearch('203.0.113.9')).resolves.toMatchObject({ allowed: true });
  });
});
