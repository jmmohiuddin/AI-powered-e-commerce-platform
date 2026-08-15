import sharp from 'sharp';
// Separate type import: `sharp` is declared with `export =`, so the namespace
// is not reachable as a property of the default import under this tsconfig.
import type { Metadata } from 'sharp';
import { DomainError } from '@voltix/core';

/**
 * IMAGE INGESTION
 *
 * Everything that has to happen between "a merchant picked a file" and "bytes
 * are safe to store and the storefront has what it needs to render them".
 *
 * Four jobs, and each exists because skipping it has a specific cost:
 *
 * 1. **Decide the format from the bytes, not the filename.** A browser sends
 *    whatever `Content-Type` it feels like and an attacker sends whatever they
 *    choose. `sharp` has to parse the file to tell us what it is, which means
 *    a `.jpg` that is actually an SVG is rejected here rather than served back
 *    from our own origin with a script inside it.
 *
 * 2. **Strip EXIF.** A phone photograph of stock on a kitchen table carries
 *    GPS coordinates of the merchant's home. Re-encoding drops all metadata by
 *    default — `sharp` only preserves it when explicitly asked — so the privacy
 *    property comes from the pipeline rather than from a separate scrub step
 *    somebody could remove. Orientation is the one tag that must survive, and
 *    `rotate()` bakes it into the pixels before it is discarded, otherwise
 *    every portrait photo lands on its side.
 *
 * 3. **Bound the output.** A 48-megapixel phone camera produces a 12 MB file
 *    that no product page needs. Capping the long edge keeps storage, CDN bills
 *    and the optimiser's work proportional to what is actually displayed.
 *
 * 4. **Produce `width`, `height` and `blurDataUrl` now.** The storefront needs
 *    all three to reserve layout space and blur up. Computing them later means
 *    re-downloading and re-decoding every image in the catalogue.
 */

/** Formats we will accept. SVG and GIF are excluded deliberately — see below. */
const ACCEPTED = new Set(['jpeg', 'png', 'webp', 'avif', 'tiff', 'heif']);

/** Refuses before decoding. Decoding is the expensive part and the attack surface. */
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/** Long edge. Larger than any viewport we serve, small enough to stay cheap. */
const MAX_EDGE = 2400;

/** The LQIP is stretched over the whole tile, so more than 16px is wasted bytes. */
const BLUR_EDGE = 16;

export interface PreparedImage {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly extension: string;
  readonly width: number;
  readonly height: number;
  /** Base64 data URL, a few hundred bytes. Goes straight into `media.blur_data_url`. */
  readonly blurDataUrl: string;
}

function reject(message: string, publicMessage: string): never {
  throw new DomainError('VALIDATION_FAILED', message, { publicMessage });
}

export async function prepareImage(input: Uint8Array): Promise<PreparedImage> {
  if (input.byteLength === 0) reject('Empty upload', 'That file is empty.');
  if (input.byteLength > MAX_UPLOAD_BYTES) {
    reject(
      `Upload is ${input.byteLength} bytes, limit ${MAX_UPLOAD_BYTES}`,
      `Images must be under ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB. Try a smaller photo.`,
    );
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(input).metadata();
  } catch {
    reject('Unreadable image', 'That file is not an image we can read.');
  }

  const format = metadata.format ?? '';
  if (!ACCEPTED.has(format)) {
    // SVG is the one worth naming: it is markup, it can carry script, and
    // serving it from our own origin would hand an attacker same-origin
    // execution. GIF is refused because flattening an animation to a still
    // silently produces something the merchant did not upload.
    reject(
      `Rejected image format: ${format || 'unknown'}`,
      'Upload a JPEG, PNG, WebP or AVIF. SVG and GIF are not accepted.',
    );
  }

  // `rotate()` with no argument applies the EXIF orientation tag and then the
  // re-encode discards the tag along with the rest of the metadata.
  const pipeline = sharp(input, { failOn: 'error' })
    .rotate()
    .resize({
      width: MAX_EDGE,
      height: MAX_EDGE,
      fit: 'inside',
      // Never upscale: a 400px photo enlarged to 2400px is bigger, blurrier and
      // no more useful.
      withoutEnlargement: true,
    });

  /**
   * Alpha decides the output format. A product cut out on a transparent
   * background is the common case for accessories, and JPEG would composite it
   * onto black. Everything else is a photograph, where JPEG at 82 is smaller
   * than WebP at equivalent perceived quality on the optimiser's input side.
   */
  const transparent = Boolean(metadata.hasAlpha);
  const encoded = transparent
    ? await pipeline.webp({ quality: 90 }).toBuffer({ resolveWithObject: true })
    : await pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer({ resolveWithObject: true });

  const blur = await sharp(encoded.data)
    .resize({ width: BLUR_EDGE, height: BLUR_EDGE, fit: 'inside' })
    .webp({ quality: 40 })
    .toBuffer();

  return {
    body: new Uint8Array(encoded.data),
    contentType: transparent ? 'image/webp' : 'image/jpeg',
    extension: transparent ? 'webp' : 'jpg',
    width: encoded.info.width,
    height: encoded.info.height,
    blurDataUrl: `data:image/webp;base64,${blur.toString('base64')}`,
  };
}
