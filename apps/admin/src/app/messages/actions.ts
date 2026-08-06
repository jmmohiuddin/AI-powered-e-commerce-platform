'use server';

import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';
import { withTenant } from '@voltix/db';
import { requirePermission } from '../../lib/auth';

export interface MessageActionResult {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Approving a draft flips it to 'pending'; the worker's next dispatch pass
 * sends it. Nothing here talks to a transport — the admin decides, the worker
 * delivers, and the two stay decoupled exactly like every other send.
 *
 * `campaign:send` rather than a weaker permission, deliberately: approving a
 * marketing message IS sending it, on a small delay. Gating the button on a
 * lesser permission would make the review step decorative.
 */
export async function approveDraftAction(id: string): Promise<MessageActionResult> {
  const session = await requirePermission('campaign:send');

  const updated = await withTenant(session.tenantId, (tx) =>
    tx.execute(sql`
      UPDATE notifications
      SET status = 'pending', updated_at = now()
      WHERE tenant_id = ${session.tenantId} AND id = ${id} AND status = 'draft'
    `),
  );

  if ((updated.rowCount ?? 0) === 0) {
    return { ok: false, error: 'That draft is gone — it may already be approved or discarded.' };
  }
  revalidatePath('/messages');
  return { ok: true };
}

/**
 * Discarding suppresses rather than deletes. The row stays as the record that
 * a recovery message was considered and declined — which matters the day a
 * customer asks why they were (or were not) contacted.
 */
export async function discardDraftAction(id: string): Promise<MessageActionResult> {
  const session = await requirePermission('campaign:send');

  await withTenant(session.tenantId, (tx) =>
    tx.execute(sql`
      UPDATE notifications
      SET status = 'suppressed', last_error = 'discarded by staff', updated_at = now()
      WHERE tenant_id = ${session.tenantId} AND id = ${id} AND status = 'draft'
    `),
  );
  revalidatePath('/messages');
  return { ok: true };
}

/**
 * Requeues a failed message for another attempt cycle.
 *
 * Attempts reset to zero: the point of a manual retry is "the underlying
 * problem is fixed, try properly again", and resuming at attempts = max would
 * fail immediately without ever reaching a transport.
 */
export async function resendFailedAction(id: string): Promise<MessageActionResult> {
  const session = await requirePermission('campaign:send');

  const updated = await withTenant(session.tenantId, (tx) =>
    tx.execute(sql`
      UPDATE notifications
      SET status = 'pending', attempts = 0, last_error = NULL, updated_at = now()
      WHERE tenant_id = ${session.tenantId} AND id = ${id} AND status = 'failed'
    `),
  );

  if ((updated.rowCount ?? 0) === 0) {
    return { ok: false, error: 'Only failed messages can be resent.' };
  }
  revalidatePath('/messages');
  return { ok: true };
}
