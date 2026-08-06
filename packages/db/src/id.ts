import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 — time-ordered, globally unique identifiers.
 *
 * Layout (RFC 9562):
 *   48 bits  unix_ts_ms
 *    4 bits  version (0b0111)
 *   12 bits  rand_a  — sub-millisecond counter for monotonicity
 *    2 bits  variant (0b10)
 *   62 bits  rand_b
 *
 * WHY NOT v4: random UUIDs scatter B-tree inserts across the whole index. On a
 * table like `analytics_events` or `order_events` that means every insert dirties
 * a different page, write amplification climbs, and the index no longer fits the
 * working set in cache. v7 appends to the right edge like a sequence while
 * staying unguessable.
 *
 * WHY NOT bigserial: sequential integers leak business volume (order #1042 today
 * and #1109 next week tells a competitor your weekly throughput) and make
 * multi-region / offline-first writes require coordination.
 *
 * WHY NOT nanoid/cuid: Postgres has a native 16-byte `uuid` type. A 21-char text
 * id costs more storage, more index space, and loses type-level validation.
 *
 * The 12-bit counter guarantees strict monotonicity within a millisecond, so ids
 * generated in a tight loop still sort in creation order. On counter exhaustion
 * (>4096 ids in one millisecond in one process) we spill into the next
 * millisecond rather than emit an out-of-order id.
 */

let lastTimestamp = -1;
let counter = 0;

export function uuidv7(): string {
  let now = Date.now();

  if (now === lastTimestamp) {
    counter += 1;
    if (counter > 0xfff) {
      // Counter exhausted for this millisecond. Borrow from the next one; this
      // keeps ordering strict at the cost of ids being at most a few ms "early".
      now = lastTimestamp + 1;
      lastTimestamp = now;
      counter = 0;
    }
  } else if (now > lastTimestamp) {
    lastTimestamp = now;
    counter = 0;
  } else {
    // Clock moved backwards (NTP correction). Never emit a regressing id.
    now = lastTimestamp;
    counter += 1;
  }

  const bytes = new Uint8Array(16);

  // 48-bit big-endian timestamp.
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  // Version 7 in the high nibble of byte 6, counter in the remaining 12 bits.
  bytes[6] = 0x70 | ((counter >>> 8) & 0x0f);
  bytes[7] = counter & 0xff;

  const rand = randomBytes(8);
  bytes.set(rand, 8);
  // RFC 9562 variant bits: 10xxxxxx.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Extracts the creation timestamp back out of a v7 id. Handy in support tools. */
export function uuidv7Timestamp(id: string): Date {
  const hex = id.replace(/-/g, '').slice(0, 12);
  return new Date(Number.parseInt(hex, 16));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Human-facing sequential references (order #10428, PO-2026-0184).
 *
 * These are *display* identifiers only, never keys. The sequence lives in
 * Postgres per tenant so gaps and duplicates are impossible under concurrency;
 * this helper only does the formatting.
 */
export function formatOrderNumber(sequence: number, prefix = ''): string {
  return `${prefix}${String(sequence).padStart(5, '0')}`;
}

export function formatDocumentNumber(kind: string, year: number, sequence: number): string {
  return `${kind}-${year}-${String(sequence).padStart(4, '0')}`;
}
