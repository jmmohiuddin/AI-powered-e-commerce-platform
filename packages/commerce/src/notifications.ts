import { sql } from 'drizzle-orm';
import { DELIVERY_ZONES, isEmirateCode, EMIRATES } from '@voltix/core';
import {
  insertNotification,
  renderCartRecovery,
  renderOpsAlert,
  renderOrderConfirmation,
  type NotificationChannel,
} from '@voltix/notifications';
import type { Job } from './jobs';
import type { Tx } from './types';

/**
 * NOTIFICATION JOB HANDLER
 *
 * The bridge between "something happened" and "a message was written". It runs
 * inside the job's transaction and does only database work — resolve the
 * recipient and the facts, render the copy, insert the outbox row. It never
 * sends: sending is the dispatcher's job, outside any transaction. Keeping the
 * network out of here is what makes the handler safe to retry and safe to share
 * a transaction with the job bookkeeping.
 *
 * This is where the resolution lives — turning an emirate code into a name, a
 * payment provider into "cash on delivery", a locale into a language — so the
 * templates stay pure and the transports stay dumb.
 */

/**
 * `||`, not `??`, on purpose.
 *
 * `??` falls back only on null/undefined, and an environment variable set to an
 * empty string in a hosting dashboard is neither — it is `''`. With `??` a
 * blank STORE_NAME would render "Thanks for shopping with ." and a blank
 * STOREFRONT_URL would produce a hostless tracking link, in an email, which is
 * the least recoverable place to be wrong. Treating empty as absent is the
 * correct reading for a string with a default.
 */
const STORE_NAME = process.env.STORE_NAME || 'Voltix';

function storefrontUrl(path: string): string {
  const base = (process.env.STOREFRONT_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}${path}`;
}

function emirateName(code: string | null): string | null {
  if (!code) return null;
  return EMIRATES.find((e) => e.code === code)?.name ?? code;
}

/**
 * Which channel to use, from what contact details we actually have.
 *
 * Email first when we have it — it carries the full receipt and an audit trail.
 * WhatsApp when email is absent but a phone is present, because in this market
 * a phone-only guest checkout is common and a silent non-notification is worse
 * than a terse WhatsApp line.
 */
function pickChannel(email: string | null, phone: string | null): {
  channel: NotificationChannel;
  recipient: string;
} | null {
  if (email) return { channel: 'email', recipient: email };
  if (phone) return { channel: 'whatsapp', recipient: phone };
  return null;
}

export async function handleNotificationJob(tx: Tx, job: Job): Promise<void> {
  const payload = job.payload as Record<string, unknown>;
  const template = String(payload.template ?? '');
  const locale = typeof payload.locale === 'string' ? payload.locale : 'en-AE';

  switch (template) {
    case 'order.confirmation': {
      const orderId = String(payload.orderId ?? '');
      const rows = await tx.execute<{
        number: string;
        total: number;
        currency: string;
        payment_status: string;
        email: string | null;
        phone: string | null;
        shipping_address: { recipientName?: string; emirate?: string } | null;
        item_count: number;
        provider: string | null;
      }>(sql`
        SELECT o.number, o.total, o.currency, o.payment_status, o.email, o.phone, o.shipping_address,
               (SELECT coalesce(sum(quantity), 0)::int FROM order_items WHERE order_id = o.id) AS item_count,
               (SELECT provider FROM payment_intents WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1) AS provider
        FROM orders o WHERE o.id = ${orderId} LIMIT 1
      `);
      const order = rows.rows[0];
      if (!order) return;

      const target = pickChannel(order.email, order.phone);
      if (!target) return; // No contact details — nothing to send, and not an error.

      const emirateCode = order.shipping_address?.emirate ?? null;
      const deliveryDays =
        emirateCode && isEmirateCode(emirateCode)
          ? DELIVERY_ZONES[emirateCode].standardDays
          : null;

      const rendered = renderOrderConfirmation(
        {
          orderNumber: order.number,
          customerName: order.shipping_address?.recipientName ?? null,
          total: Number(order.total),
          currency: order.currency,
          emirate: emirateName(emirateCode),
          deliveryDays,
          // COD is the case that must read as unpaid, and the payment intent's
          // provider is the reliable signal for it — checkout always writes one,
          // so a COD order always has provider 'cod'.
          //
          // `payment_status` alone is not a COD test: it is 'unpaid' both for a
          // COD order and for a card order whose authorisation is still
          // settling, and treating the second as the first told a customer who
          // had already paid by card to hand cash to the driver. Anything
          // neither COD nor settled says an amount is due without claiming how
          // it will be collected.
          payment:
            order.provider === 'cod'
              ? 'cod'
              : order.payment_status === 'unpaid' || order.payment_status === 'failed'
                ? 'awaiting'
                : 'paid',
          itemCount: Number(order.item_count),
          // Prefill the number only — never the phone. A tracking link that
          // carries the customer's phone in the query string would put it in
          // every mail server and proxy log between here and their inbox.
          trackUrl: storefrontUrl(`/orders?number=${order.number}`),
          storeName: STORE_NAME,
        },
        locale,
        target.channel,
      );

      await insertNotification(tx, {
        tenantId: job.tenantId,
        channel: target.channel,
        recipient: target.recipient,
        locale,
        template,
        rendered,
        referenceType: 'order',
        referenceId: orderId,
        // One confirmation per order, ever — even if the job is retried or the
        // checkout is replayed from the idempotency ledger.
        dedupeKey: `order.confirmation:${orderId}`,
        status: 'pending',
      });
      return;
    }

    case 'cart.recovery': {
      const cartId = String(payload.cartId ?? '');
      // Contact details live on the customer, not the cart — a guest cart with
      // no linked customer has no one to recover to, and the JOIN correctly
      // yields nothing rather than inventing a recipient.
      const rows = await tx.execute<{
        email: string | null;
        phone: string | null;
        first_name: string | null;
        last_name: string | null;
        accepts_email: boolean;
        accepts_whatsapp: boolean;
        item_count: number;
      }>(sql`
        SELECT cu.email, cu.phone, cu.first_name, cu.last_name,
               cu.accepts_marketing_email AS accepts_email,
               cu.accepts_marketing_whatsapp AS accepts_whatsapp,
               (SELECT coalesce(sum(quantity), 0)::int FROM cart_items WHERE cart_id = c.id) AS item_count
        FROM carts c
        JOIN customers cu ON cu.id = c.customer_id AND cu.deleted_at IS NULL
        WHERE c.id = ${cartId} LIMIT 1
      `);
      const cart = rows.rows[0];
      if (!cart || Number(cart.item_count) === 0) return;

      // Consent decides the channel, not just availability. Cart recovery is
      // marketing: emailing someone who opted out is both a UAE-consumer-
      // protection problem and the fastest way to a spam complaint. Only a
      // channel the customer opted into is eligible; if they opted into none,
      // nothing is queued — not even a draft.
      const channel: NotificationChannel | null =
        cart.email && cart.accepts_email
          ? 'email'
          : cart.phone && cart.accepts_whatsapp
            ? 'whatsapp'
            : null;
      if (!channel) return;
      const recipient = channel === 'email' ? cart.email! : cart.phone!;

      const rendered = renderCartRecovery(
        {
          customerName: [cart.first_name, cart.last_name].filter(Boolean).join(' ') || null,
          itemCount: Number(cart.item_count),
          cartUrl: storefrontUrl('/cart'),
          storeName: STORE_NAME,
        },
        locale,
        channel,
      );

      await insertNotification(tx, {
        tenantId: job.tenantId,
        channel,
        recipient,
        locale,
        template,
        rendered,
        referenceType: 'cart',
        referenceId: cartId,
        dedupeKey: `cart.recovery:${cartId}`,
        // A DRAFT — even with consent, marketing is never sent without a human
        // approving it. This is the mechanism behind the dashboard's promise
        // that nothing reaches a customer unreviewed.
        status: 'draft',
      });
      return;
    }

    case 'ops.payment_unreconciled': {
      // Internal alert to the operations mailbox, not a customer message.
      const opsEmail = process.env.OPS_ALERT_EMAIL;
      if (!opsEmail) return;

      const rendered = renderOpsAlert({
        headline: 'Payment did not reconcile',
        detail: `Intent ${String(payload.intentId ?? '?')} via ${String(
          payload.provider ?? '?',
        )} has been non-terminal for over an hour. Check the gateway dashboard.`,
      });

      await insertNotification(tx, {
        tenantId: job.tenantId,
        channel: 'email',
        recipient: opsEmail,
        locale: 'en-AE',
        template,
        rendered,
        referenceType: 'payment_intent',
        referenceId: typeof payload.intentId === 'string' ? payload.intentId : undefined,
        dedupeKey: `ops.unreconciled:${String(payload.intentId ?? '')}`,
        status: 'pending',
      });
      return;
    }

    default:
      // An unknown template is a programming error, not a runtime condition.
      // Throwing routes it through the job runner's retry/dead-letter path,
      // where it is visible, rather than being silently swallowed.
      throw new Error(`Unknown notification template: ${template}`);
  }
}
