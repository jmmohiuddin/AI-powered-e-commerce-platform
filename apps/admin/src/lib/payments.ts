import 'server-only';
import {
  CashOnDeliveryGateway,
  PaymentRegistry,
  StripeGateway,
  TabbyGateway,
  type PaymentGateway,
} from '@voltix/payments';

/**
 * The admin's gateway registry.
 *
 * Deliberately separate from the storefront's. The storefront builds a registry
 * to *offer* payment methods — ordered for conversion, filtered by eligibility.
 * The admin needs a registry to *reverse* payments, and the two questions have
 * different answers: a provider that has been switched off for new orders must
 * still be reachable to refund the orders it already took. Sharing one builder
 * would mean disabling Tabby for checkout silently stranded every Tabby refund.
 *
 * Built once per process — the adapters hold HTTP clients and circuit-breaker
 * state that is worth keeping warm across requests.
 */
let registry: PaymentRegistry | undefined;

function build(): PaymentRegistry {
  const built = new PaymentRegistry();

  if (process.env.STRIPE_SECRET_KEY) {
    built.register(
      new StripeGateway({
        secretKey: process.env.STRIPE_SECRET_KEY,
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
      }),
    );
  }

  if (process.env.TABBY_SECRET_KEY && process.env.TABBY_MERCHANT_CODE) {
    built.register(
      new TabbyGateway({
        secretKey: process.env.TABBY_SECRET_KEY,
        publicKey: process.env.TABBY_PUBLIC_KEY ?? '',
        merchantCode: process.env.TABBY_MERCHANT_CODE,
        ...(process.env.TABBY_WEBHOOK_SECRET
          ? { webhookSecret: process.env.TABBY_WEBHOOK_SECRET }
          : {}),
      }),
    );
  }

  // Registered unconditionally, unlike the storefront's COD_ENABLED gate.
  // Turning cash on delivery off stops new COD orders; it does not un-take the
  // cash already collected on existing ones.
  built.register(new CashOnDeliveryGateway({ currency: 'AED' }));

  return built;
}

export function adminPaymentRegistry(): PaymentRegistry {
  registry ??= build();
  return registry;
}

/**
 * The gateway that can reverse a payment taken by `provider`, or undefined.
 *
 * Undefined is a legitimate answer, not a failure: cash and bank-transfer
 * refunds are handed over outside the system and recorded as manual ledger
 * entries. `refundOrder` treats a missing gateway exactly that way.
 *
 * Cash on delivery deliberately returns undefined. The COD "gateway" exists to
 * defer payment at checkout, and asking it to refund would be asking it to
 * reverse a cash handover it never had — the money goes back at the counter or
 * by transfer, and the ledger records that.
 */
export function refundGatewayFor(provider: string | null): PaymentGateway | undefined {
  if (!provider || provider === 'cod' || provider === 'manual') return undefined;
  try {
    return adminPaymentRegistry().get(provider as never);
  } catch {
    // The order was taken by a provider this deployment no longer configures.
    // Falling back to a manual refund is right: the money still has to go back,
    // and blocking the refund would punish the customer for a config change.
    return undefined;
  }
}
