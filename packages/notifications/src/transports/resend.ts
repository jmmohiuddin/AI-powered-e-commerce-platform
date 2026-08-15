import type { NotificationMessage, NotificationTransport, SendResult } from '../port';

/**
 * Resend HTTP transport.
 *
 * The production counterpart to SMTP-into-Mailpit, and the reason this file
 * exists at all: `packages/config` has always reported `capabilities().email`
 * as true when `RESEND_API_KEY` is set, but the registry only knew how to build
 * an SMTP transport. A deployment holding a Resend key and no `SMTP_URL` got
 * the log transport — every confirmation printed to a serverless log, the row
 * marked 'sent', and the customer told nothing. A silent non-delivery that
 * looks healthy from every screen is the worst failure mode available here.
 *
 * HTTP rather than Resend's SMTP bridge because a serverless function on a cold
 * start pays for a TCP + TLS + SMTP handshake it cannot pool between
 * invocations, and outbound port 587 is not reliably open on every platform.
 * One HTTPS POST has neither problem.
 */
export interface ResendConfig {
  readonly apiKey: string;
  /** RFC 5322 From — 'Voltix <orders@voltix.ae>'. The domain must be verified. */
  readonly from: string;
  /** Overridable for tests; there is no sandbox host to point at otherwise. */
  readonly endpoint?: string;
}

interface ResendResponse {
  readonly id?: string;
  readonly message?: string;
  readonly name?: string;
}

/**
 * Classifies a Resend rejection as retryable or not.
 *
 * 429 is a rate limit and 5xx is their infrastructure — both mean "later", and
 * failing the message would throw away a receipt over a busy minute. Every
 * other 4xx is about *this* payload or *this* account (invalid address,
 * unverified domain, revoked key) and will fail identically on every retry, so
 * it goes straight to 'failed' where the admin Messages screen shows it.
 */
function isPermanent(status: number): boolean {
  if (status === 429 || status >= 500) return false;
  return status >= 400;
}

export function createResendTransport(config: ResendConfig): NotificationTransport {
  const endpoint = config.endpoint ?? 'https://api.resend.com/emails';

  return {
    channel: 'email',
    name: 'resend',
    async send(message: NotificationMessage): Promise<SendResult> {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: config.from,
            to: [message.recipient],
            subject: message.subject ?? '(no subject)',
            // Both parts, always. Resend will synthesise a text part from the
            // HTML, but the synthesised version of an RTL Arabic receipt is not
            // the copy that was frozen into the outbox row — and the frozen
            // copy is the record of what the customer was told.
            text: message.text,
            ...(message.html ? { html: message.html } : {}),
          }),
        });

        const payload = (await response.json().catch(() => ({}))) as ResendResponse;

        if (!response.ok) {
          return {
            ok: false,
            provider: 'resend',
            error: payload.message ?? `Resend API ${response.status}`,
            permanent: isPermanent(response.status),
          };
        }

        return { ok: true, provider: 'resend', providerMessageId: payload.id };
      } catch (error) {
        // A network-level failure is transient — let the dispatcher back off
        // and retry rather than discarding the message.
        return { ok: false, provider: 'resend', error: (error as Error).message };
      }
    },
  };
}
