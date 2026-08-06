import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatCount, formatPrice, formatRating } from '@voltix/ui';
import { BuyBox } from '@/components/buy-box';
import { ProductCard, availabilityLabels } from '@/components/product-card';
import { getProduct, relatedProducts, totalAvailable } from '@/lib/catalog';
import { localise } from '@/lib/types';
import { resolveLocale, translator } from '@/lib/locale';

type Params = Promise<{ slug: string }>;

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
    },
  };
}

export default async function ProductPage({ params }: { params: Params }) {
  const { slug } = await params;
  const locale = await resolveLocale();
  const t = translator(locale);

  const raw = await getProduct(slug);
  if (!raw) notFound();

  const product = localise(raw, locale);
  const rating = formatRating(product.ratingAverage, locale);
  const related = await relatedProducts(raw);
  const available = totalAvailable(product);

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
      <script
        type="application/ld+json"
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
          <ProductHero title={product.title} alt={product.imageAlt} seed={product.id} />
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
            whatsappNumber="971500000000"
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

          {Object.keys(product.specs).length > 0 && (
            <section style={{ marginTop: 'var(--space-6)' }}>
              <h2 style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--space-3)' }}>
                {t('product.specifications')}
              </h2>
              <table className="spec-table">
                <tbody>
                  {Object.entries(product.specs).map(([key, value]) => (
                    <tr key={key}>
                      <th scope="row">{key}</th>
                      <td>{value}</td>
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
        <div className="product-grid">
          {[
            {
              title: 'Same-day in Dubai',
              body: 'Order before 2pm for same-day delivery in Dubai, next day to Abu Dhabi and Sharjah.',
            },
            {
              title: 'Card, Apple Pay or Tabby',
              body: 'Pay in full, or split into four interest-free payments with Tabby.',
            },
            {
              title: 'Cash on delivery',
              body: 'Available across all seven emirates. Check the box before you pay.',
            },
            {
              title: 'Official UAE warranty',
              body: `${product.warrantyMonths ?? 12} months, with the IMEI recorded against your order.`,
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

function ProductHero({ title, alt, seed }: { title: string; alt: string; seed: string }) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const id = seed.replace(/[^a-zA-Z0-9-]/g, '');

  return (
    <svg viewBox="0 0 200 200" role="img" aria-label={alt}>
      <title>{title}</title>
      <defs>
        <linearGradient id={`hero-${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={`hsl(${hue} 62% 62%)`} />
          <stop offset="100%" stopColor={`hsl(${(hue + 40) % 360} 58% 44%)`} />
        </linearGradient>
      </defs>
      <rect x="52" y="16" width="96" height="168" rx="18" fill={`url(#hero-${id})`} />
      <rect x="62" y="30" width="76" height="126" rx="8" fill="rgba(255,255,255,0.92)" />
      <circle cx="100" cy="170" r="7" fill="rgba(255,255,255,0.85)" />
    </svg>
  );
}
