'use server';

import { revalidatePath } from 'next/cache';
import { withTenant } from '@voltix/db';
import { transitionReturn, type ReturnStatus } from '@voltix/commerce';
import { DomainError } from '@voltix/core';
import { actorFor, requestOrigin, requirePermission, tenantContextFor } from '../../lib/auth';

/**
 * RETURN ACTIONS
 *
 * Thin wrappers over `transitionReturn`, which owns the state machine and every
 * side effect. Nothing here decides whether a move is legal or whether stock
 * comes back — doing that in the UI layer is how two entry points end up
 * disagreeing about the rules.
 *
 * The permission is checked per action, server-side. Hiding a button is not
 * enforcing anything: a Server Action is a POST endpoint addressable by its own
 * id, with no page visit required.
 */

export interface ReturnActionResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly message?: string;
}

function toResult(error: unknown): ReturnActionResult {
  if (error instanceof DomainError) {
    return { ok: false, error: error.publicMessage ?? error.message };
  }
  console.error('[return action]', error);
  return { ok: false, error: 'Something went wrong. The return was not changed.' };
}

async function move(
  returnId: string,
  next: ReturnStatus,
  options: { inspectionNote?: string; restockable?: boolean } = {},
  successMessage = 'Return updated.',
): Promise<ReturnActionResult> {
  const session = await requirePermission('return:manage');
  const ctx = tenantContextFor(session);
  const actor = actorFor(session, await requestOrigin());

  try {
    await withTenant(session.tenantId, (tx) =>
      transitionReturn(tx, ctx, actor, returnId, next, options),
    );
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/returns');
  return { ok: true, message: successMessage };
}

export async function approveReturn(id: string): Promise<ReturnActionResult> {
  return move(id, 'approved', {}, 'Approved — the customer can send it back.');
}

export async function rejectReturn(id: string): Promise<ReturnActionResult> {
  return move(id, 'rejected', {}, 'Return rejected.');
}

export async function markReceived(id: string): Promise<ReturnActionResult> {
  return move(id, 'received', {}, 'Marked received — the units are now accounted for.');
}

/**
 * Records the inspection verdict.
 *
 * `restockable` is the decision this whole step exists to capture, so it is a
 * required argument rather than an optional flag: a damaged handset going
 * quietly back into sellable stock is the failure mode, and defaulting it
 * either way would make that a one-click accident.
 */
export async function inspectReturn(
  id: string,
  formData: FormData,
): Promise<ReturnActionResult> {
  const restockable = formData.get('restockable') === 'yes';
  const note = String(formData.get('note') ?? '').trim();

  if (!note) {
    return { ok: false, error: 'Add an inspection note — it is the record of what arrived.' };
  }

  return move(
    id,
    'inspected',
    { restockable, inspectionNote: note },
    restockable ? 'Inspected — will be restocked.' : 'Inspected — will not be restocked.',
  );
}

export async function completeReturn(id: string): Promise<ReturnActionResult> {
  return move(id, 'completed', {}, 'Completed — refund issued and stock settled.');
}

export async function cancelReturn(id: string): Promise<ReturnActionResult> {
  return move(id, 'cancelled', {}, 'Return cancelled.');
}
