'use client';

import { useRef, useState } from 'react';
import { formatCount } from '@voltix/ui';
import { ProductImage } from './product-image';
import { PLACEHOLDER_IMAGE, type ProductImageView } from '@/lib/types';

export interface GalleryStrings {
  /** Labels the thumbnail strip. */
  readonly gallery: string;
  /** "Image {n} of {total}" — the accessible name of each thumbnail. */
  readonly imageOf: string;
}

/**
 * PRODUCT GALLERY
 *
 * A main image with a thumbnail strip, for the many photographs a product can
 * now have. `hydrate()` used to keep only the first media row, so a merchant
 * could upload six angles and the page would show one; this is the other half
 * of that fix.
 *
 * IMPLEMENTED AS A TABLIST, deliberately. Thumbnails that swap a main image are
 * tabs selecting panels, and the tablist pattern is the one screen readers and
 * keyboard users already know: arrows move between thumbnails, Home and End
 * jump to the ends, and only the selected thumbnail is in the tab order, so
 * Tab moves *past* the gallery rather than through eight stops of it.
 *
 * DIRECTION IS READ, NOT ASSUMED. The strip is laid out with logical properties
 * so it reverses in Arabic for free, but arrow keys do not: a shopper pressing
 * the left arrow means "the thumbnail to my left", which in RTL is the *next*
 * image, not the previous one. Getting this wrong makes the gallery feel
 * backwards in Arabic while looking perfectly correct in a screenshot.
 *
 * Motion is CSS-only, so `prefers-reduced-motion` in tokens.css already governs
 * it — there is no JS-driven animation here that could ignore the preference.
 */
export function ProductGallery({
  images,
  strings,
  locale,
  direction,
}: {
  images: readonly ProductImageView[];
  strings: GalleryStrings;
  /**
   * Passed alongside `direction` rather than derived from it, so the counters
   * go through `formatCount` like every other number in the store rather than
   * through a bare `String()`. That formatter pins Western digits even in
   * Arabic — a deliberate project decision, see packages/ui/src/format.ts — and
   * the point of routing through it is that the gallery cannot drift from
   * whatever that decision is later.
   */
  locale: string;
  direction: 'ltr' | 'rtl';
}) {
  const [selected, setSelected] = useState(0);
  const thumbRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const active = images[selected] ?? images[0];
  if (!active) return null;

  const focus = (index: number) => {
    const next = (index + images.length) % images.length;
    setSelected(next);
    thumbRefs.current[next]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    // In RTL the physical left arrow points at the *later* image, because the
    // strip itself is mirrored.
    const back = direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    const forward = direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight';

    switch (event.key) {
      case back:
        event.preventDefault();
        focus(index - 1);
        break;
      case forward:
        event.preventDefault();
        focus(index + 1);
        break;
      case 'Home':
        event.preventDefault();
        focus(0);
        break;
      case 'End':
        event.preventDefault();
        focus(images.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div className="gallery">
      <div
        className="gallery__main"
        id={`gallery-panel-${selected}`}
        role="tabpanel"
        aria-live="polite"
        {...(images.length > 1 ? { 'aria-labelledby': `gallery-tab-${selected}` } : {})}
      >
        <ProductImage
          image={active}
          /**
           * `.pdp` is a single column below 900px and a 1.1fr/0.9fr split above
           * it, inside a 1280px container — so the image is nearly full-width on
           * a phone and settles at roughly 600px on a wide desktop.
           */
          sizes="(max-width: 899px) 90vw, (max-width: 1279px) 48vw, 600px"
          // The PDP hero is the LCP element, so it must not be lazy — that is
          // the whole page's Largest Contentful Paint waiting on a scroll event.
          loading="eager"
          fetchPriority="high"
          decorative={active.url === PLACEHOLDER_IMAGE}
        />
      </div>

      {images.length > 1 && (
        <div className="gallery__thumbs" role="tablist" aria-label={strings.gallery}>
          {images.map((image, index) => (
            <button
              key={image.url}
              type="button"
              ref={(node) => {
                thumbRefs.current[index] = node;
              }}
              id={`gallery-tab-${index}`}
              role="tab"
              aria-selected={index === selected}
              aria-controls={`gallery-panel-${index}`}
              // Roving tabindex: one stop for the whole strip, not one per image.
              tabIndex={index === selected ? 0 : -1}
              className={`gallery__thumb${index === selected ? ' is-selected' : ''}`}
              onClick={() => setSelected(index)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              <ProductImage
                image={image}
                sizes="72px"
                // The alt text is on the button's accessible name below; a
                // second copy on the image would have a screen reader read the
                // product description twice per thumbnail.
                decorative
              />
              <span className="visually-hidden">
                {strings.imageOf
                  .replace('{n}', formatCount(index + 1, locale))
                  .replace('{total}', formatCount(images.length, locale))}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
