import 'server-only';
import { createClient, type RedisClientType } from 'redis';
import { headers } from 'next/headers';

/**
 * RATE LIMITING FOR UNAUTHENTICATED ENDPOINTS
 *
 * Two public surfaces need throttling for different reasons.
 *
 * Order tracking (`/orders`) is the serious one — audit risk R-08 / threat
 * T-05, requirement F-06. It takes an order number and a phone over GET, and
 * order numbers are sequential *by design* because a merchant needs gap-free
 * numbering for accounting. Without a limit it is an oracle: fix a phone, walk
 * the numbers, and confirm which orders that person placed.
 *
 * Search is the cheap one — it is unauthenticated, hits hybrid retrieval, and
 * a scraper can make it the most expensive query in the system.
 *
 * FIXED WINDOWS, NOT SLIDING. A fixed window lets a caller spend two windows'
 * worth of budget across a boundary. That is the correct trade here: the cost
 * is one counter and one expiry per window, and the attack this defends against
 * is a sustained walk of thousands of order numbers, not a burst of twenty.
 */

/** Fails closed. Denying a genuine "where is my order" is recoverable; handing
 *  an enumeration oracle an unlimited budget because Redis blinked is not. */
const ORDER_LOOKUP = { limit: 10, windowMs: 10 * 60_000, failOpen: false } as const;

/** Fails open. Search is the store's front door — a limiter outage that takes
 *  browsing offline costs more than the scraping it would have prevented, and
 *  unlike order lookup a flood of searches leaks nothing. */
const SEARCH = { limit: 60, windowMs: 60_000, failOpen: true } as const;

export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** Seconds until the caller may retry. Zero when allowed. */
  readonly retryAfterSeconds: number;
}

const ALLOWED: RateLimitVerdict = { allowed: true, retryAfterSeconds: 0 };

export function limitOrderLookup(identifier: string): Promise<RateLimitVerdict> {
  return consume('orders', identifier, ORDER_LOOKUP);
}

export function limitSearch(identifier: string): Promise<RateLimitVerdict> {
  return consume('search', identifier, SEARCH);
}

/**
 * Who is asking.
 *
 * The left-most `x-forwarded-for` entry is the client as reported by the first
 * proxy. It is spoofable by anyone talking to the app directly, which is why
 * this must sit behind a proxy that overwrites the header — a limiter keyed on
 * a header the client controls is decoration. Documented in docs/07-security.md
 * rather than defended here, because the fix belongs at the edge.
 *
 * A request with no forwarded address at all shares one bucket. That is
 * deliberate: unidentifiable callers should compete for the same budget rather
 * than each receiving a fresh one.
 */
export async function clientIdentifier(): Promise<string> {
  const store = await headers();
  const forwarded = store.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || store.get('x-real-ip')?.trim() || 'unidentified';
}

interface Policy {
  readonly limit: number;
  readonly windowMs: number;
  readonly failOpen: boolean;
}

async function consume(bucket: string, identifier: string, policy: Policy) {
  const key = `voltix:rl:${bucket}:${identifier}`;
  try {
    const { count, ttlMs } = REDIS_URL
      ? await redisIncrement(key, policy.windowMs)
      : inProcessIncrement(key, policy.windowMs);

    if (count <= policy.limit) return ALLOWED;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)) };
  } catch (error) {
    console.error(`[rate-limit] ${bucket} counter unavailable:`, (error as Error).message);
    return policy.failOpen
      ? ALLOWED
      : { allowed: false, retryAfterSeconds: Math.ceil(policy.windowMs / 1000) };
  }
}

/* ──────────────────────── In-process counters ───────────────────────── */

/**
 * The single-instance fallback, used when `REDIS_URL` is unset.
 *
 * Correct for `npm run dev` and for a one-container deployment; wrong the
 * moment there are two replicas, where each holds its own counter and the
 * effective limit multiplies by the replica count. Redis is what makes the
 * limit a property of the store rather than of one process — hence preferred
 * whenever it is configured.
 */
const counters = new Map<string, { count: number; expiresAt: number }>();

function inProcessIncrement(key: string, windowMs: number): { count: number; ttlMs: number } {
  const now = Date.now();

  // Swept on write rather than on a timer: a timer keeps the process alive and
  // holds every key it has ever seen, which is a memory leak with a heartbeat.
  if (counters.size > 10_000) {
    for (const [k, v] of counters) if (v.expiresAt <= now) counters.delete(k);
  }

  const existing = counters.get(key);
  if (existing && existing.expiresAt > now) {
    existing.count += 1;
    return { count: existing.count, ttlMs: existing.expiresAt - now };
  }

  counters.set(key, { count: 1, expiresAt: now + windowMs });
  return { count: 1, ttlMs: windowMs };
}

/* ──────────────────────────── Redis counters ────────────────────────── */

const REDIS_URL = process.env.REDIS_URL;

/** Connect and command budgets. A limiter that stalls a page render for the
 *  TCP default of ~75s has become the outage it exists to prevent. */
const CONNECT_TIMEOUT_MS = 1_000;
const COMMAND_TIMEOUT_MS = 500;

/**
 * `INCR` then `PEXPIRE … NX`, pipelined.
 *
 * `NX` is what makes the window fixed: the expiry is set by whichever request
 * created the key and never pushed out by later ones. Without it every hit
 * would extend the window, and a caller at one request per second would stay
 * blocked forever after their first breach.
 *
 * Pipelined rather than wrapped in a Lua script so this stays legible and needs
 * no `SCRIPT LOAD` handshake; the interleaving risk is limited to a key that
 * expires between the two commands, which costs at most one over-counted hit.
 *
 * `execAsPipeline` and not `exec`: `exec` wraps the batch in `MULTI`/`EXEC`,
 * and the atomicity that buys is not needed for three commands on one key —
 * only the round-trip saving is, and a pipeline is the cheaper way to get it.
 */
async function redisIncrement(
  key: string,
  windowMs: number,
): Promise<{ count: number; ttlMs: number }> {
  const client = await connection();
  const [count, , ttl] = await withTimeout(
    client.multi().incr(key).pExpire(key, windowMs, 'NX').pTTL(key).execAsPipeline(),
    COMMAND_TIMEOUT_MS,
    'redis command timed out',
  );

  if (typeof count !== 'number') throw new Error(`unexpected INCR reply: ${String(count)}`);
  // -1 (no expiry) and -2 (key gone) both mean the window is not knowable; the
  // configured window is the honest answer to give the caller.
  return { count, ttlMs: typeof ttl === 'number' && ttl > 0 ? ttl : windowMs };
}

/**
 * One connection per process, reconnected on failure.
 *
 * Held on `globalThis` because the dev server re-evaluates modules on every
 * edit, and a module-scoped socket would leak one connection per save until
 * Redis refuses new ones.
 *
 * `reconnectStrategy: false` plus eviction from this cache is what "reconnected
 * on failure" means here: node-redis does not retry in the background, the
 * failed client is dropped, and the next limiter call builds a fresh one. The
 * alternative — leaving node-redis to reconnect on its own — would hold callers
 * on a client that is known to be down, which is precisely the stall the
 * timeouts below exist to prevent.
 */
const CLIENT_KEY = Symbol.for('voltix.storefront.rateLimitRedis');
const globalStore = globalThis as unknown as Record<symbol, Promise<RedisClientType> | undefined>;

function connection(): Promise<RedisClientType> {
  const existing = globalStore[CLIENT_KEY];
  if (existing) return existing;

  // Only ever evicts *this* client. An unguarded reset would let a dying
  // connection drop the replacement that a later call had already installed.
  const evict = () => {
    if (globalStore[CLIENT_KEY] === pending) globalStore[CLIENT_KEY] = undefined;
  };

  const pending = connect(evict).catch((error: unknown) => {
    evict();
    throw error;
  });
  globalStore[CLIENT_KEY] = pending;
  return pending;
}

async function connect(evict: () => void): Promise<RedisClientType> {
  // Credentials and database number are parsed out of REDIS_URL by the client —
  // `redis[s]://[[user][:password]@]host[:port][/db]`. The AUTH and SELECT
  // handshake this file used to write by hand is the library's job now.
  const client: RedisClientType = createClient({
    url: REDIS_URL,
    socket: { connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy: false },
    // Without this, a command issued while the socket is down waits in memory
    // for a reconnection that `reconnectStrategy: false` has ruled out. Failing
    // the command immediately is what lets each policy apply its own verdict.
    disableOfflineQueue: true,
  });

  // node-redis is an EventEmitter, and an 'error' with no listener is rethrown
  // by Node as an uncaught exception — a limiter that takes the server down
  // with it is worse than no limiter. Listening also gives us the eviction
  // point that makes the next call reconnect.
  client.on('error', (error: Error) => {
    evict();
    console.error('[rate-limit] redis connection error:', error.message);
  });

  try {
    await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, 'redis connect timed out');
  } catch (error) {
    // Destroying is what stops a connect that timed out from completing later
    // and leaking a socket nothing holds a reference to.
    try {
      client.destroy();
    } catch {
      // Already closed, or never opened — nothing to release.
    }
    throw error;
  }

  return client;
}

/**
 * Why these timeouts are still applied by hand.
 *
 * node-redis has two timeout options and neither bounds a round trip:
 *
 *  - `socket.connectTimeout` covers the TCP handshake only. It is removed as
 *    soon as the socket emits 'connect' (see @redis/client socket.ts), so a
 *    server that accepts the connection and then never speaks RESP leaves
 *    `client.connect()` waiting on its HELLO reply forever. Measured against a
 *    black-hole listener: no rejection after 70s.
 *  - `commandOptions.timeout` is cancelled the moment a command is written to
 *    the socket (`#removeTimeoutListener` in commands-queue.ts), so it bounds
 *    time spent queued, not time spent waiting for a reply. `withAbortSignal`
 *    is dropped at the same point.
 *
 * `socket.socketTimeout` is the one that would fire on a silent reply, but it
 * is an *inactivity* timeout on the socket: at 500ms it would tear down a
 * perfectly healthy connection between two page views, since this limiter is
 * idle far longer than that in normal traffic.
 *
 * So the race stays. `connectTimeout` is still set — it fails a dead host
 * faster than this wrapper would — and this covers what it does not.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    // `unref` so a pending limiter check never keeps the process alive on its own.
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

/** Test seam — the in-process counters outlive a single test otherwise. */
export function __resetRateLimitForTests(): void {
  counters.clear();
}
