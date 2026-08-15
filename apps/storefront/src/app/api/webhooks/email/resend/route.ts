import { recordEmailProviderEvent } from '@voltix/commerce';
import { parseResendEmailEvent, verifySvixSignature } from '@voltix/notifications';
import { inTenant, tenantContext } from '@/lib/session';

/**
 * EMAIL DELIVERY WEBHOOK INGRESS — Resend.
 *
 * The path by which a bounce reaches the store. Without it, `dispatchNotifications`
 * marks a row 'sent' when the API accepts the message and nothing ever revises
 * that: a customer whose mail server rejected their order confirmation looks
 * perfectly fine on every admin screen, forever.
 *
 * Deliberately the same three steps as the payment webhook next door
 * (`api/webhooks/[provider]`), and for the same reasons:
 *
 *   1. verify the signature against the raw bytes,
 *   2. write the event down, idempotently,
 *   3. return 200.
 *
 * The work is a queued job (`notifications.email_event`). Providers abandon a
 * slow webhook in seconds and redeliver, so anything done inline is work that
 * gets interrupted and repeated — the TRD (§8.1) makes "no business logic in
 * the request path" a rule for exactly that reason.
 *
 * WHY ITS OWN PATH RATHER THAN THE `[provider]` ROUTE. That route is gated on
 * the *payment* registry and 404s anything not in it, and its ids are a Postgres
 * enum of payment gateways. An email provider is neither. Sharing the segment
 * would mean either widening a money-path guard or teaching the payments
 * registry about email — both worse than one more file.
 */

export const dynamic = 'force-dynamic';

/**
 * Anything larger than this is not a delivery notification.
 *
 * The signature is checked *after* the body is read, so until that check passes
 * this endpoint is reading attacker-controlled bytes. Resend's largest event is
 * a few kilobytes; 64 KiB matches the cap the payment route uses.
 */
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.RESEND_WEBHOOK_SECRET ?? '';

  /**
   * No secret means nothing can be verified, and an endpoint that cannot verify
   * must not accept. 503 rather than 401: the request may be perfectly genuine
   * and the fault is this deployment's, so the provider should keep retrying
   * while somebody sets the variable — a 401 would have it give up and
   * eventually disable the endpoint.
   */
  if (!secret) {
    console.error('[email-webhook] RESEND_WEBHOOK_SECRET is not set — refusing to accept events');
    return Response.json({ ok: false, error: 'Webhook not configured' }, { status: 503 });
  }

  // Raw text, never `request.json()`. The signature covers the exact bytes
  // Resend sent, and parsing then re-serialising changes them — key order,
  // whitespace, number formatting — turning a genuine event into a 401.
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
    return Response.json({ ok: false, error: 'Payload too large' }, { status: 413 });
  }

  const headers = Object.fromEntries(request.headers);
  const verification = verifySvixSignature(rawBody, headers, secret);

  if (!verification.valid) {
    /**
     * Rejected, and not recorded.
     *
     * The payment route keeps forged events as evidence, because a forged
     * payment notification is an attempt to rob the store and an operator needs
     * to see that someone is trying. A forged bounce is worth much less — the
     * most it can do is mark one message failed — and storing unverified bodies
     * from an unauthenticated endpoint is a storage-exhaustion lever that has
     * to be paid for with a table and a retention policy. The log line is the
     * right weight of record for this.
     */
    console.warn(`[email-webhook] rejected an event: ${verification.reason}`);
    return Response.json({ ok: false, error: 'Invalid signature' }, { status: 401 });
  }

  const event = parseResendEmailEvent(rawBody);

  /**
   * Verified, but nothing this store acts on — a `contact.*` event, or an event
   * type Resend adds next year.
   *
   * It gets a 200. A webhook endpoint that errors on an unrecognised event is
   * retried for hours and then disabled by the provider, which would take the
   * bounces down along with the event nobody cared about.
   */
  if (!event) {
    return Response.json({ ok: true, ignored: true });
  }

  const ctx = tenantContext();
  const { duplicate } = await inTenant((tx) =>
    // Svix's message id is inside the signed content, so it is as trustworthy
    // as the event itself — which is what makes it usable as the idempotency
    // key. A redelivery lands on the same `jobs.dedupe_key` and queues nothing.
    recordEmailProviderEvent(tx, ctx, 'resend', verification.messageId, event),
  );

  return Response.json({ ok: true, duplicate });
}
