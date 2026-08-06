'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { formatCount, formatPrice } from '@voltix/ui';
import { removeFromCart, setCartQuantity } from '@/app/actions';
import type { Locale } from '@/lib/locale';

export interface CartLineView {
  id: string;
  productSlug: string;
  title: string;
  variantTitle: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  available: number;
  exceedsStock: boolean;
}

/**
 * The cart's interactive island.
 *
 * `useTransition` rather than a loading flag: the row stays visible and
 * readable while the server recomputes, instead of collapsing into a spinner.
 * A cart that flickers on every quantity change feels broken even when it is
 * working, and this is the screen where a shopper is most likely to abandon.
 *
 * The quantity control is capped at what is actually in stock, so the common
 * error is prevented rather than reported. The server still validates — a
 * disabled button is a courtesy, not a control.
 */
export function CartLines({
  lines,
  currency,
  locale,
  strings,
}: {
  lines: CartLineView[];
  currency: string;
  locale: Locale;
  strings: { remove: string; quantity: string; outOfStock: string; only: string };
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function update(itemId: string, quantity: number) {
    setError(null);
    startTransition(async () => {
      const result = await setCartQuantity(itemId, quantity);
      if (!result.ok) setError(result.error ?? null);
    });
  }

  function remove(itemId: string) {
    setError(null);
    startTransition(async () => {
      const result = await removeFromCart(itemId);
      if (!result.ok) setError(result.error ?? null);
    });
  }

  return (
    <div style={{ opacity: pending ? 0.6 : 1, transition: 'opacity var(--duration-fast)' }}>
      {error && (
        <p className="cart-error" role="alert">
          {error}
        </p>
      )}

      <ul className="cart-lines">
        {lines.map((line) => (
          <li key={line.id} className="cart-line">
            <div className="cart-line__body">
              <Link href={`/products/${line.productSlug}`} className="cart-line__title">
                {line.title}
              </Link>
              <p className="cart-line__meta">
                {line.variantTitle} · {line.sku}
              </p>
              {line.exceedsStock && (
                <p className="cart-line__warning">
                  {line.available === 0
                    ? strings.outOfStock
                    : strings.only.replace('{n}', formatCount(line.available, locale))}
                </p>
              )}
            </div>

            <div className="cart-line__controls">
              <label>
                <span className="visually-hidden">{strings.quantity}</span>
                <select
                  value={line.quantity}
                  disabled={pending || line.available === 0}
                  onChange={(event) => update(line.id, Number(event.target.value))}
                >
                  {Array.from(
                    { length: Math.max(line.quantity, Math.min(line.available, 10)) },
                    (_, i) => i + 1,
                  ).map((n) => (
                    <option key={n} value={n}>
                      {formatCount(n, locale)}
                    </option>
                  ))}
                </select>
              </label>

              <span className="cart-line__price">
                {formatPrice(line.lineTotal, currency, locale)}
              </span>

              <button type="button" className="cart-line__remove" onClick={() => remove(line.id)}>
                {strings.remove}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
