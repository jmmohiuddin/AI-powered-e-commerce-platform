/**
 * Error model for the noon Partner API.
 *
 * noon reports failure at two levels, and conflating them is the single
 * biggest correctness trap in this integration:
 *
 *   TRANSPORT — a non-2xx response. The whole batch failed. Retrying is
 *   usually right.
 *
 *   PER ITEM — an HTTP 200 whose body carries a `status` object *per item*.
 *   Some SKUs were accepted and some were rejected. Retrying the whole batch
 *   re-sends the accepted ones, and a naive `response.ok` check records the
 *   rejected ones as synced. That is how a listing sits at the wrong quantity
 *   for a week while the dashboard shows green.
 *
 * `NoonBatchResult` below forces the caller to look at both.
 */

/** noon's `Status` envelope — the gRPC/Google API error model. */
export interface NoonStatus {
  readonly status_id?: number;
  readonly status_code?: string;
  readonly message?: string;
  readonly details?: unknown[];
}

export class NoonApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 for a network/timeout failure. */
    readonly status: number,
    readonly body: unknown,
    /** The gateway path, for logs. Never includes credentials. */
    readonly path?: string,
  ) {
    super(message);
    this.name = 'NoonApiError';
  }

  /**
   * Whether the job queue should back off and try again rather than
   * dead-letter.
   *
   * 401 is retryable *once* because the session cookie expires with no
   * documented TTL — the client re-authenticates in place (see auth.ts) and
   * only surfaces a 401 here if the fresh session was rejected too, which
   * means the key itself is revoked. 429 and 5xx are the ordinary transient
   * cases. 0 is a timeout or DNS failure.
   *
   * 400/403/404 are deliberately *not* retryable: a malformed payload or a
   * SKU that does not exist will be just as malformed in five minutes, and
   * retrying it five times only delays the operator seeing the real error.
   */
  get isRetryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

/**
 * A per-item outcome from a batch endpoint.
 *
 * `ok` is derived from noon's status rather than assumed: the API returns
 * `status_code: "OK"` on success, and any other code — with a human message
 * beside it — on rejection.
 */
export interface NoonItemResult {
  readonly key: string;
  readonly ok: boolean;
  readonly statusCode: string;
  readonly message: string;
}

export interface NoonBatchResult {
  readonly accepted: NoonItemResult[];
  readonly rejected: NoonItemResult[];
}

/**
 * noon signals success with `status_code: "OK"`. A missing status object is
 * treated as success because several endpoints omit it entirely when nothing
 * went wrong; a present status with any other code is a rejection.
 */
export function isOkStatus(status: NoonStatus | undefined | null): boolean {
  if (!status) return true;
  if (status.status_code === undefined || status.status_code === null) {
    // Some services report numerically instead. 0 is the gRPC OK code.
    return status.status_id === undefined || status.status_id === 0;
  }
  return status.status_code.toUpperCase() === 'OK';
}

export function toItemResult(key: string, status: NoonStatus | undefined | null): NoonItemResult {
  const ok = isOkStatus(status);
  return {
    key,
    ok,
    statusCode: status?.status_code ?? (ok ? 'OK' : 'UNKNOWN'),
    message: status?.message ?? '',
  };
}

export function partitionResults(results: NoonItemResult[]): NoonBatchResult {
  const accepted: NoonItemResult[] = [];
  const rejected: NoonItemResult[] = [];
  for (const result of results) (result.ok ? accepted : rejected).push(result);
  return { accepted, rejected };
}
