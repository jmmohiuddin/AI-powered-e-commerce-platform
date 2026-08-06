import type { Metadata } from 'next';
import Link from 'next/link';
import { ProductCard } from '@/components/product-card';
import { formatCount, formatPrice } from '@voltix/ui';
import { searchProducts } from '@/lib/catalog';
import type { SearchFilters } from '@/lib/types';
import { resolveLocale, translator } from '@/lib/locale';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const params = await searchParams;
  const query = typeof params.q === 'string' ? params.q : undefined;
  return {
    title: query ? `Search: ${query}` : 'Browse products',
    // Search result pages are noindex on purpose: they generate unbounded
    // near-duplicate URLs that dilute crawl budget and read as thin content.
    // Category pages are the indexable surface.
    robots: { index: false, follow: true },
  };
}

export default async function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const locale = await resolveLocale();
  const t = translator(locale);
  const filters = parseFilters(params);
  const result = await searchProducts(filters);

  return (
    <div className="container listing">
      <aside className="facets" aria-label={t('search.filter')}>
        <div>
          <h3>{t('search.category')}</h3>
          <ul>
            <li>
              <Link
                href={buildHref(filters, { category: undefined })}
                aria-current={!filters.category}
              >
                {t('search.allCategories')}
              </Link>
            </li>
            {result.facets.categories.map((facet) => (
              <li key={facet.slug}>
                <Link
                  href={buildHref(filters, { category: facet.slug })}
                  aria-current={filters.category === facet.slug}
                >
                  {facet.value} <span>{formatCount(facet.count, locale)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3>{t('search.brand')}</h3>
          <ul>
            <li>
              <Link href={buildHref(filters, { brand: undefined })} aria-current={!filters.brand}>
                {t('search.allBrands')}
              </Link>
            </li>
            {result.facets.brands.map((facet) => (
              <li key={facet.value}>
                <Link
                  href={buildHref(filters, { brand: facet.value })}
                  aria-current={filters.brand === facet.value}
                >
                  {facet.value} <span>{formatCount(facet.count, locale)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3>{t('search.availability')}</h3>
          <ul>
            <li>
              <Link
                href={buildHref(filters, { inStockOnly: filters.inStockOnly ? undefined : true })}
                aria-current={filters.inStockOnly === true}
              >
                {t('search.inStockOnly')}
              </Link>
            </li>
          </ul>
        </div>

        {result.facets.priceRange.max > 0 && (
          <div>
            <h3>{t('search.price')}</h3>
            <p style={{ color: 'var(--colour-text-muted)' }}>
              {formatPrice(result.facets.priceRange.min, 'AED', locale)} –{' '}
              {formatPrice(result.facets.priceRange.max, 'AED', locale)}
            </p>
          </div>
        )}
      </aside>

      <section>
        <div className="listing__head">
          <div>
            <h1 style={{ fontSize: 'var(--text-xl)' }}>
              {filters.query ? t('search.results', { q: filters.query }) : t('search.all')}
            </h1>
            <p className="listing__count">
              {formatCount(result.total, locale)}{' '}
              {result.total === 1 ? t('search.product') : t('search.products')}
              {filters.query && result.intent !== 'browse' && (
                <>
                  {' · '}
                  {/* Surfacing the retrieval strategy is a merchandising tool,
                      not a debug leak: it is the first thing a merchant needs
                      when a search looks wrong. */}
                  <span title="How this query was interpreted">{result.intent} search</span>
                </>
              )}
            </p>
          </div>

          <nav aria-label={t('search.sort')} className="listing__count">
            {(
              [
                ['relevance', t('search.relevance')],
                ['price_asc', t('search.priceAsc')],
                ['price_desc', t('search.priceDesc')],
                ['rating', t('search.rating')],
              ] as const
            ).map(([value, label], index) => (
              <span key={value}>
                {index > 0 && ' · '}
                <Link
                  href={buildHref(filters, { sort: value })}
                  aria-current={(filters.sort ?? 'relevance') === value}
                >
                  {label}
                </Link>
              </span>
            ))}
          </nav>
        </div>

        {result.products.length === 0 ? (
          <div className="empty-state">
            <p style={{ marginBottom: 'var(--space-4)' }}>{t('search.emptyTitle')}</p>
            {/* A dead end is a lost sale. Every zero-result page offers a route
                onward, and the query is logged so the merchant can see the
                demand they are failing to meet. */}
            <p>
              {t('search.emptyBody')}{' '}
              <a href="https://wa.me/971500000000">WhatsApp</a>
            </p>
          </div>
        ) : (
          <>
            <div className="product-grid">
              {result.products.map((product) => (
                <ProductCard key={product.id} product={product} locale={locale} t={t} />
              ))}
            </div>
            <p className="vat-note" style={{ marginTop: 'var(--space-4)' }}>
              {t('vat.inclusive')}
            </p>
          </>
        )}
      </section>
    </div>
  );
}

function parseFilters(params: Record<string, string | string[] | undefined>): SearchFilters {
  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const sort = single('sort');
  return {
    ...(single('q') ? { query: single('q')! } : {}),
    ...(single('category') ? { category: single('category')! } : {}),
    ...(single('brand') ? { brand: single('brand')! } : {}),
    ...(single('inStock') === 'true' ? { inStockOnly: true } : {}),
    ...(sort === 'price_asc' || sort === 'price_desc' || sort === 'rating' || sort === 'relevance'
      ? { sort }
      : {}),
  };
}

function buildHref(current: SearchFilters, patch: Partial<SearchFilters>): string {
  const merged = { ...current, ...patch };
  const params = new URLSearchParams();
  if (merged.query) params.set('q', merged.query);
  if (merged.category) params.set('category', merged.category);
  if (merged.brand) params.set('brand', merged.brand);
  if (merged.inStockOnly) params.set('inStock', 'true');
  if (merged.sort && merged.sort !== 'relevance') params.set('sort', merged.sort);
  const qs = params.toString();
  return qs ? `/search?${qs}` : '/search';
}
