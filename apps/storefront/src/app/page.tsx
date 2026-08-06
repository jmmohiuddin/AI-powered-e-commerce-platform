import Link from 'next/link';
import { ProductCard } from '@/components/product-card';
import { listCategories, listProducts } from '@/lib/catalog';
import { resolveLocale, translator } from '@/lib/locale';

/**
 * Homepage.
 *
 * Revalidated rather than fully static, because the locale is read from a
 * cookie in the root layout — see the trade-off note in lib/locale.ts. Content
 * is still cached and served from the edge between revalidations; personalised
 * strips are deliberately absent from the initial render and stream in as
 * separate islands, because making the whole homepage dynamic to personalise
 * one row is the trade that quietly destroys LCP on commerce sites.
 */
export const revalidate = 300;

export default async function HomePage() {
  const locale = await resolveLocale();
  const t = translator(locale);
  const [products, categories] = await Promise.all([listProducts(), listCategories()]);
  const deals = products.filter((p) => p.compareAtPrice);

  return (
    <>
      <section className="container hero">
        <div>
          <h1>{t('home.heroTitle')}</h1>
          <p>{t('home.heroBody')}</p>
          <div className="hero__cta">
            <Link className="button button--primary" href="/search?category=smartphones">
              {t('home.shopPhones')}
            </Link>
            <a className="button button--whatsapp" href="https://wa.me/971500000000">
              {t('home.whatsapp')}
            </a>
          </div>
        </div>

        <div className="hero__panel">
          <h2>{t('home.whyTitle')}</h2>
          <ul>
            <li>
              <strong>Official UAE warranty</strong> — every handset carries the manufacturer’s
              regional warranty, with the IMEI recorded against your order.
            </li>
            <li>
              <strong>Delivered across all seven emirates</strong> — same-day in Dubai on orders
              before 2pm, next day to Abu Dhabi and Sharjah.
            </li>
            <li>
              <strong>Pay how you like</strong> — card, Apple Pay, Tabby in four instalments, or
              cash on delivery.
            </li>
            <li>
              <strong>Real stock counts</strong> — if the site says three left, there are three.
            </li>
          </ul>
        </div>
      </section>

      <section className="container section">
        <div className="section__head">
          <h2>{t('home.categories')}</h2>
          <Link href="/search">{t('home.browseAll')}</Link>
        </div>
        <div className="product-grid">
          {categories.map((category) => (
            <Link
              key={category.slug}
              href={`/search?category=${category.slug}`}
              className="product-card"
              style={{ padding: 'var(--space-5)' }}
            >
              <strong style={{ fontSize: 'var(--text-lg)' }}>{category.name}</strong>
              <span style={{ color: 'var(--colour-text-subtle)', fontSize: 'var(--text-sm)' }}>
                {category.count}{' '}
                {category.count === 1 ? t('search.product') : t('search.products')}
              </span>
            </Link>
          ))}
        </div>
      </section>

      {deals.length > 0 && (
        <section className="container section">
          <div className="section__head">
            <h2>{t('home.deals')}</h2>
            <Link href="/search?sort=price_asc">{t('home.allDeals')}</Link>
          </div>
          <div className="product-grid">
            {deals.map((product) => (
              <ProductCard key={product.id} product={product} locale={locale} t={t} />
            ))}
          </div>
        </section>
      )}

      <section className="container section">
        <div className="section__head">
          <h2>{t('home.popular')}</h2>
          <Link href="/search?sort=rating">{t('home.topRated')}</Link>
        </div>
        <div className="product-grid">
          {products.map((product) => (
            <ProductCard key={product.id} product={product} locale={locale} t={t} />
          ))}
        </div>
        <p className="vat-note" style={{ marginTop: 'var(--space-4)' }}>
          {t('vat.inclusive')}
        </p>
      </section>
    </>
  );
}
