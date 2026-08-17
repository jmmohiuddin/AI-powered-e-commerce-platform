import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { formatCount } from '@voltix/ui';
import { ProductCard } from '@/components/product-card';
import {
  ListingFacets,
  ListingPagination,
  ListingSort,
} from '@/components/listing-controls';
import { getCategory, searchProducts } from '@/lib/catalog';
import { buildListingHref, isIndexableListing, parseListingParams } from '@/lib/listing';
import { localiseCategory, type CategoryDetail } from '@/lib/types';
import { resolveLocale, translator, type Locale, type Translate } from '@/lib/locale';

/**
 * CATEGORY LISTING — the store's indexable surface.
 *
 * `/search` is deliberately `noindex`: it generates unbounded near-duplicate
 * URLs from arbitrary queries. Its comment has always said "category pages are
 * the indexable surface", and until now those pages did not exist — so the nav
 * and footer pointed at `/search?category=…` and not one listing in the store
 * could be indexed. These are the pages that comment was describing.
 *
 * A CATCH-ALL, because the taxonomy is a tree. `categories.path` is already
 * materialised as `/mobiles/smartphones`, so the route segments and the stored
 * path are the same string and the lookup is one indexed equality — no
 * recursive CTE, no slug-to-parent walk. The seeded taxonomy happens to be flat
 * today; this works unchanged when it is not.
 */

type Params = Promise<{ slug: string[] }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Route segments → the stored `path`. `['mobiles','phones']` → `/mobiles/phones`. */
function pathOf(segments: string[]): string {
  return `/${segments.map((s) => decodeURIComponent(s)).join('/')}`;
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}): Promise<Metadata> {
  const { slug } = await params;
  const locale = await resolveLocale();
  const t = translator(locale);
  const category = await getCategory(pathOf(slug));
  if (!category) return { title: 'Category not found' };

  const localised = localiseCategory(category, locale);
  const filters = parseListingParams(await searchParams);
  const page = filters.page ?? 1;
  const basePath = `/category${category.path}`;

  /**
   * The canonical is self-referencing, including the page number.
   *
   * Pointing every page of a series at page 1 — a common reflex — tells Google
   * the products on pages 2..n are duplicates of page 1 and drops them from the
   * index entirely. Each page is its own canonical; only the *facet*
   * permutations collapse, and those are handled by `robots` below.
   */
  const canonical = buildListingHref(basePath, { ...(page > 1 ? { page } : {}) });

  const title = localised.metaTitle ?? localised.name;
  const description =
    localised.metaDescription ??
    localised.description ??
    t('category.metaDescription', { name: localised.name });

  return {
    title: page > 1 ? `${title} — ${t('search.pageN', { n: page })}` : title,
    description,
    alternates: {
      canonical,
      // Both locales serve from this same URL, distinguished by the cookie —
      // mirroring products/[slug]. Declared so a crawler knows an Arabic
      // rendering exists rather than treating the page as English-only.
      languages: { 'en-AE': canonical, 'ar-AE': canonical },
    },
    openGraph: { title, description, type: 'website' },
    // Faceted permutations are near-duplicates and must not be indexed; the
    // clean category page and its pagination must. `follow` either way, so a
    // crawler that lands on a filtered URL still reaches the products.
    robots: isIndexableListing(filters)
      ? { index: true, follow: true }
      : { index: false, follow: true },
  };
}

export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { slug } = await params;
  const locale = await resolveLocale();
  const t = translator(locale);

  const category = await getCategory(pathOf(slug));
  if (!category) notFound();

  const localised = localiseCategory(category, locale);
  const filters = parseListingParams(await searchParams);
  const basePath = `/category${category.path}`;

  const result = await searchProducts({ ...filters, categoryPath: category.path });

  return (
    <>
      <BreadcrumbJsonLd category={localised} locale={locale} t={t} />

      <nav className="container breadcrumb" aria-label="Breadcrumb">
        <ol>
          <li>
            <Link href="/">{t('nav.home')}</Link>
          </li>
          {category.ancestors.map((ancestor) => {
            const crumb = localiseCategory(ancestor, locale);
            return (
              <li key={ancestor.path}>
                <Link href={`/category${ancestor.path}`}>{crumb.name}</Link>
              </li>
            );
          })}
          <li aria-current="page">{localised.name}</li>
        </ol>
      </nav>

      <div className="container listing">
        <ListingFacets
          basePath={basePath}
          filters={filters}
          facets={result.facets}
          locale={locale}
          t={t}
        >
          {category.children}
        </ListingFacets>

        <section>
          <div className="listing__head">
            <div>
              <h1 className="page__title page__title--compact">{localised.name}</h1>
              <p className="listing__count">
                {formatCount(result.total, locale)}{' '}
                {result.total === 1 ? t('search.product') : t('search.products')}
                {result.pageCount > 1 && (
                  <>
                    {' · '}
                    {t('search.pageOf', {
                      n: formatCount(result.page, locale),
                      total: formatCount(result.pageCount, locale),
                    })}
                  </>
                )}
              </p>
            </div>

            <ListingSort basePath={basePath} filters={filters} locale={locale} t={t} />
          </div>

          {localised.description && <p className="listing__intro">{localised.description}</p>}

          {result.products.length === 0 ? (
            <div className="empty-state">
              <p className="empty-state__title">{t('category.emptyTitle')}</p>
              <p>
                {t('category.emptyBody')} <Link href="/search">{t('home.browseAll')}</Link>
              </p>
            </div>
          ) : (
            <>
              <div className="product-grid">
                {result.products.map((product) => (
                  <ProductCard key={product.id} product={product} locale={locale} t={t} />
                ))}
              </div>

              <p className="vat-note vat-note--after-grid">
                {t('vat.inclusive')}
              </p>

              <ListingPagination
                basePath={basePath}
                filters={filters}
                page={result.page}
                pageCount={result.pageCount}
                locale={locale}
                t={t}
              />
            </>
          )}
        </section>
      </div>
    </>
  );
}

/**
 * `BreadcrumbList`, built from the materialised path.
 *
 * Earns the rich-result breadcrumb trail in place of a bare URL, which matters
 * more on a category page than anywhere else: it is what tells a searcher this
 * result is a section of a shop rather than one product.
 *
 * Nonced. `src/proxy.ts` mints a per-request nonce, exposes it as `x-nonce`,
 * and names it in the CSP; an inline script without it is exactly the violation
 * that is keeping the policy in report-only mode, so adding another one here
 * would be adding to the pile this codebase is trying to clear.
 */
async function BreadcrumbJsonLd({
  category,
  locale,
  t,
}: {
  category: CategoryDetail;
  locale: Locale;
  t: Translate;
}) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  const base = process.env.STOREFRONT_URL || 'http://localhost:3000';

  const trail = [
    { name: t('nav.home'), url: base },
    ...category.ancestors.map((ancestor) => ({
      name: localiseCategory(ancestor, locale).name,
      url: `${base}/category${ancestor.path}`,
    })),
    { name: category.name, url: `${base}/category${category.path}` },
  ];

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: crumb.url,
    })),
  };

  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
    />
  );
}
