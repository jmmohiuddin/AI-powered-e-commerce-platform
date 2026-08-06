'use server';

import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';
import { withTenant } from '@voltix/db';
import {
  cancelOrder,
  recordCodCollection,
  refreshDerivedStatus,
  refundOrder,
  transitionOrder,
} from '@voltix/commerce';
import { DomainError } from '@voltix/core';
import { actorFor, requirePermission, requestOrigin, tenantContextFor } from '../../../lib/auth';
import { refundGatewayFor } from '../../../lib/payments';

/**
 * ORDER ACTIONS
 *
 * Three rules hold across every action here, and each one exists because the
 * alternative has burned somebody:
 *
 *  1. **Permission is checked server-side, per action.** The UI hides buttons a
 *     role cannot use, but hiding is not enforcing — a Server Action is a POST
 *     endpoint addressable by its own id, with no page visit required.
 *  2. **The order number comes from the URL, the tenant from the session.**
 *     Never both from the request. That pairing is what makes it impossible to
 *     act on another merchant's order by editing a form field.
 *  3. **Every mutation goes through the domain state machine**, so an illegal
 *     transition throws instead of writing an impossible row.
 */

export interface ActionResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly message?: string;
}

/** Resolves a customer-facing order number to its id, inside the tenant. */
async function orderIdFor(tenantId: string, number: string): Promise<string | null> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      SELECT id FROM orders WHERE tenant_id = ${tenantId} AND number = ${number.replace(/^#/, '')} LIMIT 1
    `);
    return rows.rows[0]?.id ?? null;
  });
}

/**
 * Turns a thrown domain error into a message a merchant can act on.
 *
 * `DomainError` carries a `publicMessage` written for a human; anything else is
 * a bug and gets a generic string, because leaking an internal error into the
 * UI is both unhelpful and an information disclosure.
 */
function toResult(error: unknown): ActionResult {
  if (error instanceof DomainError) {
    return { ok: false, error: error.publicMessage ?? error.message };
  }
  console.error('[order action]', error);
  return { ok: false, error: 'Something went wrong. The order was not changed.' };
}

export async function cancelOrderAction(
  number: string,
  formData: FormData,
): Promise<ActionResult> {
  const session = await requirePermission('order:cancel');
  const reason = String(formData.get('reason') ?? '').trim();

  // A required reason, not an optional note. Cancellations are the transaction
  // most often disputed weeks later, and "cancelled by Amal, no reason given"
  // is the audit row that helps nobody.
  if (!reason) return { ok: false, error: 'Give a reason — it goes on the order record.' };

  const orderId = await orderIdFor(session.tenantId, number);
  if (!orderId) return { ok: false, error: 'Order not found.' };

  const ctx = tenantContextFor(session);
  const actor = actorFor(session, await requestOrigin());

  try {
    await withTenant(session.tenantId, (tx) => cancelOrder(tx, ctx, actor, orderId, reason));
  } catch (error) {
    return toResult(error);
  }

  revalidatePath(`/orders/${number}`);
  revalidatePath('/orders');
  return { ok: true, message: 'Order cancelled and stock returned.' };
}

export async function markFulfilledAction(number: string): Promise<ActionResult> {
  const session = await requirePermission('order:write');

  const orderId = await orderIdFor(session.tenantId, number);
  if (!orderId) return { ok: false, error: 'Order not found.' };

  const ctx = tenantContextFor(session);
  const actor = actorFor(session, await requestOrigin());

  try {
    await withTenant(session.tenantId, async (tx) => {
      // Fulfil every line completely. Partial fulfilment is a separate screen
      // with per-line quantities; conflating the two into one button is how a
      // three-item order silently ships as one.
      await tx.execute(sql`
        UPDATE order_items
        SET quantity_fulfilled = quantity, updated_at = now()
        WHERE tenant_id = ${ctx.tenantId} AND order_id = ${orderId}
      `);

      // Recompute from the line items rather than setting the column directly,
      // so the derived status can never disagree with the rows beneath it.
      await refreshDerivedStatus(tx, ctx, orderId);

      await transitionOrder(tx, ctx, actor, orderId, { status: 'completed' }, {
        type: 'order.fulfilled',
        isPublic: true,
        message: 'All items marked as fulfilled.',
      });
    });
  } catch (error) {
    return toResult(error);
  }

  revalidatePath(`/orders/${number}`);
  revalidatePath('/orders');
  return { ok: true, message: 'Order marked as fulfilled.' };
}

export async function confirmOrderAction(number: string): Promise<ActionResult> {
  const session = await requirePermission('order:write');

  const orderId = await orderIdFor(session.tenantId, number);
  if (!orderId) return { ok: false, error: 'Order not found.' };

  const ctx = tenantContextFor(session);
  const actor = actorFor(session, await requestOrigin());

  try {
    await withTenant(session.tenantId, (tx) =>
      transitionOrder(tx, ctx, actor, orderId, { status: 'confirmed' }, {
        type: 'order.confirmed',
        isPublic: true,
        message: 'Order confirmed and queued for picking.',
      }),
    );
  } catch (error) {
    return toResult(error);
  }

  revalidatePath(`/orders/${number}`);
  revalidatePath('/orders');
  return { ok: true, message: 'Order confirmed.' };
}

/**
 * Records that the courier collected cash on a COD order.
 *
 * `order:write` rather than `order:refund` — this is delivery bookkeeping done
 * by whoever reconciles the courier's remittance, not a money-out operation.
 */
export async function recordCodPaymentAction(number: string): Promise<ActionResult> {
  const session = await requirePermission('order:write');

  const orderId = await orderIdFor(session.tenantId, number);
  if (!orderId) return { ok: false, error: 'Order not found.' };

  const ctx = tenantContextFor(session);
  const actor = actorFor(session, await requestOrigin());

  try {
    await withTenant(session.tenantId, (tx) => recordCodCollection(tx, ctx, actor, orderId));
  } catch (error) {
    return toResult(error);
  }

  revalidatePath(`/orders/${number}`);
  revalidatePath('/orders');
  return { ok: true, message: 'Payment recorded. The order is now marked paid.' };
}

/**
 * Refunds money against an order.
 *
 * The amount arrives from the form as a decimal string in AED and is converted
 * to fils here, at the boundary — the domain never sees a float. `Math.round`
 * after multiplying is deliberate: `19.99 * 100` is 1998.9999999999998 in IEEE
 *754, and truncating would quietly refund a fils less than the customer is owed
 * on a large fraction of amounts.
 */
export async function refundOrderAction(
  number: string,
  formData: FormData,
): Promise<ActionResult> {
  const session = await requirePermission('order:refund');
  const reason = String(formData.get('reason') ?? '').trim();
  const rawAmount = String(formData.get('amount') ?? '').trim();

  let amount: number | undefined;
  if (rawAmount) {
    const parsed = Number(rawAmount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { ok: false, error: 'Enter a refund amount greater than zero.' };
    }
    amount = Math.round(parsed * 100);
  }

  const orderId = await orderIdFor(session.tenantId, number);
  if (!orderId) return { ok: false, error: 'Order not found.' };

  const ctx = tenantContextFor(session);
  const actor = actorFor(session, await requestOrigin());

  // Which provider took the money decides which adapter gives it back.
  const providerRow = await withTenant(session.tenantId, (tx) =>
    tx.execute<{ provider: string | null }>(sql`
      SELECT provider FROM payment_intents WHERE order_id = ${orderId}
      ORDER BY created_at DESC LIMIT 1
    `),
  );
  const gateway = refundGatewayFor(providerRow.rows[0]?.provider ?? null);

  let result;
  try {
    result = await withTenant(session.tenantId, (tx) =>
      refundOrder(tx, ctx, actor, orderId, { ...(amount != null ? { amount } : {}), reason }, gateway),
    );
  } catch (error) {
    return toResult(error);
  }

  revalidatePath(`/orders/${number}`);
  revalidatePath('/orders');

  const formatted = (result.amount / 100).toFixed(2);
  return {
    ok: true,
    message:
      result.status === 'pending'
        ? `Refund of ${formatted} ${result.currency} sent to the provider — it will settle shortly.`
        : `Refunded ${formatted} ${result.currency}${gateway ? '' : ' (recorded manually)'}.`,
  };
}

/**
 * An internal note.
 *
 * Written as a non-public order event so it sits in the same timeline as
 * everything else. A separate notes table would mean reconstructing "what
 * happened to this order, in order" from two sources, and the two would
 * eventually disagree about ordering.
 */
export async function addNoteAction(number: string, formData: FormData): Promise<ActionResult> {
  const session = await requirePermission('order:read');
  const note = String(formData.get('note') ?? '').trim();
  if (!note) return { ok: false, error: 'The note is empty.' };
  if (note.length > 2000) return { ok: false, error: 'Notes are limited to 2000 characters.' };

  const orderId = await orderIdFor(session.tenantId, number);
  if (!orderId) return { ok: false, error: 'Order not found.' };

  await withTenant(session.tenantId, async (tx) => {
    await tx.execute(sql`
      INSERT INTO order_events (id, tenant_id, order_id, type, is_public, message, actor_type, actor_id, created_at)
      VALUES (gen_random_uuid(), ${session.tenantId}, ${orderId}, 'note', false,
              ${note}, 'staff', ${session.userId}, now())
    `);
  });

  revalidatePath(`/orders/${number}`);
  return { ok: true, message: 'Note added.' };
}
