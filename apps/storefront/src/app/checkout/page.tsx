import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCart, getOrCreateCart } from '@voltix/commerce';
import { money } from '@voltix/core';
import { formatPrice, splitVatInclusive } from '@voltix/ui';
import { CheckoutForm, type PaymentOption } from '@/components/checkout-form';
import { cartSessionToken, deliveryFee, inTenant, paymentRegistry, tenantContext } from '@/lib/session';
import { resolveLocale, translator } from '@/lib/locale';

export const metadata: Metadata = { title: 'Checkout', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function CheckoutPage() {
  const locale = await resolveLocale();
  const t = translator(locale);
  const ctx = tenantContext();
  const sessionToken = await cartSessionToken();

  if (!sessionToken) redirect('/cart');

  const cart = await inTenant(async (tx) => {
    const cartId = await getOrCreateCart(tx, ctx, { sessionToken });
    // Dubai's rate as the shown default; recomputed server-side once the
    // shopper picks their emirate, and again before payment is authorised.
    const preview = await getCart(tx, ctx, cartId);
    const shipping = deliveryFee('DU', preview.pricing.subtotal.amount);
    return getCart(tx, ctx, cartId, { shippingCost: shipping });
  }).catch(() => null);

  if (!cart || cart.lines.length === 0) redirect('/cart');
  if (cart.issues.length > 0) redirect('/cart');

  /**
   * Ask the registry what this shopper can actually pay with.
   *
   * Both halves are used: available methods become selectable options,
   * unavailable ones are rendered disabled *with their reason*. A checkout that
   * silently omits a method the shopper expected loses the order without ever
   * explaining why.
   */
  const registry = paymentRegistry();
  const { available, unavailable } = registry.availableFor({
    amount: money(cart.pricing.total.amount, cart.currency),
    countryCode: 'AE',
  });

  const paymentOptions: PaymentOption[] = [
    ...available.map((method) => ({
      id: method.id,
      displayName: method.displayName,
      available: true,
      isDeferredSettlement: method.isDeferredSettlement,
      ...(method.surcharge?.amount ? { surcharge: method.surcharge.amount } : {}),
      ...(method.advanceRequired?.amount ? { advanceRequired: method.advanceRequired.amount } : {}),
    })),
    ...unavailable.map((method) => ({
      id: method.id,
      displayName: method.displayName,
      available: false,
      reason: method.reason,
      isDeferredSettlement: false,
    })),
  ];

  const vat = splitVatInclusive(cart.pricing.total.amount, ctx.vatRateBps);

  return (
    <div className="container checkout-layout">
      <section>
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <ol>
            <li>
              <Link href="/cart">Basket</Link>
            </li>
            <li aria-current="page">Checkout</li>
          </ol>
        </nav>

        <h1 style={{ fontSize: 'var(--text-xl)', margin: 'var(--space-4) 0' }}>Checkout</h1>

        <CheckoutForm
          total={cart.pricing.total.amount}
          currency={cart.currency}
          locale={locale}
          paymentOptions={paymentOptions}
          // Resolved here because the form is a client component and the
          // dictionary is read from a cookie on the server.
          deposit={{
            legend: t('deposit.legend'),
            explainer: t('deposit.explainer'),
            refundCondition: t('deposit.refundCondition'),
            chooseCard: t('deposit.chooseCard'),
            noCard: t('deposit.noCard'),
          }}
        />
      </section>

      <aside className="summary">
        <h2 style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--space-4)' }}>
          Your order ({cart.itemCount})
        </h2>

        <ul className="summary__items">
          {cart.lines.map((line) => (
            <li key={line.id}>
              <span>
                {line.quantity} × {line.title}
                <small>{line.variantTitle}</small>
              </span>
              <span>{formatPrice(line.lineTotal, cart.currency, locale)}</span>
            </li>
          ))}
        </ul>

        <dl className="summary__rows">
          <div>
            <dt>Subtotal</dt>
            <dd>{formatPrice(cart.pricing.subtotal.amount, cart.currency, locale)}</dd>
          </div>
          {cart.pricing.discountTotal.amount > 0 && (
            <div>
              <dt>Discount</dt>
              <dd className="summary__discount">
                −{formatPrice(cart.pricing.discountTotal.amount, cart.currency, locale)}
              </dd>
            </div>
          )}
          <div>
            <dt>Delivery</dt>
            <dd>
              {cart.pricing.shippingTotal.amount === 0
                ? 'Free'
                : formatPrice(cart.pricing.shippingTotal.amount, cart.currency, locale)}
            </dd>
          </div>
          <div className="summary__total">
            <dt>Total</dt>
            <dd>{formatPrice(cart.pricing.total.amount, cart.currency, locale)}</dd>
          </div>
        </dl>

        <p className="vat-note">
          {t('vat.inclusive')} · {formatPrice(vat.net, cart.currency, locale)} +{' '}
          {formatPrice(vat.vat, cart.currency, locale)} VAT
        </p>
        <p className="vat-note">
          Delivery is recalculated for your emirate when you place the order.
        </p>
      </aside>
    </div>
  );
}
