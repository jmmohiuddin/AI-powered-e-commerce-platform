import { sql } from 'drizzle-orm';
import { uuidv7 } from '@voltix/db';
import type { Tx } from './types';

/**
 * GAP-FREE HUMAN-FACING NUMBERS
 *
 * Order numbers, credit note numbers and PO numbers are not primary keys — they
 * are what a customer quotes on the phone and what an auditor reconciles
 * against. Two properties matter, and a Postgres sequence gives neither:
 *
 *   • **Gapless.** `nextval` is deliberately non-transactional; it does not roll
 *     back. A checkout that fails after claiming a number burns it forever. UAE
 *     VAT record-keeping expects sequential, explicable invoice numbering, and
 *     "the transaction failed" is not an explanation an auditor accepts for a
 *     missing number.
 *   • **Per tenant.** Two merchants on the same platform must both be able to
 *     have order #1001.
 *
 * A counter row locked with `FOR UPDATE` inside the caller's transaction gives
 * both: if the order rolls back, so does the increment. The cost is serialising
 * number issuance per tenant per kind — one row lock held for microseconds.
 * At any realistic order rate that is not a bottleneck, and correctness here is
 * worth more than the throughput.
 *
 * `ON CONFLICT DO UPDATE` rather than a read-then-insert, so two concurrent
 * first-ever orders for a new tenant cannot both try to create the row.
 */
export async function nextNumber(
  tx: Tx,
  tenantId: string,
  kind: 'order' | 'return' | 'purchase_order' | 'invoice',
  options: { period?: string; prefix?: string; pad?: number; start?: number } = {},
): Promise<string> {
  const { period = '', prefix = '', pad = 5, start = 10_000 } = options;

  const result = await tx.execute<{ value: number }>(sql`
    INSERT INTO counters (id, tenant_id, kind, period, value, created_at, updated_at)
    VALUES (${uuidv7()}, ${tenantId}, ${kind}, ${period}, ${start + 1}, now(), now())
    ON CONFLICT (tenant_id, kind, period)
    DO UPDATE SET value = counters.value + 1, updated_at = now()
    RETURNING value
  `);

  const value = result.rows[0]?.value;
  if (value == null) throw new Error(`Could not allocate a ${kind} number`);

  return `${prefix}${String(value).padStart(pad, '0')}`;
}

/** `#10428` — what the customer quotes on the phone. */
export function orderNumber(tx: Tx, tenantId: string): Promise<string> {
  return nextNumber(tx, tenantId, 'order');
}

/** `RET-2026-0184` — returns are numbered per year, as merchants expect. */
export function returnNumber(tx: Tx, tenantId: string, year = new Date().getUTCFullYear()) {
  return nextNumber(tx, tenantId, 'return', {
    period: String(year),
    prefix: `RET-${year}-`,
    pad: 4,
    start: 0,
  });
}

export function purchaseOrderNumber(tx: Tx, tenantId: string, year = new Date().getUTCFullYear()) {
  return nextNumber(tx, tenantId, 'purchase_order', {
    period: String(year),
    prefix: `PO-${year}-`,
    pad: 4,
    start: 0,
  });
}
