import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { formatCount, formatPrice, formatRating } from '@voltix/ui';
import { BuyBox } from '@/components/buy-box';
import { ProductCard, availabilityLabels } from '@/components/product-card';
import { ProductGallery } from '@/components/product-gallery';
import { getProduct, relatedProducts, totalAvailable } from '@/lib/catalog';
import { imagesOf, localise, PLACEHOLDER_IMAGE, specsOf, type ProductView } from '@/lib/types';
import { directionOf, resolveLocale, translator } from '@/lib/locale';
import { trackAfterRender } from '@/lib/analytics';
import { pageVisitor } from '@/lib/visitor';

type Params = Promise<{ slug: string }>;

/**
 * A uuid, and not a slug wearing one.
 *
 * The catalogue falls back to a hard-coded demo set outside production, and
 * those products carry slug-shaped ids. `analytics_events.product_id` is a uuid
 * column, so passing one through would throw inside the writer — swallowed, but
 * once per view, and it would fill the logs with a failure that is not a
 * failure. The same guard already governs `relatedProducts` in lib/catalog.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Product photographs as absolute URLs, for Open Graph.
 *
 * The placeholder is excluded rather than shared: a preview card showing "no
 * image available" is worse than a preview card with no image, which at least
 * falls back to the site-level default.
 */
function openGraphImages(product: ProductView) {
  const origin = (process.env.STOREFRONT_URL || 'http://localhost:3000').replace(/\/$/, '');
  return imagesOf(product)
    .filter((image) => image.url !== PLACEHOLDER_IMAGE)
    .slice(0, 4)
    .map((image) => ({
      url: image.url.startsWith('http') ? image.url : `${origin}${image.url}`,
      alt: image.alt,
      ...(image.width && image.height ? { width: image.width, height: image.height } : {}),
    }));
}

/**
 * Product detail page.
 *
 * Revalidated on a 60-second floor, so a price change propagates within a
 * minute rather than on the next deploy. Prices displayed here are
 * informational; the authoritative price is recomputed server-side by the
 * pricing engine before payment is authorised, so a stale cached page can never
 * result in a wrong charge — only a stale display that corrects itself at
 * checkout.
 */
export const revalidate = 60;

const VAT_RATE_BPS = Number(process.env.VAT_RATE_BPS ?? 500);

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProduct(slug);
  if (!product) return { title: 'Product not found' };

  return {
    title: product.title,
    description: product.subtitle ?? product.description.slice(0, 155),
    alternates: {
      canonical: `/products/${product.slug}`,
      // Both locales serve from the same URL, distinguished by the cookie.
      // Declared so search engines know an Arabic rendering exists rather than
      // treating the page as English-only.
      languages: { 'en-AE': `/products/${product.slug}`, 'ar-AE': `/products/${product.slug}` },
    },
    openGraph: {
      title: product.title,
      description: product.subtitle ?? product.description.slice(0, 200),
      type: 'website',
      /**
       * Now that products have real photographs, share them. A link pasted into
       * WhatsApp — which is how a large share of this market sends a product to
       * a friend — previews as a bare title without this, and a preview with no
       * picture is the one that does not get tapped.
       *
       * Absolute, because Open Graph consumers do not resolve relative URLs.
       */
      images: openGraphImages(product),
    },
  };
}

export default async function ProductPage({ params }: { params: Params }) {
  const { slug } = await params;
  const locale = await resolveLocale();
  const t = translator(locale);
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  const raw = await getProduct(slug);
  if (!raw) notFound();

  const product = localise(raw, locale);
  const specs = specsOf(product);
  const rating = formatRating(product.ratingAverage, locale);
  const related = await relatedProducts(raw);
  const available = totalAvailable(product);

  /**
   * THE TOP OF THE FUNNEL.
   *
   * Written after the response rather than during it, and only for a request
   * that is plausibly a person — see lib/analytics.ts for the first and
   * lib/visitor.ts for the second. Both conditions are refusals to record
   * rather than attempts to enrich: a view that cannot be attributed to a
   * shopping session is not counted, because a `product_viewed` whose session
   * id never appears on a `checkout_started` contributes nothing to a funnel
   * and quietly inflates its denominator.
   *
   * That cookie only exists after a shopper's first cart action, so this counts
   * views by browsers that already have a basket — NOT visits by strangers, and
   * NOT a usable denominator for a view-to-cart conversion rate. The full
   * reasoning, and what these rows can and cannot answer, is on
   * `AnalyticsEventType` in packages/commerce/src/analytics.ts.
   *
   * The variant recorded is the default one — the price and SKU this render
   * actually put in front of the shopper. Which variant they went on to select
   * is client state, and the event that knows it is `checkout_started`.
   *
   * Facts only, no personal data: the brand, category and stock state of what
   * was shown, plus the language it was shown in. "Views of products that were
   * out of stock" is a merchandising defect somebody can act on, which is the
   * bar every event here is held to.
   */
  const visitor = await pageVisitor();
  if (!visitor.automated && visitor.sessionId && UUID.test(raw.id)) {
    const variantId = raw.variants[0]?.id;
    trackAfterRender(`product_viewed:${raw.id}`, {
      type: 'product_viewed',
      sessionId: visitor.sessionId,
      productId: raw.id,
      ...(variantId && UUID.test(variantId) ? { variantId } : {}),
      properties: {
        slug: raw.slug,
        brand: raw.brand,
        category: raw.categorySlug,
        inStock: available > 0,
        locale,
      },
    });
  }

  /**
   * Structured data serves two audiences that want different things:
   *
   *  • `Product` + `AggregateOffer` — search engines, for the rich result
   *    (price, availability, rating stars).
   *  • `FAQPage` — assistants answering "does the S25 Ultra support 5G?"
   *    without the shopper loading a page at all. The facts are curated per
   *    product rather than scraped from prose, because an assistant quoting a
   *    hallucinated spec attributes it to the merchant.
   *
   * `priceCurrency` is AED and prices are VAT-inclusive, matching what UAE law
   * requires the shopper to be shown. A feed that publishes ex-VAT prices while
   * the page shows inclusive ones gets penalised for price mismatch.
   */
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Product',
        name: product.title,
        description: product.description,
        brand: { '@type': 'Brand', name: product.brand },
        sku: product.variants[0]?.sku,
        category: product.category,
        offers: {
          '@type': 'AggregateOffer',
          priceCurrency: product.currency,
          lowPrice: (Math.min(...product.variants.map((v) => v.price)) / 100).toFixed(2),
          highPrice: (Math.max(...product.variants.map((v) => v.price)) / 100).toFixed(2),
          offerCount: product.variants.length,
          availability:
            available > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
          areaServed: 'AE',
        },
        ...(product.ratingAverage
          ? {
              aggregateRating: {
                '@type': 'AggregateRating',
                ratingValue: (product.ratingAverage / 100).toFixed(1),
                reviewCount: product.ratingCount,
              },
            }
          : {}),
      },
      {
        '@type': 'FAQPage',
        mainEntity: product.answerableFacts.map((fact) => ({
          '@type': 'Question',
          name: fact.question,
          acceptedAnswer: { '@type': 'Answer', text: fact.answer },
        })),
      },
    ],
  };

  return (
    <>
      {/* Next nonces its own bootstrap scripts but not ones the application
          writes itself, so this block is the single violation keeping the CSP
          in report-only mode. The nonce comes from the request headers the
          proxy stamped — see proxy.ts. */}
      <script
        type="application/ld+json"
        nonce={nonce}
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <nav className="container breadcrumb" aria-label="Breadcrumb">
        <ol>
          <li>
            <Link href="/">Home</Link>
          </li>
          <li>
            <Link href={`/search?category=${product.categorySlug}`}>{product.category}</Link>
          </li>
          <li aria-current="page">{product.title}</li>
        </ol>
      </nav>

      <div className="container pdp">
        <div className="pdp__media">
          <ProductGallery
            images={imagesOf(product)}
            locale={locale}
            direction={directionOf(locale)}
            strings={{ gallery: t('product.gallery'), imageOf: t('product.imageOf') }}
          />
        </div>

        <div>
          <p className="product-card__brand">{product.brand}</p>
          <h1 className="pdp__title">{product.title}</h1>
          {product.subtitle && <p className="pdp__subtitle">{product.subtitle}</p>}

          {rating && (
            <p className="rating" style={{ marginTop: 'var(--space-3)' }}>
              <span className="rating__star" aria-hidden="true">
                ★
              </span>
              {rating} {t('product.outOf5')} · {formatCount(product.ratingCount, locale)}{' '}
              {t('product.reviews')}
            </p>
          )}

          <BuyBox
            variants={product.variants}
            currency={product.currency}
            productTitle={product.title}
            vatRateBps={VAT_RATE_BPS}
            locale={locale}
            availability={availabilityLabels(t)}
            strings={{
              chooseOption: t('product.chooseOption'),
              outOfStock: t('product.outOfStock'),
              vatInclusive: t('vat.inclusive'),
              quantity: t('product.quantity'),
              addToCart: t('product.addToCart'),
              whatsapp: t('home.whatsapp'),
              trustCod: t('trust.cod'),
              trustDispatch: t('trust.dispatch'),
              trustReplacement: t('trust.replacement'),
            }}
          />

          <section style={{ marginTop: 'var(--space-6)' }}>
            <h2 style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--space-3)' }}>
              {t('product.whatYouGet')}
            </h2>
            <ul className="highlight-list">
              {product.highlights.map((highlight) => (
                <li key={highlight}>{highlight}</li>
              ))}
            </ul>
            <p style={{ marginTop: 'var(--space-4)', color: 'var(--colour-text-muted)' }}>
              {product.description}
            </p>
          </section>

          {/* Key specs lead, then the rest in the merchant's order — `specsOf`
              owns that arrangement so the demo catalogue and a database product
              render the same way.

              The section is gated on having something to put in it: an empty
              table under a "Specifications" heading reads as a broken page
              rather than as a product nobody has specified yet. Warranty counts
              towards that — it is a specification a shopper compares on, and it
              used to disappear whenever the attribute rows were missing, which
              against a real database was always. */}
          {(specs.length > 0 || product.warrantyMonths) && (
            <section style={{ marginTop: 'var(--space-6)' }}>
              <h2 style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--space-3)' }}>
                {t('product.specifications')}
              </h2>
              <table className="spec-table">
                <tbody>
                  {specs.map((spec) => (
                    <tr key={spec.key}>
                      <th scope="row">{spec.label}</th>
                      <td>{spec.value}</td>
                    </tr>
                  ))}
                  {product.warrantyMonths && (
                    <tr>
                      <th scope="row">{t('product.warranty')}</th>
                      <td>
                        {formatCount(product.warrantyMonths, locale)} {t('product.months')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>
          )}

          {product.answerableFacts.length > 0 && (
            <section style={{ marginTop: 'var(--space-6)' }}>
              <h2 style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--space-3)' }}>
                {t('product.commonQuestions')}
              </h2>
              <dl style={{ display: 'grid', gap: 'var(--space-4)' }}>
                {product.answerableFacts.map((fact) => (
                  <div key={fact.question}>
                    <dt style={{ fontWeight: 560 }}>{fact.question}</dt>
                    <dd style={{ color: 'var(--colour-text-muted)', marginInlineStart: 0 }}>
                      {fact.answer}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </div>
      </div>

      {related.length > 0 && (
        <section className="container section">
          <div className="section__head">
            <h2>{t('product.related')}</h2>
          </div>
          <div className="product-grid">
            {related.map((item) => (
              <ProductCard key={item.id} product={item} locale={locale} t={t} />
            ))}
          </div>
        </section>
      )}

      <section className="container section">
        <div className="section__head">
          <h2>{t('product.deliveryPayment')}</h2>
        </div>
        {/*
          THE IMEI CLAIM WAS REMOVED FROM THE WARRANTY CARD. DO NOT PUT IT BACK.

          It read "{n} months, with the IMEI recorded against your order." No
          code writes to `serial_units`, so no IMEI is recorded against any
          order — see the fuller note in app/page.tsx for the three things that
          would have to become true first, and for why gating on
          `variants.isSerialised` would not make the sentence true. Debt P-03,
          requirement C-05.

          The warranty *length* is real, so it stays: it comes from
          `products.warrantyMonths`, defaulted from `brands.defaultWarrantyMonths`.
        */}
        <div className="product-grid">
          {[
            { title: t('product.dpDeliveryTitle'), body: t('product.dpDeliveryBody') },
            { title: t('product.dpPaymentTitle'), body: t('product.dpPaymentBody') },
            { title: t('product.dpCodTitle'), body: t('product.dpCodBody') },
            {
              title: t('product.dpWarrantyTitle'),
              body: t('product.dpWarrantyBody', { n: product.warrantyMonths ?? 12 }),
            },
          ].map((item) => (
            <div key={item.title} className="product-card" style={{ padding: 'var(--space-5)' }}>
              <strong>{item.title}</strong>
              <p style={{ color: 'var(--colour-text-muted)', fontSize: 'var(--text-sm)' }}>
                {item.body}
              </p>
            </div>
          ))}
        </div>
        <p className="vat-note" style={{ marginTop: 'var(--space-4)' }}>
          {t('vat.inclusive')}
        </p>
      </section>
    </>
  );
}
