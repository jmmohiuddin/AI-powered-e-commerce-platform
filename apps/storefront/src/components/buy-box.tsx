'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { addToCart } from '@/app/actions';
import { whatsappHref } from '@/lib/contact';
import { formatCount, formatPrice, splitVatInclusive } from '@voltix/ui';
import { AvailabilityBadge, type AvailabilityLabels } from './availability-badge';
import type { ProductVariantView } from '@/lib/types';
import type { Locale } from '@/lib/locale';

/**
 * The only interactive island on the product page.
 *
 * Everything else — copy, specs, reviews, structured data — is server-rendered
 * with zero client JavaScript. Scoping the `use client` boundary to this one
 * component is what keeps the page's hydration cost proportional to the one
 * thing on it that actually needs state.
 *
 * The price and stock shown here are re-validated server-side before payment is
 * taken. This is a picker, never a source of truth: anything a client component
 * reports about money is a suggestion, because the client is under the
 * shopper's control.
 */
export interface BuyBoxStrings {
  readonly chooseOption: string;
  readonly outOfStock: string;
  readonly vatInclusive: string;
  readonly quantity: string;
  readonly addToCart: string;
  readonly whatsapp: string;
  readonly trustCod: string;
  readonly trustDispatch: string;
  readonly trustReplacement: string;
}

export function BuyBox({
  variants,
  currency,
  productTitle,
  vatRateBps,
  locale,
  strings,
  availability,
}: {
  variants: readonly ProductVariantView[];
  currency: string;
  productTitle: string;
  vatRateBps: number;
  locale: Locale;
  /**
   * Pre-resolved copy. A translator *function* cannot cross the server/client
   * boundary — React refuses to serialise it — so the server resolves the
   * dozen strings this component needs and passes them as data.
   */
  strings: BuyBoxStrings;
  availability: AvailabilityLabels;
}) {
  const firstAvailable = variants.find((v) => v.available > 0) ?? variants[0];
  const [selectedId, setSelectedId] = useState(firstAvailable?.id ?? '');
  const [quantity, setQuantity] = useState(1);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const selected = variants.find((v) => v.id === selectedId) ?? firstAvailable;
  if (!selected) return null;

  const inStock = selected.available > 0;
  const maxQuantity = Math.max(1, Math.min(selected.available, 5));
  const vat = splitVatInclusive(selected.price, vatRateBps);

  // Tabby splits into four. Showing the instalment next to the price is the
  // whole point of carrying BNPL — a shopper who balks at AED 4,699 does not
  // balk at AED 1,175, and they will not discover the option at the payment
  // step because most abandon before reaching it.
  const instalment = Math.round(selected.price / 4);

  // Read from configuration rather than taken as a prop: the number is the same
  // for every product, and a prop is one more place a placeholder can be typed.
  const whatsapp = whatsappHref(
    `Hi, I'd like to order ${quantity} × ${productTitle} (${selected.title}, ${selected.sku}).`,
  );

  return (
    <div className="buy-box">
      {variants.length > 1 && (
        <div>
          <h2 style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--space-3)' }}>
            {strings.chooseOption}
          </h2>
          <ul className="variant-list">
            {variants.map((variant) => {
              const unavailable = variant.available === 0;
              return (
                <li key={variant.id}>
                  <button
                    type="button"
                    className={`variant${unavailable ? ' variant--unavailable' : ''}`}
                    aria-pressed={variant.id === selected.id}
                    disabled={unavailable}
                    onClick={() => {
                      setSelectedId(variant.id);
                      setQuantity(1);
                    }}
                  >
                    {variant.title}
                    <small>
                      {unavailable
                        ? strings.outOfStock
                        : formatPrice(variant.price, currency, locale)}
                    </small>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="pdp__price">
        <span className="price">{formatPrice(selected.price, currency, locale)}</span>
        {selected.compareAtPrice && selected.compareAtPrice > selected.price && (
          <span className="price--was">
            {formatPrice(selected.compareAtPrice, currency, locale)}
          </span>
        )}
      </div>

      <p className="vat-note">
        {strings.vatInclusive} · {formatPrice(vat.net, currency, locale)} +{' '}
        {formatPrice(vat.vat, currency, locale)} VAT
      </p>

      <p className="vat-note">
        or 4 × {formatPrice(instalment, currency, locale)} with Tabby
      </p>

      <AvailabilityBadge
        label={
          selected.available === 0
            ? 'out_of_stock'
            : selected.available <= 5
              ? 'low_stock'
              : 'in_stock'
        }
        available={selected.available}
        formattedCount={formatCount(selected.available, locale)}
        labels={availability}
      />

      {inStock && (
        <label style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--text-sm)' }}>{strings.quantity}</span>
          <select
            value={quantity}
            onChange={(event) => setQuantity(Number(event.target.value))}
            style={{
              padding: 'var(--space-2) var(--space-3)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--colour-border-strong)',
              background: 'var(--colour-surface)',
              minHeight: '44px',
            }}
          >
            {Array.from({ length: maxQuantity }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {formatCount(n, locale)}
              </option>
            ))}
          </select>
        </label>
      )}

      {error && (
        <p className="cart-error" role="alert">
          {error}
        </p>
      )}

      <button
        className="button button--primary button--block"
        type="button"
        disabled={!inStock || pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await addToCart(selected.id, quantity);
            if (!result.ok) {
              // Surfaced in place rather than thrown: "Only 2 left" recovers
              // the sale, a generic error boundary loses it.
              setError(result.error ?? 'Could not add to basket.');
              return;
            }
            router.push('/cart');
          });
        }}
      >
        {pending ? '…' : inStock ? strings.addToCart : strings.outOfStock}
      </button>

      {whatsapp && (
        <a className="button button--whatsapp button--block" href={whatsapp}>
          {strings.whatsapp}
        </a>
      )}

      <ul className="trust-list">
        <li>{strings.trustCod}</li>
        <li>{strings.trustDispatch}</li>
        <li>{strings.trustReplacement}</li>
      </ul>
    </div>
  );
}
