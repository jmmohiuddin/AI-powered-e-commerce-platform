import nodemailer, { type Transporter } from 'nodemailer';
import type { NotificationMessage, NotificationTransport, SendResult } from '../port';

/**
 * SMTP email transport.
 *
 * One reused `Transporter` with a connection pool — creating a fresh SMTP
 * connection per message is the classic way a store that starts sending in
 * volume exhausts its provider's connection limit and starts getting rate
 * limited on its own receipts.
 *
 * In development `SMTP_URL` points at Mailpit (`smtp://localhost:1025`), which
 * accepts everything and shows it in a web inbox — so the whole confirmation
 * path is exercised end to end without a real provider or a real send. In
 * production it points at Resend, SES, or similar. The code does not change.
 */
export interface SmtpConfig {
  /** e.g. smtp://localhost:1025 or smtps://user:pass@smtp.provider.com:465 */
  readonly url: string;
  /** RFC 5322 From — 'Voltix <orders@voltix.ae>'. */
  readonly from: string;
}

/** Classifies an SMTP failure as retryable or not, from its response code. */
function isPermanent(error: unknown): boolean {
  // Nodemailer surfaces the SMTP reply code on `responseCode`. 5xx is a
  // permanent rejection (bad mailbox, blocked); 4xx is "try later". Anything
  // without a code is a connection-level problem — transient by default, so we
  // do not throw away a message because the mail server blinked.
  const code = (error as { responseCode?: number }).responseCode;
  return typeof code === 'number' && code >= 500 && code < 600;
}

export function createSmtpTransport(config: SmtpConfig): NotificationTransport {
  let transporter: Transporter | null = null;

  // Lazily constructed so importing this module never opens a socket — the
  // connection is made on the first actual send, not at boot.
  //
  // Connection pooling is enabled by appending `?pool=true&maxConnections=3` to
  // SMTP_URL: nodemailer parses a connection URL's query string into transport
  // options, so pooling is a deployment setting rather than a code change, and
  // Mailpit in development needs none of it.
  const getTransporter = (): Transporter => {
    transporter ??= nodemailer.createTransport(config.url);
    return transporter;
  };

  return {
    channel: 'email',
    name: 'smtp',
    async send(message: NotificationMessage): Promise<SendResult> {
      try {
        const info = await getTransporter().sendMail({
          from: config.from,
          to: message.recipient,
          subject: message.subject ?? '(no subject)',
          text: message.text,
          html: message.html ?? undefined,
        });
        return { ok: true, provider: 'smtp', providerMessageId: info.messageId };
      } catch (error) {
        return {
          ok: false,
          provider: 'smtp',
          error: (error as Error).message,
          permanent: isPermanent(error),
        };
      }
    },
  };
}
