import { afterAll, beforeEach, expect, it, vi, describe } from 'vitest';
import { createClient } from 'redis';

/**
 * The limiter against a real Redis.
 *
 * The unit suite exercises the in-process fallback, which shares the *shape* of
 * the Redis path but none of its mechanism: no pipeline, no `PEXPIRE … NX`, no
 * connection to lose. Those are exactly the parts that decide whether a limit
 * survives more than one replica, so they need the real server.
 *
 * `x-forwarded-for` never reaches here — `clientIdentifier` is the only caller
 * of `headers()` and these tests call the limiters directly.
 */
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const inspector = createClient({
  url: REDIS_URL,
  socket: { connectTimeout: 1_000, reconnectStrategy: false },
});
// An 'error' with no listener is rethrown by Node as an uncaught exception, and
// an unreachable Redis is the expected case here rather than a surprise.
inspector.on('error', () => {});

const reachable = await inspector
  .connect()
  .then(() => true)
  .catch(() => false);

const suite = reachable ? describe : describe.skip;
if (!reachable) console.warn('\n  ⚠ Redis unreachable — rate limiter integration tests skipped.\n');

afterAll(async () => {
  if (reachable) await inspector.close();
});

/** Fresh callers per test: a leftover counter from an earlier run would let a
 *  test pass or fail for reasons that have nothing to do with the code. */
let caller: string;
let other: string;

beforeEach(async () => {
  const run = Math.random().toString(36).slice(2, 10);
  caller = `203.0.113.9-${run}`;
  other = `198.51.100.4-${run}`;
  vi.resetModules();
  vi.stubEnv('REDIS_URL', REDIS_URL);
  if (reachable) await inspector.del([keyFor('orders', caller), keyFor('search', caller)]);
});

const keyFor = (bucket: string, identifier: string) => `voltix:rl:${bucket}:${identifier}`;

suite('order lookup against real Redis', () => {
  it('blocks the eleventh lookup and records the counter in Redis', async () => {
    const { limitOrderLookup } = await import('./rate-limit');

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const verdict = await limitOrderLookup(caller);
      expect(verdict.allowed, `attempt ${attempt}`).toBe(true);
    }

    const blocked = await limitOrderLookup(caller);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

    // The counter is in Redis rather than in this process — which is the whole
    // point of preferring it over the Map fallback.
    const key = keyFor('orders', caller);
    expect(await inspector.get(key)).toBe('11');
    expect(await inspector.pTTL(key)).toBeGreaterThan(0);
  });

  it('counts per caller, so one enumerator cannot lock everyone out', async () => {
    const { limitOrderLookup } = await import('./rate-limit');

    for (let attempt = 1; attempt <= 11; attempt += 1) await limitOrderLookup(caller);

    await expect(limitOrderLookup(other)).resolves.toMatchObject({ allowed: true });
    expect(await inspector.exists(keyFor('orders', other))).toBe(1);

    await inspector.del(keyFor('orders', other));
  });

  /**
   * The `NX` on `PEXPIRE` is the load-bearing bit.
   *
   * Without it every hit re-arms the expiry, so a caller making one request per
   * second never sees the window close: they breach once and stay blocked
   * forever. The expiry must belong to whichever request created the key, so
   * the TTL has to count *down* across hits, never jump back up.
   */
  it('does not extend the window on later hits', async () => {
    const { limitOrderLookup } = await import('./rate-limit');
    const key = keyFor('orders', caller);

    await limitOrderLookup(caller);
    const first = await inspector.pTTL(key);

    await new Promise((resolve) => setTimeout(resolve, 50));

    await limitOrderLookup(caller);
    const second = await inspector.pTTL(key);

    expect(second).toBeLessThan(first);
    expect(await inspector.get(key)).toBe('2');
  });
});

suite('search against real Redis', () => {
  it('keeps its own budget separate from order lookup', async () => {
    const { limitOrderLookup, limitSearch } = await import('./rate-limit');

    for (let attempt = 1; attempt <= 11; attempt += 1) await limitOrderLookup(caller);

    await expect(limitSearch(caller)).resolves.toMatchObject({ allowed: true });
    expect(await inspector.get(keyFor('search', caller))).toBe('1');
  });
});
