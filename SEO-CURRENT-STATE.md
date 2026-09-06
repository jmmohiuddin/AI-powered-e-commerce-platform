# Phoyev — SEO Current-State Audit (Phase 0: Discover)

Audited: 2026-09-06. Scope: `apps/storefront` (public-facing site). Method: direct codebase inspection (grep/read), no assumptions. Every claim below is sourced to a file:line; anything not found is marked **NOT FOUND**.

---

## 1. Technical architecture

- **Framework**: Next.js 16.3 (App Router), React 19.2, TypeScript 5.9. No Pages Router.
- **Rendering**: every route is effectively **dynamic/SSR per-request**, not static/ISR, because the root layout calls `cookies()` to read the locale cookie (`src/app/layout.tsx`, `src/lib/locale.ts:41`) — this makes the whole tree dynamic in Next.js regardless of per-page `revalidate` exports (which exist on home/PDP but have no effect). No `generateStaticParams` anywhere — nothing is pre-rendered at build time. Documented explicitly in a code comment in `src/proxy.ts`.
- **Route tree**: `/`, `/category/[...slug]`, `/products/[slug]`, `/search`, `/cart`, `/checkout` (+return, confirmation, invoice), `/orders`, `/contact`, `/delivery`, `/returns`, `/privacy`, `/terms`, plus API/webhook/cron routes. **No `/about` page. No blog/guides.**
- **robots.txt**: generated (`src/app/robots.ts`). Disallows `/search`, `/orders`, `/checkout`, `/cart`, `/api/`. Points at `sitemap.xml` and `host`, both from `STOREFRONT_URL`.
- **sitemap.xml**: generated (`src/app/sitemap.ts`), single file (no index/chunking — fine at ~147 products, no infra to grow past it). Includes `/`, all category paths, all product slugs (real `lastModified`), plus `/contact`, `/delivery`, `/returns`. **Excludes `/privacy`, `/terms`.** DB failures degrade gracefully (`.catch(() => [])`) rather than 500ing.
- **Canonical URLs**: set on product and category pages via `alternates.canonical`. Paginated category pages self-canonicalize per page (deliberate, documented choice — avoids Google dropping pages 2+ from the index). **No canonical on `/search`, `/cart`, `/checkout`, `/orders`, or the static content pages.**
- **Redirects**: none in Next config. `www` → non-www is handled at the Caddy layer (301, `infra/production/Caddyfile`). HTTPS is automatic via Caddy.
- **Security headers**: set in `next.config.ts` (HSTS, X-Frame-Options, etc.) and via a nonce-based CSP in `src/proxy.ts`. Solid.
- **Analytics / Search Console**: **no GA4, GTM, or Search Console verification found anywhere.** There is a first-party, self-hosted event log (`src/lib/analytics.ts`) writing to Postgres — not a substitute for GSC (which is the only source of real Google query/ranking data).
- **i18n**: two locales (`en-AE`, `ar-AE`), **cookie-based, not path-based** — no `/[locale]/...` segments. `hreflang`/`alternates.languages` are emitted on product/category pages and in the sitemap, but **every language variant points at the identical URL**, which means the hreflang annotations are currently non-functional for crawlers (there's nothing to actually distinguish). This is a known, documented trade-off in the code (comment says the migration to path-based locales is "mechanical when evidence arrives"). RTL (`dir` attribute) and `lang` are correctly set.

## 2. Metadata & Open Graph

- Root layout sets sitewide defaults: title template `%s · Phoyev`, one fixed description, `openGraph.siteName: 'Phoyev'`, `locale: en_AE` / `alternateLocale: ar_AE`, `robots: index,follow`.
- **Homepage has no `generateMetadata` at all** — it silently inherits the layout defaults. No homepage-specific canonical either.
- **Product pages**: genuinely unique metadata, sourced from real DB fields (title, subtitle/description, OG images from real product photos). Good.
- **Category pages**: unique metadata *only if* the category's `metaTitle`/`metaDescription` DB columns are populated; otherwise falls back to a single templated i18n string shared by every category missing curated copy.
- **No Twitter Card metadata anywhere** in the codebase.
- **No OG image at all for homepage or category pages** (no fallback image file, no `opengraph-image.tsx`). Product pages use real photos, filtering out the placeholder — so a product with only a placeholder image has no OG image either.
- **No favicon.ico, no site.webmanifest, no apple-touch-icon** — none of Next's icon file conventions exist in `apps/storefront` at all.

## 3. Structured data (JSON-LD)

Only two emission points in the entire repo:

- **Product page**: `@graph` with `Product`, `Brand`, `AggregateOffer` (price range, availability, `areaServed: AE`), conditional `AggregateRating`, and `FAQPage` (from real `answerableFacts` data). No `BreadcrumbList` here despite a visible breadcrumb existing on the same page.
- **Category page**: `BreadcrumbList` only.

**Missing entirely**: `Organization`, `WebSite` (+ `SearchAction`), `LocalBusiness`/`Store` schema. There is no site-wide identity schema at all — nothing tells Google or an AI crawler what Phoyev *is*, where it operates, or how to contact it.

## 4. Content architecture & e-commerce SEO

- URLs are human-readable, keyword-based slugs (`slugify()`, `packages/commerce/src/catalogue.ts`), immutable once published, deduplicated with `-2`/`-3` suffixes. **One real gap**: a product titled only in Arabic slugifies to an empty string and falls back to a timestamp-based slug (`product-1699999999`) — loses all keyword value for that product's URL.
- Faceted nav (brand/price/stock/sort filters) uses query params and is correctly `noindex`'d when any filter is active (`isIndexableListing()`) — this is already handling a common e-commerce SEO failure mode correctly.
- Pagination is query-param based, no `rel=next/prev`, but each page self-canonicalizes (a valid, deliberate alternative).
- Product data model is rich: title, description, brand, per-variant SKU, specs/attributes, real stock availability, warranty terms, AI-generated `aeoFacts`/`answerableFacts` fields already exist in the schema (`packages/db` migrations) and are already surfaced into the FAQPage schema on product pages.
- **No blog/guides/content section exists.** This is the single biggest gap for the content-strategy, AEO, and topical-authority phases of this project.
- Demo/fallback catalogue exists in code but is production-gated: an empty production DB renders as an empty catalogue to a crawler, never fabricated demo products (`apps/storefront/src/lib/catalog.ts`). No risk here.
- Internal linking: breadcrumbs, related products, footer/header category links all exist.
- Custom 404 page exists with a "browse all products" CTA.

## 5. Business identity / NAP — ⚠️ the critical gap

This is the most important finding in this audit, because it blocks Local SEO, Entity SEO, LocalBusiness schema, AEO ("where is Phoyev located?"), and correct invoicing simultaneously.

**Confirmed present and real (safe to use):**
- Brand name **"Phoyev"** — used pervasively and correctly.
- Business description: "UAE electronics & mobile retail" — consistent across `package.json`, `README.md`, and the site's meta description.
- Delivery: **all seven emirates** (`apps/storefront/src/app/delivery/page.tsx`) — UAE-wide, not Dubai-only.
- Payment methods **actually live today: cash on delivery only.** Stripe, Network International, Tabby, and PayTabs are all wired in code but every credential is blank in `.env` — so any "we accept cards / Tabby" copy on the site is currently describing capability, not current reality.
- Return policy and warranty policy pages exist with real (non-fabricated) copy pulled from shared constants.

**NEEDS VERIFICATION — confirmed absent from the codebase, currently blank/placeholder:**
| Field | Status |
|---|---|
| Legal business name | Blank in `.env` (`MERCHANT_LEGAL_NAME=`). "Semul Miah Electronics Trading L.L.C" exists only as mockup text in a design doc, never as live config. |
| Physical address | Not configured anywhere (`merchant.ts` reads from DB, currently unset). "Shop 12, Naif, Deira, Dubai" exists only in the same mockup doc. |
| Phone number | Blank (`NEXT_PUBLIC_SUPPORT_PHONE=`). Contact page currently shows "Contact details are not configured yet." |
| Email address | Blank. Code fallbacks use `example.com`/`example.ae` placeholder domains. |
| WhatsApp number | Blank (`NEXT_PUBLIC_WHATSAPP_NUMBER=`). |
| Opening hours (store) | Not present anywhere. (Support-channel hours exist as copy — "Sun–Thu 9am–6pm GST" for phone, "9am–9pm" for WhatsApp — but these describe support availability, not the physical shop.) |
| Google Maps URL / place ID / lat-long | Not present anywhere in the codebase. |
| UAE TRN | Blank (`MERCHANT_TRN=`). Example TRNs in docs/tests belong to two different fictional companies — confirms they're illustrative only. |
| Social media profile links | Not present. Instagram/Facebook/etc. only exist as a marketing-channel *enum type* in the DB schema, not as actual profile URLs. |
| Production domain | `.env` has `STOREFRONT_URL=http://localhost:3000`. `infra/production/.env.production.example` uses placeholder domains (`example.ae`). **`phoyev.ae` appears nowhere as configured value** — only in code comments/test fixtures as an illustrative string. `phoyev.com` (prior deployment target) does not appear anywhere in this repo. |
| About page | Does not exist. |

**What this means concretely**: right now, if a customer or an AI assistant asks "where is Phoyev's store?" or "what's Phoyev's phone number?", the live site has no answer anywhere — the contact page explicitly renders a placeholder notice instead of contact info. No LocalBusiness schema can be honestly written today because there is no configured address to put in it.

---

## Major problems (unranked here — see prioritized plan)

1. No business NAP (name/address/phone) configured anywhere → blocks Local SEO, LocalBusiness schema, AEO location answers entirely.
2. No production domain configured → `phoyev.ae` isn't wired into `.env`/infra, so canonical URLs, sitemap, robots.txt `host`, and OG URLs all currently resolve against `localhost:3000`.
3. No `Organization`/`WebSite`/`LocalBusiness` JSON-LD anywhere.
4. No favicon/manifest at all.
5. Homepage has zero unique metadata (title/description/canonical/OG image).
6. No Twitter Card metadata site-wide.
7. hreflang is present but non-functional (all locale variants point at the same URL).
8. No blog/content system — zero informational/AEO/GEO content surface.
9. No About page.
10. No Google Search Console / GA4 — no real ranking, query, or CWV field data available.
11. Arabic-titled products lose their slug (fallback to timestamp).
12. Product page breadcrumb has no matching `BreadcrumbList` schema (category page does).

## Quick wins (no new business data required)

- Add favicon + manifest.
- Add homepage `generateMetadata` (unique title/description/canonical) + a static OG fallback image.
- Add Twitter Card metadata site-wide.
- Add `BreadcrumbList` JSON-LD to the product page (data already available — same pattern as category page).
- Add `WebSite` JSON-LD with `SearchAction` pointing at `/search`.
- Include `/privacy` and `/terms` in the sitemap.

## High-impact changes (blocked on your input)

- Populate real NAP data → enables `LocalBusiness`/`Organization` schema, a real About page, a functional Contact page, correct invoices, and every Dubai/Deira/UAE local-SEO claim in later phases.
- Wire the real production domain into `.env`/`infra/production` → everything currently pointed at `localhost:3000` becomes correct.
- Decide whether to invest in path-based locales (`/[locale]/...`) to make hreflang actually functional — this is a real migration, not a quick fix.
- Stand up a blog/content section if UAE content-marketing investment is wanted.

## Risks noted

- Changing `STOREFRONT_URL`/domain touches CSP, canonical URLs, sitemap `host`, and OG absolute URLs simultaneously — needs to be done as one coordinated change, tested before deploy.
- Any schema/contact/about work must wait on verified business data — inventing it would violate Google's spam policies (fake business info) and could get Phoyev penalized or its Google Business Profile suspended.

---

*Next: SEO-AUDIT.md (scored), then a prioritized implementation plan (P0–P3), pending the business-data confirmation below.*
