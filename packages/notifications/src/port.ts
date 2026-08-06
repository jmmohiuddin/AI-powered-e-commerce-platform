/**
 * NOTIFICATION TRANSPORT PORT
 *
 * The same shape as the payment gateway port, and for the same reason: the
 * store should not know or care whether an order confirmation goes out over
 * SMTP, the WhatsApp Cloud API, or an SMS gateway. Each is a transport behind
 * one interface, chosen by channel at send time, and adding a new one is a new
 * file rather than a change to the calling code.
 *
 * A transport's single job is to hand a fully-rendered message to a provider
 * and report what happened. It does no rendering, no templating, and no
 * database work — those are decided before it is called, so the same transport
 * serves a transactional receipt and a marketing blast without knowing the
 * difference.
 */

export type NotificationChannel = 'email' | 'whatsapp' | 'sms';

export interface NotificationMessage {
  readonly channel: NotificationChannel;
  /** Email address for 'email'; E.164 phone for 'whatsapp' / 'sms'. */
  readonly recipient: string;
  readonly locale: string;
  /** Null on channels with no subject line (WhatsApp, SMS). */
  readonly subject: string | null;
  readonly text: string;
  /** Rich body for email; ignored by text-only channels. */
  readonly html: string | null;
}

export interface SendResult {
  readonly ok: boolean;
  readonly provider: string;
  readonly providerMessageId?: string;
  readonly error?: string;
  /**
   * A permanent failure — a malformed address, a hard bounce — must not be
   * retried: every attempt fails identically and burns the attempt budget for
   * nothing. Transient failures (a timeout, a 503) leave this false so the
   * dispatcher backs off and tries again.
   */
  readonly permanent?: boolean;
}

export interface NotificationTransport {
  readonly channel: NotificationChannel;
  readonly name: string;
  send(message: NotificationMessage): Promise<SendResult>;
}

/**
 * One transport per channel.
 *
 * Deliberately last-write-wins per channel rather than a list: there is exactly
 * one way the store sends email at a time, and a fallback chain ("try SMTP,
 * then try the API") is a feature to add explicitly when it is needed, not a
 * default that silently double-sends when the first transport is merely slow.
 */
export class TransportRegistry {
  private readonly byChannel = new Map<NotificationChannel, NotificationTransport>();

  register(transport: NotificationTransport): this {
    this.byChannel.set(transport.channel, transport);
    return this;
  }

  for(channel: NotificationChannel): NotificationTransport | undefined {
    return this.byChannel.get(channel);
  }

  has(channel: NotificationChannel): boolean {
    return this.byChannel.has(channel);
  }

  get channels(): NotificationChannel[] {
    return [...this.byChannel.keys()];
  }
}
