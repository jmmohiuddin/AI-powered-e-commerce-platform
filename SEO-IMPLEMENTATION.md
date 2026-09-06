# Voltix — SEO Implementation Log

Log of changes actually made to the codebase, in the order they happened. Each entry: what changed, why, how it was verified. See `SEO-CURRENT-STATE.md` for the audit these fixes respond to.

---

## Batch 1 — Technical quick wins (no business data required)

All changes are in `apps/storefront`. Verified with `npm run typecheck`, `npm run build`, and a live `next dev` smoke test (curl against `/`, a real product page, `/robots.txt`, `/sitemap.xml`, `/icon`, `/apple-icon`, `/opengraph-image`, `/manifest.webmanifest`) before being written up here.

1. **Favicon + app icons** — `src/app/icon.tsx`, `src/app/apple-icon.tsx` (new). None existed before; every tab/bookmark/home-screen icon fell back to the generic browser default. Generated in code (Next's `ImageResponse`) using the same accent-blue "V" already used for the "ix" in the header wordmark (`--colour-accent: #1d4ed8`, `packages/ui/src/tokens.css`) — not a new visual identity, the existing one.
2. **Web manifest** — `src/app/manifest.ts` (new). Name/description reuse the real site copy already in `layout.tsx`; theme colours match the existing `viewport.themeColor`.
3. **Open Graph fallback image** — `src/app/opengraph-image.tsx` (new). Applies to any route that doesn't set its own (homepage, category pages, static content pages) — previously these had **no** share-preview image at all. Copy is the existing homepage hero line, not new marketing text. Product pages are unaffected — they already set their own images from real product photos.
4. **Homepage metadata** — `src/app/page.tsx`: added `generateMetadata()`. Previously the homepage had no metadata export at all and silently inherited the layout's static (English-only) default, including on the Arabic render. Now locale-aware, reuses the existing `home.heroTitle`/`home.heroBody` translated strings, and sets its own canonical.
5. **Twitter Card metadata** — `src/app/layout.tsx` (site default), `src/app/page.tsx`, `src/app/products/[slug]/page.tsx`, `src/app/category/[...slug]/page.tsx`. There was none anywhere before. No `site`/`creator` handle is set — Voltix has no confirmed X account, and guessing one would misattribute the page. **Found and fixed a real bug while doing this**: Next does not deep-merge a page's `twitter` object with the layout's, so a page declaring `twitter: {title, description}` without repeating `card: 'summary_large_image'` silently downgrades to the small `summary` card. Verified via live curl on both the homepage and a real product page.
6. **Organization + WebSite JSON-LD** — `src/app/layout.tsx`. There was no site-wide identity schema anywhere. Built the same way the footer already builds its legal disclosure line: every field is either a fixed fact already in the codebase (brand name, description, URL) or read from `merchantIdentity()`/`lib/contact.ts` and *omitted* — not placeholder-filled — when unset (legal name, phone, email). No `address` or `sameAs` yet: no verified street address or social profile exists in the codebase to put there (see SEO-CURRENT-STATE.md §5). `WebSite` includes a `SearchAction` pointing at the real, working `/search?q=` search.
7. **BreadcrumbList on the product page** — `src/app/products/[slug]/page.tsx`. The category page already emitted this; the product page had a visible breadcrumb with no matching structured data. Uses the same two-hop trail already rendered in the visible `<nav>` (same URLs, same labels) — no mismatch between what a visitor sees and what a crawler is told.
8. **Sitemap coverage** — `src/app/sitemap.ts`: added `/privacy` and `/terms`, the two static pages that existed but weren't listed.

**Not touched in this batch, and why**: `/search`, `/cart`, `/checkout`, `/orders` stay out of the sitemap and `noindex`/disallowed — that was already correct. hreflang's same-URL limitation, the missing blog/content system, and the cookie-based (not path-based) locale split are real gaps but are architectural decisions, not quick fixes — flagged in `SEO-CURRENT-STATE.md` for a deliberate decision, not silently changed here.

## Pending — blocked on information only the business owner can supply

Nothing below can proceed without real, verified data (see the "NEEDS VERIFICATION" table in `SEO-CURRENT-STATE.md §5`). Implementing any of it now would mean writing an address, phone number, or TRN into schema markup and a footer without a real source — this codebase already has strong conventions against exactly that (`lib/merchant.ts`, `lib/contact.ts`, both documented "unset renders nothing, never a placeholder"), and this project's own rules explicitly forbid inventing business facts.

- Physical store address (for `LocalBusiness`/`Store` schema, an About/Store page, Google Business Profile alignment)
- Phone number, support email, WhatsApp number (`.env`: `NEXT_PUBLIC_SUPPORT_PHONE`, `NEXT_PUBLIC_SUPPORT_EMAIL`, `NEXT_PUBLIC_WHATSAPP_NUMBER`)
- Legal name and UAE TRN (`.env`: `MERCHANT_LEGAL_NAME`, `MERCHANT_TRN` — or the `tenants` DB row `lib/merchant.ts` reads from)
- Physical store opening hours
- Google Maps URL / place ID / coordinates
- Verified social media profile URLs (only ones that actually exist)
- Confirmation of the live production domain, so `STOREFRONT_URL` and `infra/production/.env.production.example` can be updated from their current placeholders
