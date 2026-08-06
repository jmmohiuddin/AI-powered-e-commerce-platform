import { GatewayError } from './gateway';

export interface RetryOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Injectable for tests; production uses a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Retry with exponential backoff and full jitter.
 *
 * WHY JITTER: without it, every client that failed during a gateway blip
 * retries at the same instant, and the retry storm keeps the gateway down. Full
 * jitter (`random() × delay`, not `delay ± random()`) spreads load most evenly
 * and is the variant AWS's own guidance recommends.
 *
 * WHY ONLY SOME ERRORS: a declined card retried three times is three declines,
 * three fraud-signal hits on the customer's issuer, and three seconds of a
 * shopper watching a spinner. Only transport failures and 5xx responses are
 * retried; anything the gateway answered definitively is final.
 *
 * IMPORTANT: this is safe only because every call site sends an idempotency
 * key. Retrying a non-idempotent charge is how a customer gets billed twice.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    attempts = 3,
    baseDelayMs = 200,
    maxDelayMs = 4_000,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts - 1) throw error;

      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      await sleep(Math.floor(random() * ceiling));
    }
  }

  throw lastError;
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof GatewayError) return error.retryable;
  if (error instanceof Error) {
    // Timeouts and connection resets are transport problems, not answers.
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
    const code = (error as NodeJS.ErrnoException).code;
    return (
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'ECONNREFUSED' ||
      code === 'EAI_AGAIN' ||
      code === 'UND_ERR_SOCKET'
    );
  }
  return false;
}

/**
 * Circuit breaker.
 *
 * When a gateway is comprehensively down, continuing to send it traffic wastes
 * a request slot and a customer's patience per attempt. After `threshold`
 * consecutive failures the breaker opens and calls fail immediately — the
 * checkout can then present a different payment method within milliseconds
 * instead of after a 15-second timeout. A single trial request after
 * `resetMs` closes it again.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly threshold = 5,
    private readonly resetMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  get isOpen(): boolean {
    if (this.openedAt === null) return false;
    if (this.now() - this.openedAt >= this.resetMs) {
      // Half-open: allow one trial call through.
      this.openedAt = null;
      this.failures = this.threshold - 1;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOpen) {
      throw new GatewayError('manual', 'circuit_open', 'Payment provider is unavailable', true);
    }
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      if (isRetryable(error)) this.recordFailure();
      throw error;
    }
  }
}
