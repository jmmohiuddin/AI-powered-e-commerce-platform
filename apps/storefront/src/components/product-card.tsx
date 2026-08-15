import Link from 'next/link';
import { discountPercent, formatCount, formatPrice, formatRating } from '@voltix/ui';
import { summarise } from '@voltix/core';
import { AvailabilityBadge, type AvailabilityLabels } from './availability-badge';
import { ProductImage } from './product-image';
import { imagesOf, localise, PLACEHOLDER_IMAGE, type ProductView } from '@/lib/types';
import type { Locale, Translate } from '@/lib/locale';

/**
 * The single most-rendered component in the store. Four things it must get
 * right, in order of revenue impact:
 *
 *  1. **Not shift.** The media box has a fixed aspect ratio so the grid does not
 *     reflow as images arrive. A tile that moves under a thumb costs a tap on
 *     the wrong product and, often, the session.
 *  2. **Tell the truth about stock.** Scarcity converts, and it only converts
 *     twice if it was true the first time. The label comes from the same
 *     availability logic the checkout enforces, so tile and cart cannot disagree.
 *  3. **Be one link.** The whole card is a single anchor rather than a card with
 *     several nested links — nested interactive elements are a screen-reader and
 *     keyboard mess and double the tap targets on mobile.
 *  4. **Render correctly in both directions.** Title, price and rating all come
 *     from locale-aware formatters, so an Arabic page gets Eastern Arabic
 *     numerals and the currency symbol on the correct side rather than an
 *     English string in a mirrored box.
 */
export function ProductCard({
  product,
  locale,
  t,
}: {
  product: ProductView;
  locale: Locale;
  t: Translate;
}) {
  const view = localise(product, locale);
  const discount = discountPercent(view.price, view.compareAtPrice);
  const rating = formatRating(view.ratingAverage, locale);
  const [image] = imagesOf(view);

  const availability = summarise(
    view.variants.map((variant) => ({
      warehouseId: variant.id,
      onHand: variant.available,
      reserved: 0,
      incoming: 0,
      allowBackorder: false,
      priority: 100,
    })),
  );

  return (
    <article className="product-card">
      <Link href={`/products/${view.slug}`} aria-label={view.title}>
        <div className="product-card__media">
          {discount != null && (
            <span className="product-card__badge">−{formatCount(discount, locale)}%</span>
          )}
          {image && (
            <ProductImage
              image={image}
              /**
               * Derived from the real grid, not guessed. `.product-grid` is
               * `auto-fill, minmax(min(100%, 220px), 1fr)` inside a 1280px
               * container, so the column count steps at these viewport widths
               * and the tile is *widest* on a narrow phone where it is the only
               * column — which is exactly where over-fetching costs the most.
               */
              sizes="(max-width: 499px) 90vw, (max-width: 707px) 42vw, (max-width: 967px) 28vw, (max-width: 1203px) 21vw, 210px"
              decorative={image.url === PLACEHOLDER_IMAGE}
            />
          )}
        </div>
      </Link>

      <div className="product-card__body">
        <span className="product-card__brand">{view.brand}</span>
        <h3 className="product-card__title">
          <Link href={`/products/${view.slug}`}>{view.title}</Link>
        </h3>

        {rating && (
          <span className="rating">
            <span className="rating__star" aria-hidden="true">
              ★
            </span>
            {rating}
            <span aria-hidden="true">·</span>
            <span>{formatCount(view.ratingCount, locale)}</span>
            <span className="visually-hidden">
              {rating} {t('product.outOf5')} — {formatCount(view.ratingCount, locale)}{' '}
              {t('product.reviews')}
            </span>
          </span>
        )}

        <div className="price-row">
          <span className="price">{formatPrice(view.price, view.currency, locale)}</span>
          {view.compareAtPrice && (
            <span className="price--was">
              {formatPrice(view.compareAtPrice, view.currency, locale)}
            </span>
          )}
        </div>

        <AvailabilityBadge
          label={availability.label}
          available={availability.available}
          formattedCount={formatCount(availability.available, locale)}
          labels={availabilityLabels(t)}
        />
      </div>
    </article>
  );
}

/** Bundles the five stock strings the badge needs into a serialisable object. */
export function availabilityLabels(t: Translate): AvailabilityLabels {
  return {
    inStock: t('stock.inStock'),
    out: t('stock.out'),
    preorder: t('stock.preorder'),
    backorder: t('stock.backorder'),
    only: t('stock.only', { n: '{n}' }),
  };
}
