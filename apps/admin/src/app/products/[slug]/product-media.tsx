'use client';

import { useRef, useState, useTransition } from 'react';
import type { ActionResult } from '../actions';
import {
  deleteImageAction,
  reorderImagesAction,
  setImageAltAction,
  uploadProductImagesAction,
} from '../media-actions';

export interface ProductImage {
  id: string;
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
  position: number;
}

/**
 * PRODUCT IMAGES
 *
 * The screen that was missing. There was no way to attach a photograph to a
 * product anywhere in the admin, which is why every product page rendered a
 * generated placeholder — the storefront was reading a `media` table nothing
 * could write to.
 *
 * Three decisions worth explaining:
 *
 * **Reordering is buttons, not drag and drop.** Position decides the tile image
 * and the link preview, so it has to be settable by someone using a keyboard,
 * a screen reader, or a phone — and drag and drop is the single least
 * accessible interaction on the web. Two buttons per row are keyboard-operable
 * for free and work on a touchscreen without a long-press.
 *
 * **Alt text saves on blur, not on a separate Save button.** It is one field
 * per image and up to twelve of them; a form-wide save means a merchant who
 * edits one description and navigates away loses it silently.
 *
 * **Deletion asks first.** It removes the stored object as well as the row, so
 * unlike unpublishing it is not undoable by clicking the other button.
 */
export function ProductMedia({
  productId,
  slug,
  images,
  canWrite,
  storefrontOrigin,
}: {
  productId: string;
  slug: string;
  images: ProductImage[];
  canWrite: boolean;
  /**
   * Where root-relative media URLs resolve.
   *
   * Uploads store an absolute URL from object storage, but seeded and
   * disk-driver rows store a path like `/products/x.jpg`, which is relative to
   * the *storefront* origin. Rendered as-is from the admin on its own port they
   * 404, and the merchant sees a broken thumbnail for an image that is
   * perfectly fine on the shop.
   */
  storefrontOrigin: string;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  /**
   * Uploads one file per request, in sequence.
   *
   * Sending the whole selection in a single Server Action would put twelve
   * photographs — up to 144 MB — in one request body, which the server has to
   * buffer whole. One at a time keeps the body to a single image, isolates a
   * failure to the file that caused it, and lets the merchant watch progress
   * instead of staring at a spinner for a minute.
   */
  const onUpload = (formData: FormData) =>
    startTransition(async () => {
      const files = formData.getAll('images').filter((entry): entry is File => entry instanceof File);
      if (files.length === 0) {
        setResult({ ok: false, error: 'Choose at least one image.' });
        return;
      }

      let uploaded = 0;
      for (const [index, file] of files.entries()) {
        setProgress(`Uploading ${index + 1} of ${files.length}…`);
        const single = new FormData();
        single.append('images', file);

        const outcome = await uploadProductImagesAction(productId, slug, single);
        if (!outcome.ok) {
          setProgress(null);
          setResult({
            ok: false,
            error: `${file.name}: ${outcome.error}${
              uploaded > 0 ? ` (${uploaded} uploaded before this one)` : ''
            }`,
          });
          return;
        }
        uploaded += 1;
      }

      setProgress(null);
      setResult({ ok: true, message: `Uploaded ${uploaded} image${uploaded === 1 ? '' : 's'}.` });
      // Clearing the picker matters: leaving the filenames in place makes a
      // merchant think the upload has not happened and click again.
      if (fileInput.current) fileInput.current.value = '';
    });

  const move = (index: number, delta: number) => {
    const next = [...images];
    const target = index + delta;
    const a = next[index];
    const b = next[target];
    if (!a || !b) return;
    next[index] = b;
    next[target] = a;
    startTransition(async () =>
      setResult(await reorderImagesAction(productId, slug, next.map((image) => image.id))),
    );
  };

  return (
    <section className="media-panel">
      {result && (
        <p className={`actions__result ${result.ok ? 'is-ok' : 'is-error'}`} role="status">
          {result.ok ? result.message : result.error}
        </p>
      )}

      {canWrite && (
        <form action={onUpload} className="media-upload">
          <label className="field">
            <span>Add images</span>
            <input
              ref={fileInput}
              type="file"
              name="images"
              multiple
              // A hint to the picker, not a control: the server decides what the
              // file really is by decoding it.
              accept="image/jpeg,image/png,image/webp,image/avif"
              disabled={pending}
            />
          </label>
          <button type="submit" className="btn btn--primary" disabled={pending}>
            {pending ? 'Uploading…' : 'Upload'}
          </button>
          <p className="muted" aria-live="polite">
            {progress ??
              'JPEG, PNG, WebP or AVIF, up to 12 MB each. Location data is stripped on upload.'}
          </p>
        </form>
      )}

      {images.length === 0 ? (
        <p className="muted">
          No images yet. The storefront shows a placeholder until you add one — products with a
          photograph sell considerably better than products without.
        </p>
      ) : (
        <ol className="media-list">
          {images.map((image, index) => (
            <li key={image.id} className="media-item">
              {/* Plain <img>: this is the admin, the file is already optimised,
                  and the thumbnails are 72px. next/image here would add an
                  optimiser round trip per image for no benefit. */}
              <img
                className="media-item__thumb"
                src={
                  image.url.startsWith('http') ? image.url : `${storefrontOrigin}${image.url}`
                }
                alt=""
                width={72}
                height={72}
              />

              <div className="media-item__body">
                <span className="kpi__note">
                  {index === 0 ? 'Main image · shown on tiles and link previews' : `Position ${index + 1}`}
                  {image.width && image.height ? ` · ${image.width}×${image.height}` : ''}
                </span>

                <label className="field">
                  <span className="visually-hidden">Description for image {index + 1}</span>
                  <input
                    name="altText"
                    defaultValue={image.altText ?? ''}
                    maxLength={300}
                    disabled={!canWrite || pending}
                    placeholder="Describe the image — used by screen readers and search"
                    onBlur={(event) => {
                      if (!canWrite || event.target.value === (image.altText ?? '')) return;
                      const formData = new FormData();
                      formData.set('altText', event.target.value);
                      startTransition(async () =>
                        setResult(await setImageAltAction(image.id, slug, formData)),
                      );
                    }}
                  />
                </label>
              </div>

              {canWrite && (
                <div className="media-item__actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={pending || index === 0}
                    aria-label={`Move image ${index + 1} earlier`}
                    onClick={() => move(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={pending || index === images.length - 1}
                    aria-label={`Move image ${index + 1} later`}
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </button>

                  {confirming === image.id ? (
                    <>
                      <button
                        type="button"
                        className="btn btn--danger"
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () => {
                            setResult(await deleteImageAction(image.id, slug));
                            setConfirming(null);
                          })
                        }
                      >
                        Delete for good
                      </button>
                      <button type="button" className="btn" onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      disabled={pending}
                      aria-label={`Remove image ${index + 1}`}
                      onClick={() => setConfirming(image.id)}
                    >
                      Remove
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
