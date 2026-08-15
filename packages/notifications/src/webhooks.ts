import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * INBOUND EMAIL EVENTS — the half of delivery the store could not see.
 *
 * `dispatchNotifications` marks a row 'sent' the moment the transport accepts
 * it. For SMTP that means the relay took the message; for Resend it means the
 * API returned an id. Neither is delivery. The recipient's mail server can
 * reject it seconds or minutes later, and until now that answer went nowhere:
 * a customer who never received their order confirmation looked identical, on
 * every admin screen, to one who read it. That is the same class of failure the
 * Resend transport was written to fix — a silent non-delivery that reports as
 * healthy — one step further down the path.
 *
 * This module is the parsing and verification half only. It does no database
 * work and knows nothing about orders, so it can be exercised without either.
 */

/**
 * SIGNATURE VERIFICATION — Svix, which is what Resend signs with.
 *
 * Implemented here against the published scheme rather than pulled in as the
 * `svix` package, because adding a dependency is not this change's to make. The
 * scheme is small and fully specified, and the test suite pins it to the
 * worked example in Svix's own documentation — so an implementation that
 * drifted from the real thing would fail rather than merely look plausible.
 *
 * The scheme, from docs.svix.com/receiving/verifying-payloads/how-manual:
 *
 *   signed content = `${id}.${timestamp}.${raw body}`
 *   key            = base64-decoded portion of the secret after `whsec_`
 *   signature      = base64(HMAC-SHA256(key, signed content))
 *   header         = space-delimited `v<n>,<signature>` pairs
 *
 * Three details each close a real hole:
 *
 *  • the RAW body, never a re-serialised object — key order and whitespace are
 *    inside the signature, so parsing and re-stringifying turns a genuine event
 *    into a forgery;
 *  • the timestamp is inside the signed content AND checked against a window,
 *    because a signature with no expiry is a replay token: capture one bounce
 *    and you can resend it forever;
 *  • constant-time comparison, because a byte-at-a-time `===` leaks how much of
 *    a guessed signature was right, which is enough to construct one.
 */

/** Svix's own default, and the window Resend's dashboard documents. */
const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export type SvixVerification =
  | { readonly valid: true; readonly messageId: string }
  | { readonly valid: false; readonly reason: string };

/**
 * Headers as a plain lowercased-key object — the shape
 * `Object.fromEntries(request.headers)` produces.
 *
 * Both spellings are accepted. Svix sends `svix-*`; the vendor-neutral
 * `webhook-*` spelling is the Standard Webhooks naming that the same platforms
 * emit when configured for it, and a receiver that understands only one of them
 * breaks on a setting nobody remembers changing.
 */
export function verifySvixSignature(
  rawBody: string,
  headers: Record<string, string | undefined>,
  secret: string,
  options: { toleranceSeconds?: number; now?: Date } = {},
): SvixVerification {
  if (!secret) return { valid: false, reason: 'no webhook secret configured' };

  const header = (name: string): string | undefined =>
    headers[`svix-${name}`] ?? headers[`webhook-${name}`];

  const messageId = header('id');
  const timestamp = header('timestamp');
  const signatures = header('signature');

  if (!messageId || !timestamp || !signatures) {
    return { valid: false, reason: 'missing signature headers' };
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return { valid: false, reason: 'malformed timestamp' };

  const nowSeconds = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  // Both directions. A timestamp far in the future is as much a sign of a
  // forged or replayed event as one far in the past.
  if (Math.abs(nowSeconds - sentAt) > tolerance) {
    return { valid: false, reason: 'timestamp outside tolerance' };
  }

  let key: Buffer;
  try {
    // `whsec_` is a prefix on the printed form only; the key material is what
    // follows it. A secret pasted without the prefix is still usable.
    const encoded = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
    key = Buffer.from(encoded, 'base64');
  } catch {
    return { valid: false, reason: 'unreadable webhook secret' };
  }
  if (key.length === 0) return { valid: false, reason: 'unreadable webhook secret' };

  const expected = createHmac('sha256', key)
    .update(`${messageId}.${timestamp}.${rawBody}`)
    .digest();

  // The header may carry several signatures — Svix sends one per active signing
  // key so a secret can be rotated without dropping events mid-flight. Any one
  // matching is a valid event. Versions other than v1 are skipped rather than
  // guessed at.
  for (const entry of signatures.split(' ')) {
    const comma = entry.indexOf(',');
    if (comma === -1) continue;
    if (entry.slice(0, comma) !== 'v1') continue;

    const candidate = Buffer.from(entry.slice(comma + 1), 'base64');
    // `timingSafeEqual` throws on a length mismatch, which would itself be a
    // side channel if it were allowed to escape as an exception.
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return { valid: true, messageId };
    }
  }

  return { valid: false, reason: 'no matching signature' };
}

/* ────────────────────────── Resend's event shapes ────────────────────── */

/**
 * `email.delivered` is not here, and that is a decision rather than an omission.
 *
 * Resend emits it, and there is nowhere on `notifications` to put it: the table
 * has `sent_at` — when the store handed the message over — and no
 * `delivered_at`. The two are different facts, and overwriting the first with
 * the second would destroy the only honest record of when the outbox acted.
 * Subscribing to it anyway would queue one job per successfully delivered
 * email, at the volume of the entire outbox, to do nothing at all.
 *
 * If per-message delivery confirmation is wanted later it needs a column
 * first; adding the event type before the column is how a store ends up with a
 * webhook that is busy and a screen that is unchanged.
 */
export type EmailEventType = 'email.bounced' | 'email.complained';

/**
 * The verified reading of an inbound email event.
 *
 * DELIBERATELY WITHOUT THE RECIPIENT. Resend's payload carries `data.to`, and
 * carrying it forward would copy customer email addresses into the `jobs`
 * table — a queue that is retried, dumped during incidents and eventually
 * pruned, and which today holds no personal data at all. The address is already
 * on the notification row, under the message id below, so the worker can look
 * it up when it actually needs it. One copy of an email address is a record;
 * two is a leak waiting for someone to export the wrong table.
 */
export interface EmailProviderEvent {
  readonly type: EmailEventType;
  /** Resend's `data.email_id` — what the transport stored as providerMessageId. */
  readonly providerMessageId: string;
  /** 'Permanent' | 'Transient' | 'Undetermined', on a bounce. */
  readonly bounceType?: string;
  /** 'Suppressed', 'MessageRejected', … — the specific reason, when given. */
  readonly bounceSubType?: string;
  /** The mail server's own words. Trimmed, because it ends up in a UI column. */
  readonly bounceMessage?: string;
}

const HANDLED: ReadonlySet<string> = new Set<EmailEventType>(['email.bounced', 'email.complained']);

/** Longer than any useful bounce message, short enough not to bloat a job row. */
const MAX_BOUNCE_MESSAGE = 500;

/**
 * Reads a verified Resend payload.
 *
 * Returns null for anything this store does not act on — including event types
 * Resend adds later. The caller must still answer 200 to those: a webhook
 * endpoint that errors on an unrecognised event gets retried for hours and then
 * disabled by the provider, taking the bounces down with it.
 */
export function parseResendEmailEvent(rawBody: string): EmailProviderEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return null;
  }

  if (typeof payload !== 'object' || payload === null) return null;
  const envelope = payload as { type?: unknown; data?: unknown };

  const type = typeof envelope.type === 'string' ? envelope.type : '';
  if (!HANDLED.has(type)) return null;

  const data = (typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}) as {
    email_id?: unknown;
    bounce?: unknown;
  };

  const providerMessageId = typeof data.email_id === 'string' ? data.email_id : '';
  // Without it there is no row to write back to, and guessing from the subject
  // or the recipient would eventually mark the wrong customer's message failed.
  if (!providerMessageId) return null;

  const bounce = (typeof data.bounce === 'object' && data.bounce !== null ? data.bounce : {}) as {
    type?: unknown;
    subType?: unknown;
    message?: unknown;
  };

  return {
    type: type as EmailEventType,
    providerMessageId,
    ...(typeof bounce.type === 'string' ? { bounceType: bounce.type } : {}),
    ...(typeof bounce.subType === 'string' ? { bounceSubType: bounce.subType } : {}),
    ...(typeof bounce.message === 'string'
      ? { bounceMessage: bounce.message.slice(0, MAX_BOUNCE_MESSAGE) }
      : {}),
  };
}

/**
 * Is this bounce the end of the road for the message?
 *
 * 'Permanent' is the unambiguous case: the address does not exist or the server
 * refuses it outright, and no retry will change that.
 *
 * 'Undetermined' is counted as permanent too, and that is a judgement rather
 * than a reading of the spec. It means the receiving server gave a reason
 * nobody could classify — so the store does not know the message arrived. The
 * two ways to be wrong here are not symmetric: a message wrongly marked failed
 * costs an operator a glance at the Messages screen, while one wrongly left
 * 'sent' costs a customer their order confirmation and tells nobody. The cheap
 * mistake is the one to make.
 *
 * 'Transient' is a deferral — greylisting, a full mailbox — and the provider
 * may still deliver it. Marking that failed would put a message on the admin's
 * work list that is not finished failing yet.
 */
export function isHardBounce(bounceType: string | undefined): boolean {
  return bounceType !== 'Transient';
}
