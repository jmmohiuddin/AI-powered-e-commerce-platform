import type { Metadata } from 'next';
import Link from 'next/link';
import { getCart, getOrCreateCart } from '@voltix/commerce';
import { formatPrice, splitVatInclusive } from '@voltix/ui';
import { CartLines } from '@/components/cart-lines';
import { cartSessionToken, inTenant, tenantContext } from '@/lib/session';
import { resolveLocale, translator } from '@/lib/locale';

export const metadata: Metadata = { title: 'Your basket', robots: { index: false } };

/** Always live: a cached cart is somebody else's cart. */
export const dynamic = 'force-dynamic';

export default async function CartPage() {
  const locale = await resolveLocale();
  const t = translator(locale);
  const ctx = tenantContext();
  const sessionToken = await cartSessionToken();

  // No cookie means no cart yet, and reading one cannot mint it — setting a
  // cookie during a render is forbidden, and a GET that mutates state is not
  // something to work around.
  const cart = sessionToken
    ? await inTenant(async (tx) => {
        const cartId = await getOrCreateCart(tx, ctx, { sessionToken });
        return getCart(tx, ctx, cartId);
      }).catch(() => null)
    : null;

  const lines = cart?.lines ?? [];
  const vat = splitVatInclusive(cart?.pricing.total.amount ?? 0, ctx.vatRateBps);

  if (lines.length === 0) {
    return (
      <div className="container section">
        <div className="empty-state">
          <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-3)' }}>
            Your basket is empty
          </h1>
          <p style={{ marginBottom: 'var(--space-5)' }}>
            Browse smartphones, audio and accessories delivered across the Emirates.
          </p>
          <Link className="button button--primary" href="/search">
            {t('home.browseAll')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container checkout-layout">
      <section>
        <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-4)' }}>
          Your basket ({cart!.itemCount})
        </h1>

        <CartLines
          lines={lines.map((line) => ({
            id: line.id,
            productSlug: line.productSlug,
            title: line.title,
            variantTitle: line.variantTitle,
            sku: line.sku,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            lineTotal: line.lineTotal,
            available: line.available,
            exceedsStock: line.exceedsStock,
          }))}
          currency={cart!.currency}
          locale={locale}
          strings={{
            remove: 'Remove',
            quantity: t('product.quantity'),
            outOfStock: t('stock.out'),
            only: t('stock.only', { n: '{n}' }),
          }}
        />
      </section>

      <aside className="summary">
        <h2 style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--space-4)' }}>Summary</h2>

        <dl className="summary__rows">
          <div>
            <dt>Subtotal</dt>
            <dd>{formatPrice(cart!.pricing.subtotal.amount, cart!.currency, locale)}</dd>
          </div>
          {cart!.pricing.discountTotal.amount > 0 && (
            <div>
              <dt>Discount</dt>
              <dd className="summary__discount">
                −{formatPrice(cart!.pricing.discountTotal.amount, cart!.currency, locale)}
              </dd>
            </div>
          )}
          <div>
            <dt>Delivery</dt>
            <dd>Calculated at checkout</dd>
          </div>
          <div className="summary__total">
            <dt>Total</dt>
            <dd>{formatPrice(cart!.pricing.total.amount, cart!.currency, locale)}</dd>
          </div>
        </dl>

        {/* UAE prices are VAT-inclusive, but the invoice must state the split —
            showing it here means the number at checkout matches the invoice. */}
        <p className="vat-note">
          {t('vat.inclusive')} · {formatPrice(vat.net, cart!.currency, locale)} +{' '}
          {formatPrice(vat.vat, cart!.currency, locale)} VAT
        </p>

        {cart!.issues.length > 0 ? (
          <>
            <p className="cart-error" role="alert">
              {cart!.issues[0]}
            </p>
            <button className="button button--primary button--block" disabled>
              Resolve the issue above to continue
            </button>
          </>
        ) : (
          <Link className="button button--primary button--block" href="/checkout">
            Continue to checkout
          </Link>
        )}

        <ul className="trust-list">
          <li>{t('trust.cod')}</li>
          <li>{t('trust.dispatch')}</li>
          <li>Free delivery over AED 200</li>
        </ul>
      </aside>
    </div>
  );
}
