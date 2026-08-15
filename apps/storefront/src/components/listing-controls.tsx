import Link from 'next/link';
import { formatCount, formatPrice } from '@voltix/ui';
import { buildListingHref, paginationWindow, toDirhams, type ListingParams } from '@/lib/listing';
import type { CategoryView, SearchResult } from '@/lib/types';
import { localiseCategory } from '@/lib/types';
import type { Locale, Translate } from '@/lib/locale';

/**
 * THE LISTING CHROME, SHARED BY SEARCH AND CATEGORY PAGES
 *
 * Server components with no client JavaScript: every control is a link, so the
 * facets work with JS disabled, are crawlable, and cost nothing to hydrate.
 * That is also what makes them usable as SEO surface — a filter implemented as
 * an onClick is invisible to a crawler.
 *
 * `basePath` is threaded through every builder rather than read from the
 * router, because these render on both `/search` and `/category/**` and the
 * links must stay on whichever page they were rendered into.
 */

interface Chrome {
  readonly basePath: string;
  readonly filters: ListingParams;
  readonly locale: Locale;
  readonly t: Translate;
}

export function ListingFacets({
  basePath,
  filters,
  facets,
  locale,
  t,
  /**
   * Subcategories, when the page has any. Category pages drill down through
   * real routes; `/search` has no position in the tree and passes none, falling
   * back to the flat category facet below.
   */
  children: subcategories,
}: Chrome & {
  facets: SearchResult['facets'];
  children?: readonly CategoryView[];
}) {
  const href = (patch: Partial<ListingParams>) => buildListingHref(basePath, filters, patch);

  return (
    <aside className="facets" aria-label={t('search.filter')}>
      {subcategories && subcategories.length > 0 ? (
        <div>
          <h3>{t('search.subcategories')}</h3>
          <ul>
            {subcategories.map((child) => {
              const localised = localiseCategory(child, locale);
              return (
                <li key={child.slug}>
                  <Link href={`/category${child.path}`}>
                    {localised.name} <span>{formatCount(child.count, locale)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <div>
          <h3>{t('search.category')}</h3>
          <ul>
            <li>
              <Link href={href({ category: undefined })} aria-current={!filters.category}>
                {t('search.allCategories')}
              </Link>
            </li>
            {facets.categories.map((facet) => (
              <li key={facet.slug}>
                <Link
                  href={href({ category: facet.slug })}
                  aria-current={filters.category === facet.slug}
                >
                  {facet.value} <span>{formatCount(facet.count, locale)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3>{t('search.brand')}</h3>
        <ul>
          <li>
            <Link href={href({ brand: undefined })} aria-current={!filters.brand}>
              {t('search.allBrands')}
            </Link>
          </li>
          {facets.brands.map((facet) => (
            <li key={facet.value}>
              <Link href={href({ brand: facet.value })} aria-current={filters.brand === facet.value}>
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
              href={href({ inStockOnly: filters.inStockOnly ? undefined : true })}
              aria-current={filters.inStockOnly === true}
            >
              {t('search.inStockOnly')}
            </Link>
          </li>
        </ul>
      </div>

      {facets.priceRange.max > 0 && (
        <PriceFilter basePath={basePath} filters={filters} facets={facets} locale={locale} t={t} />
      )}
    </aside>
  );
}

/**
 * The price filter, as a GET form.
 *
 * `minPrice`/`maxPrice` have been honoured by the repository all along and were
 * simply never serialised into a link, so the price range rendered as read-only
 * text — a facet the shopper could see and not use. A form rather than a set of
 * preset bands because electronics span AED 15 to AED 15,000 and any band that
 * suits chargers is useless for laptops.
 *
 * Hidden inputs replay the other active filters: a GET form submits only its
 * own fields, so without them setting a price would silently clear the brand.
 */
function PriceFilter({
  basePath,
  filters,
  facets,
  locale,
  t,
}: Chrome & { facets: SearchResult['facets'] }) {
  // Whole dirhams in the input and in the URL; the parser converts to fils. The
  // conversion lives in one place so a typed form and a hand-edited URL agree.
  const dirhams = (fils: number | undefined) => {
    const value = toDirhams(fils);
    return value == null ? '' : String(value);
  };

  return (
    <div>
      <h3>{t('search.price')}</h3>
      <p className="facets__hint">
        {formatPrice(facets.priceRange.min, 'AED', locale)} –{' '}
        {formatPrice(facets.priceRange.max, 'AED', locale)}
      </p>
      <form className="price-filter" method="get" action={basePath}>
        {filters.query && <input type="hidden" name="q" value={filters.query} />}
        {filters.category && <input type="hidden" name="category" value={filters.category} />}
        {filters.brand && <input type="hidden" name="brand" value={filters.brand} />}
        {filters.inStockOnly && <input type="hidden" name="inStock" value="true" />}
        {filters.sort && filters.sort !== 'relevance' && (
          <input type="hidden" name="sort" value={filters.sort} />
        )}

        <label className="visually-hidden" htmlFor="minPrice">
          {t('search.priceMin')}
        </label>
        <input
          id="minPrice"
          name="minPrice"
          type="number"
          min="0"
          inputMode="numeric"
          // Short placeholder, full text in the visually-hidden label above:
          // the inputs sit in a 240px rail and "Min price, AED" truncates to
          // "Min price, A", which reads as a rendering fault.
          placeholder={t('search.priceMinShort')}
          defaultValue={dirhams(filters.minPrice)}
        />
        <span aria-hidden="true">–</span>
        <label className="visually-hidden" htmlFor="maxPrice">
          {t('search.priceMax')}
        </label>
        <input
          id="maxPrice"
          name="maxPrice"
          type="number"
          min="0"
          inputMode="numeric"
          placeholder={t('search.priceMaxShort')}
          defaultValue={dirhams(filters.maxPrice)}
        />
        <button type="submit" className="button button--secondary">
          {t('search.priceApply')}
        </button>
      </form>
    </div>
  );
}

export function ListingSort({ basePath, filters, t }: Chrome) {
  return (
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
            href={buildListingHref(basePath, filters, { sort: value })}
            aria-current={(filters.sort ?? 'relevance') === value}
          >
            {label}
          </Link>
        </span>
      ))}
    </nav>
  );
}

/**
 * Pagination as real anchors.
 *
 * Deliberately not a "load more" button: Googlebot does not click, so every
 * product past the first page of an infinite-scroll listing is unreachable to a
 * crawler even though it renders perfectly for a human. Numbered links are the
 * only form that is simultaneously accessible, bookmarkable and crawlable.
 *
 * A gap is rendered as an ellipsis rather than a link so the first and last
 * page are always one click away in a 200-page catalogue.
 */
export function ListingPagination({
  basePath,
  filters,
  page,
  pageCount,
  locale,
  t,
}: Chrome & { page: number; pageCount: number }) {
  if (pageCount <= 1) return null;

  const window = paginationWindow(page, pageCount);
  const href = (target: number) => buildListingHref(basePath, filters, { page: target });

  return (
    <nav className="pagination" aria-label={t('search.pagination')}>
      {page > 1 && (
        <Link className="pagination__step" href={href(page - 1)} rel="prev">
          {t('search.previous')}
        </Link>
      )}

      <ol className="pagination__pages">
        {window.map((target, index) => {
          const previous = window[index - 1];
          return (
            <li key={target}>
              {previous != null && target - previous > 1 && (
                <span className="pagination__gap" aria-hidden="true">
                  …
                </span>
              )}
              <Link
                href={href(target)}
                aria-current={target === page ? 'page' : undefined}
                aria-label={t('search.pageN', { n: formatCount(target, locale) })}
              >
                {formatCount(target, locale)}
              </Link>
            </li>
          );
        })}
      </ol>

      {page < pageCount && (
        <Link className="pagination__step" href={href(page + 1)} rel="next">
          {t('search.next')}
        </Link>
      )}
    </nav>
  );
}
