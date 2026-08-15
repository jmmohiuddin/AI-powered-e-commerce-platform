import Image from 'next/image';
import type { ProductImageView } from '@/lib/types';

/**
 * The one place `next/image` is configured for product photography.
 *
 * Before this, nothing in the storefront rendered an image at all: both the
 * tile and the product page drew a hash-coloured gradient of a generic phone,
 * and the `deviceSizes`/`imageSizes`/AVIF configuration in next.config.ts was
 * dead. An electronics shop that never shows the product is the single largest
 * commercial gap in the storefront, so this component is deliberately small and
 * shared — two call sites that drift apart would put the bug back.
 *
 * THE THREE THINGS IT EXISTS TO GET RIGHT:
 *
 * **`sizes` is mandatory, and mandatory to get right.** With `fill` and no
 * `sizes`, the browser assumes the image is as wide as the viewport and pulls a
 * full-width file for a 200px tile. Nothing looks broken — it just costs the
 * shopper several hundred kilobytes per tile. The target shopper is on mobile
 * data and gone by four seconds, so each caller passes the `sizes` its own
 * layout actually produces, computed from the real grid rather than guessed.
 *
 * **Blur up when, and only when, we have the data.** `placeholder="blur"`
 * without a `blurDataURL` throws at render time for a remote src, so the
 * placeholder is conditional on the column being populated. Rows written before
 * the upload pipeline existed have no LQIP and must still render.
 *
 * **Never an empty alt on a meaningful image.** `imagesOf()` guarantees a
 * non-empty string, falling back to the localised product title. The one
 * exception is the placeholder, which is genuinely decorative — announcing
 * "no image available" to a screen reader on every tile is noise.
 */
export function ProductImage({
  image,
  sizes,
  className,
  loading,
  fetchPriority,
  decorative = false,
}: {
  image: ProductImageView;
  sizes: string;
  className?: string;
  loading?: 'eager' | 'lazy';
  fetchPriority?: 'high' | 'low' | 'auto';
  /** True for the placeholder, which carries no information about the product. */
  decorative?: boolean;
}) {
  const blur = image.blurDataUrl
    ? ({ placeholder: 'blur', blurDataURL: image.blurDataUrl } as const)
    : {};

  return (
    <Image
      src={image.url}
      alt={decorative ? '' : image.alt}
      // `fill` rather than intrinsic width/height: the media box already has a
      // fixed aspect ratio in CSS, which is what holds CLS at zero, and the
      // stored dimensions vary per upload. Letting the box own the geometry
      // means a portrait photograph and a landscape one occupy the same tile.
      fill
      sizes={sizes}
      className={className}
      {...(loading ? { loading } : {})}
      {...(fetchPriority ? { fetchPriority } : {})}
      {...blur}
    />
  );
}
