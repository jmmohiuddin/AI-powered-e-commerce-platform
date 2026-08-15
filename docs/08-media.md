# Product media

How a photograph gets from a merchant's phone to a shopper's screen, and why
each step is where it is.

Before this existed the storefront rendered no image anywhere. `media` rows
could only be written by the seed script, the admin had no upload control, and
both the product tile and the product page drew a hash-coloured gradient of a
generic phone. The `deviceSizes` / `imageSizes` / AVIF configuration in
`next.config.ts` was live but unreachable — nothing used `next/image` at all.

## The path

```
admin form  →  prepareImage()  →  MediaStorage.put()  →  addProductImage()  →  media row
                (validate,          (S3 or disk)          (inside withTenant)
                 strip EXIF,
                 measure, LQIP)
                                                                    ↓
storefront  ←  next/image  ←  imagesOf()  ←  hydrate()  ←──────────────
                (AVIF/WebP,     (fallback     (all rows, by position)
                 srcset)         chain)
```

| Step | Lives in |
| --- | --- |
| Validation, EXIF strip, resize, dimensions, blur | `packages/media/src/image.ts` |
| Object storage, pluggable | `packages/media/src/storage.ts` |
| AWS SigV4 signing | `packages/media/src/sigv4.ts` |
| `media` row writes | `packages/commerce/src/media.ts` |
| Admin actions | `apps/admin/src/app/products/media-actions.ts` |
| Admin UI | `apps/admin/src/app/products/[slug]/product-media.tsx` |
| Storefront rendering | `apps/storefront/src/components/product-image.tsx` |
| Storefront gallery | `apps/storefront/src/components/product-gallery.tsx` |

## Storage is configuration, not an import

`resolveStorage()` returns an S3-compatible driver when `S3_ENDPOINT`,
`S3_BUCKET` and both credentials are set, and a local-disk driver otherwise.
The provider is never named at a call site, so the same code runs against MinIO
locally, R2 or S3 in production, and the filesystem on a laptop with no Docker.

The disk driver is **development only**. Files land on one machine, so a second
instance serves 404s for everything the first accepted. `resolveStorage()`
throws rather than returning it when `NODE_ENV=production`.

SigV4 is implemented directly rather than via `@aws-sdk/client-s3` — roughly 40
transitive packages for three method calls. The algorithm is fixed and
published; the key derivation is checked against AWS's own vector in
`sigv4.test.ts`, and the assembled signature is proven by a real round trip
against MinIO in `storage.integration.test.ts`.

## Why EXIF is stripped in the pipeline, not as a step

A merchant photographing stock at home produces a file carrying the GPS
coordinates of their house. Re-encoding drops all metadata by default — `sharp`
preserves it only when asked — so the privacy property is a consequence of the
pipeline rather than a scrub someone can remove later. Orientation is the one
tag that must survive, and `rotate()` bakes it into the pixels before the rest
is discarded, otherwise every portrait photo lands sideways.

The format is decided by decoding the bytes, never by the filename or the
browser's `Content-Type`. SVG is refused because it is markup that can carry
script, and serving it from our own origin would hand an attacker same-origin
execution. GIF is refused because flattening an animation to a still silently
produces something the merchant did not upload.

## Getting it running locally

```sh
npm run infra:up          # starts MinIO and creates the voltix-media bucket
npm run dev:admin         # upload images on any product page
npm run dev               # see them render
```

`infra/docker-compose.yml` includes a `minio-init` service that creates the
bucket and makes it anonymously readable. Without it the first upload fails
with `NoSuchBucket`, which reads like a credentials problem and is not one.

To prove the upload path end to end:

```sh
npx vitest run packages/media
```

The S3 suite skips itself with a warning when MinIO is unreachable, so a green
run without containers is not evidence of anything.

## Two Next.js 16 settings this depends on

Both are non-obvious and both fail in ways that look like something else.

**`serverActions.bodySizeLimit`** (`apps/admin/next.config.ts`) — the default is
1 MB, smaller than essentially every photograph taken on a phone. Left alone,
uploads fail with a 413 that surfaces as a generic error. It is set to 16 MB,
sized for one image at a time; the admin form uploads sequentially rather than
sending a whole selection in one body.

**`images.dangerouslyAllowLocalIP`** (`apps/storefront/next.config.ts`) — Next 16
refuses to optimise an image whose hostname resolves to a private address,
because an open optimiser is an SSRF primitive. That default is correct and
stays on in production. Local MinIO is exactly the blocked case, so without the
development-only override every product image 400s with `"url" parameter is not
allowed`, which reads like a `remotePatterns` mistake. The exposure is bounded
by `remotePatterns`, which allowlists only the configured media origins.

## Sizing

`sizes` is derived from the real layout, not guessed. Getting it wrong ships
full-width files to phones and nothing looks broken — the tile renders, it just
costs the shopper several hundred kilobytes each. The target shopper is on
mobile data and gone by four seconds.

- **Tile** — `.product-grid` is `auto-fill, minmax(min(100%, 220px), 1fr)` in a
  1280px container, so the column count steps at 500 / 708 / 968 / 1204 px. The
  tile is *widest* on a narrow phone where it is the only column, which is where
  over-fetching costs most.
- **Product page** — one column below 900px, then a 1.1fr / 0.9fr split,
  settling at roughly 600px on a wide desktop.
- **Thumbnails** — a fixed 72px.

## Gallery behaviour

The thumbnail strip is a tablist: arrows move between thumbnails, Home and End
jump to the ends, and a roving `tabindex` means Tab moves *past* the gallery
rather than through every image in it.

Direction is read, not assumed. The strip uses logical properties so it mirrors
in Arabic for free — verified: at 1280px the first thumbnail sits at x=24 in
English and x=1169 in Arabic, with the rest descending. Arrow keys do *not*
mirror for free: a shopper pressing the left arrow means "the thumbnail to my
left", which in RTL is the *next* image, so the handler swaps them explicitly.

Counters go through `formatCount` rather than a bare `String()`, which pins
Western digits even in Arabic — a deliberate project decision documented in
`packages/ui/src/format.ts`. The gallery does not re-decide it.

Motion is CSS-only, so `prefers-reduced-motion` in `packages/ui/src/tokens.css`
already governs it.

## Fallback

Products with no photograph get `/product-placeholder.svg` — a real asset, with
`alt=""` because it says nothing about the product. It deliberately reads as
"no photograph yet" rather than as artwork: the previous generated gradient
looked like something the merchant had chosen, so a catalogue with no
photography looked finished and nobody fixed it.
