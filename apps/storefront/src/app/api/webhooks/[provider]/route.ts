import { createHash } from 'node:crypto';
import { recordPaymentWebhookEvent } from '@voltix/commerce';
import type { PaymentProviderId, WebhookVerification } from '@voltix/payments';
import { inTenant, paymentRegistry, tenantContext } from '@/lib/session';

/**
 * PAYMENT WEBHOOK INGRESS
 *
 * The path by which a card or BNPL payment reaches a terminal state. Without
 * it, a shopper who completes 3-D Secure on the gateway's hosted page is
 * successful everywhere except in this store: the money moves, the intent stays
 * `requires_action`, the stock stays held, and the order is never confirmed.
 *
 * This handler does three things and deliberately nothing else:
 *
 *   1. verify the signature against the raw bytes,
 *   2. write the event down, idempotently,
 *   3. return 200.
 *
 * The business logic is a queued job (`payments.webhook`). Gateways abandon a
 * slow webhook in a handful of seconds and redeliver, so any work done inline
 * is work that gets interrupted and repeated under load — the TRD (§8.1) makes
 * "no business logic in the request path" a rule for exactly that reason.
 *
 * WHY THE STOREFRONT AND NOT THE ADMIN
 * The same reason the cron tick lives here: the admin sits behind an auth proxy
 * that redirects unauthenticated requests to /login, and a gateway callback
 * bounced to a login page is a payment that silently never lands.
 */

export const dynamic = 'force-dynamic';

/**
 * Anything larger than this is not a payment event.
 *
 * The signature is checked *after* the body is read, so until that check passes
 * this endpoint is writing attacker-controlled bytes into the database. A cap
 * is what keeps that from being a storage-exhaustion lever; 64 KiB is several
 * times the largest event any of these gateways sends.
 */
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await params;

  // Only gateways this store is actually configured for. An unknown provider is
  // a 404 rather than a 400, because the route genuinely does not exist for it.
  const registry = paymentRegistry();
  if (!registry.has(provider as PaymentProviderId)) {
    return Response.json({ ok: false, error: 'Unknown payment provider' }, { status: 404 });
  }

  // Raw text, never `request.json()`. Every signature covers the exact bytes the
  // gateway sent, and parsing then re-serialising changes them — key order,
  // whitespace, number formatting — which invalidates a perfectly good
  // signature and turns real payments into 401s.
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
    return Response.json({ ok: false, error: 'Payload too large' }, { status: 413 });
  }

  const headers = Object.fromEntries(request.headers);

  let verification: WebhookVerification;
  try {
    // Deliberately not through the registry's circuit breaker. Several adapters
    // re-fetch the payment while verifying, so anyone can make this call fail
    // by posting junk — and a breaker tripped from here would take that
    // provider out of *checkout*, turning an unauthenticated POST into a way to
    // switch off card payments.
    verification = await registry.get(provider as PaymentProviderId).verifyWebhook(rawBody, headers);
  } catch (error) {
    // The same re-fetch also means this can fail simply because the gateway is
    // down. A 500 is the honest answer and makes the gateway redeliver; a 200
    // would tell it the event was handled and it would never send it again.
    console.error(`[webhook] ${provider} verification failed:`, error);
    return Response.json({ ok: false, error: 'Verification failed' }, { status: 500 });
  }

  const ctx = tenantContext();

  // Exactly-once rests entirely on the gateway's event id. A verified event
  // without one cannot be deduplicated, and processing it would mean applying
  // the same payment twice on the next redelivery — so it is refused loudly
  // rather than accepted and quietly double-counted.
  if (verification.valid && !verification.eventId) {
    console.error(`[webhook] ${provider} sent a verified event with no event id`);
    return Response.json({ ok: false, error: 'Event has no id' }, { status: 400 });
  }

  if (!verification.valid) {
    const eventId = rejectedEventId(rawBody);
    await inTenant((tx) =>
      recordPaymentWebhookEvent(tx, ctx, {
        provider,
        eventId,
        eventType: verification.eventType,
        signatureVerified: false,
        // The body is kept as an opaque string: it failed verification, so it
        // is evidence rather than data, and nothing downstream may read it.
        envelope: { raw: { body: rawBody } },
      }),
    );
    return Response.json({ ok: false, error: 'Invalid signature' }, { status: 401 });
  }

  const { duplicate } = await inTenant((tx) =>
    recordPaymentWebhookEvent(tx, ctx, {
      provider,
      eventId: verification.eventId,
      eventType: verification.eventType,
      signatureVerified: true,
      envelope: {
        ...(verification.status ? { status: verification.status } : {}),
        ...(verification.paymentReference
          ? { paymentReference: verification.paymentReference }
          : {}),
        ...(verification.amount
          ? { amount: { amount: verification.amount.amount, currency: verification.amount.currency } }
          : {}),
        raw: verification.raw,
      },
    }),
  );

  // A redelivery gets the same 200 as the first attempt and queues nothing. The
  // unique index on (provider, provider_event_id) is what makes that true, so
  // "handled exactly once" is a database guarantee rather than a hope about
  // gateway behaviour.
  return Response.json({ ok: true, duplicate });
}

/**
 * An identifier for an event that failed verification.
 *
 * These have no trustworthy event id — the fields carrying it are part of what
 * was not verified — but they still have to be recorded, and the table's unique
 * index needs something to key on. Hashing the body means a forger hammering
 * the endpoint with the same payload writes one row rather than a million,
 * while genuinely different attempts each leave their own trace.
 */
function rejectedEventId(rawBody: string): string {
  return `unverified:${createHash('sha256').update(rawBody).digest('hex').slice(0, 32)}`;
}
