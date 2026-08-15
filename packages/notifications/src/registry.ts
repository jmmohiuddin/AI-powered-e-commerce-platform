import { TransportRegistry } from './port';
import { createLogTransport } from './transports/log';
import { createResendTransport } from './transports/resend';
import { createSmtpTransport } from './transports/smtp';
import { createWhatsAppTransport } from './transports/whatsapp';

/**
 * Builds the transport registry from the environment.
 *
 * The rule is "configured or logged, never crashed". A store with a mail
 * provider configured sends real email; a store without one logs what it would
 * have sent and keeps running. That is deliberate: a missing transport is a
 * deployment decision or a local-dev reality, not a reason to fail an order
 * confirmation. Production boot validation (`packages/config`) is where an
 * *unexpectedly* missing transport should be caught loudly — not here, one
 * message at a time.
 *
 * In development SMTP_URL points at Mailpit, so this returns a real SMTP
 * transport and the confirmation genuinely sends — into a local inbox you can
 * open — without any cloud provider or credential.
 *
 * RESEND_API_KEY wins over SMTP_URL when both are set. Not arbitrary: an API
 * key only exists because someone deliberately provisioned it, whereas
 * `.env.example` ships SMTP_URL pre-filled with `smtp://localhost:1025` — so
 * the ordering that lets a copied env file survive into production sends mail,
 * and the reverse ordering silently posts every receipt to a mail server that
 * does not exist there.
 */
export function buildTransportRegistry(env: NodeJS.ProcessEnv = process.env): TransportRegistry {
  const registry = new TransportRegistry();
  const from = env.EMAIL_FROM ?? 'Voltix <orders@voltix.ae>';

  if (env.RESEND_API_KEY) {
    registry.register(createResendTransport({ apiKey: env.RESEND_API_KEY, from }));
  } else if (env.SMTP_URL) {
    registry.register(createSmtpTransport({ url: env.SMTP_URL, from }));
  } else {
    registry.register(createLogTransport('email'));
  }

  if (env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN) {
    registry.register(
      createWhatsAppTransport({
        phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
        accessToken: env.WHATSAPP_ACCESS_TOKEN,
      }),
    );
  } else {
    registry.register(createLogTransport('whatsapp'));
  }

  return registry;
}
