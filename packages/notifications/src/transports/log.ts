import type { NotificationMessage, NotificationTransport, SendResult } from '../port';

/**
 * The transport of last resort: it prints the message and reports success.
 *
 * This is not a stub to be replaced — it is the correct behaviour when nothing
 * else is configured. A store booted with no SMTP_URL and no WhatsApp token
 * should not crash on its first order confirmation, and it should not silently
 * drop the message either. Printing it means a developer sees exactly what
 * would have been sent, and the outbox row is still marked sent, so the retry
 * machinery does not spin on a message that has nowhere to go.
 *
 * In production a missing transport is a misconfiguration, and `paymentRegistry`
 * -style boot validation is where that should be caught — not here, at 2am,
 * one order at a time.
 */
export function createLogTransport(channel: NotificationTransport['channel'] = 'email'): NotificationTransport {
  return {
    channel,
    name: 'log',
    async send(message: NotificationMessage): Promise<SendResult> {
      const lines = [
        `\n  ┌─ notification (${message.channel} → ${message.recipient})`,
        message.subject ? `  │  ${message.subject}` : null,
        `  │  ${message.text.replace(/\n/g, '\n  │  ')}`,
        '  └─ (log transport — configure SMTP_URL or WhatsApp to actually send)',
      ].filter(Boolean);
      console.log(lines.join('\n'));
      return { ok: true, provider: 'log', providerMessageId: `log-${Date.now()}` };
    },
  };
}
