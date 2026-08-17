import type { Database } from '@voltix/db';

/**
 * The transaction handle every sync function takes.
 *
 * Same convention as @voltix/commerce: the caller owns the transaction
 * boundary. Declared from @voltix/db rather than imported from commerce
 * because the dependency runs the other way — commerce's job runner registers
 * these handlers, so this package must not import it.
 */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * What one sync pass did.
 *
 * `rejected` is reported separately from `failed` on purpose. A rejection is
 * noon refusing one item with a reason — actionable by the operator, and not
 * a retry candidate. A failure is the call not completing — nobody's fault yet
 * and worth retrying. Collapsing them into one number is how a catalogue with
 * 40 permanently malformed listings looks identical to a network outage.
 */
export interface SyncOutcome {
  /** Items whose state already matched noon's. No call was made for these. */
  readonly skipped: number;
  readonly accepted: number;
  readonly rejected: Array<{ key: string; reason: string }>;
  /** Batches that failed at transport level and will be retried. */
  readonly failedBatches: number;
}

export function emptyOutcome(): SyncOutcome {
  return { skipped: 0, accepted: 0, rejected: [], failedBatches: 0 };
}

export function mergeOutcomes(a: SyncOutcome, b: SyncOutcome): SyncOutcome {
  return {
    skipped: a.skipped + b.skipped,
    accepted: a.accepted + b.accepted,
    rejected: [...a.rejected, ...b.rejected],
    failedBatches: a.failedBatches + b.failedBatches,
  };
}
