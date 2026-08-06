import type { NotificationMessage, NotificationTransport, SendResult } from '../port';

/**
 * WhatsApp Cloud API transport (Meta Graph API).
 *
 * WhatsApp is the default support and ordering channel in this market, so order
 * updates over it convert and reassure in a way email does not. But it comes
 * with a rule email does not have, and the rule is load-bearing:
 *
 *   Outside a 24-hour window opened by the *customer* messaging you first, you
 *   may only send a pre-approved **template** message — not free text. A raw
 *   order-confirmation string sent cold is rejected by the API, not delivered.
 *
 * So this transport sends free text (correct inside the service window, e.g. a
 * reply to a WhatsApp order enquiry) and leaves template sends as the explicit
 * next step, flagged below. Getting this wrong is not a bug that shows in
 * testing — it is a bug that shows only in production, against real customers,
 * as silently undelivered confirmations.
 *
 * It self-registers only when both credentials are present; without them the
 * registry falls back to the log transport, so a store with no WhatsApp
 * configured still boots and still records what it would have sent.
 */
export interface WhatsAppConfig {
  readonly phoneNumberId: string;
  readonly accessToken: string;
  /** Graph API version — pinned, because Meta ships breaking changes per version. */
  readonly apiVersion?: string;
}

export function createWhatsAppTransport(config: WhatsAppConfig): NotificationTransport {
  const version = config.apiVersion ?? 'v21.0';
  const endpoint = `https://graph.facebook.com/${version}/${config.phoneNumberId}/messages`;

  return {
    channel: 'whatsapp',
    name: 'whatsapp_cloud',
    async send(message: NotificationMessage): Promise<SendResult> {
      // The API wants the number without a leading '+'. Our recipients are
      // already E.164, so stripping the '+' is all that is required.
      const to = message.recipient.replace(/^\+/, '');

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            type: 'text',
            text: { body: message.text, preview_url: false },
          }),
        });

        const payload = (await response.json().catch(() => ({}))) as {
          messages?: { id: string }[];
          error?: { message?: string; code?: number };
        };

        if (!response.ok) {
          // Meta error code 131047 (re-engagement) and 470 (outside window) are
          // the "you need a template" family — permanent for this free-text
          // send, so retrying the same payload is pointless.
          const code = payload.error?.code;
          const needsTemplate = code === 131047 || code === 470;
          return {
            ok: false,
            provider: 'whatsapp_cloud',
            error: payload.error?.message ?? `WhatsApp API ${response.status}`,
            permanent: needsTemplate || (response.status >= 400 && response.status < 500),
          };
        }

        return {
          ok: true,
          provider: 'whatsapp_cloud',
          providerMessageId: payload.messages?.[0]?.id,
        };
      } catch (error) {
        // A network-level failure is transient — let the dispatcher retry.
        return { ok: false, provider: 'whatsapp_cloud', error: (error as Error).message };
      }
    },
  };
}
