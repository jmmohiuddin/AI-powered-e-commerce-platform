import { DEFAULT_PAGE_SIZE, type SearchFilters } from './types';

/**
 * LISTING URL STATE
 *
 * The single place that knows how a set of filters becomes a query string and
 * back again. Search and the category pages render the same facets, so they had
 * better agree on what `?sort=price_asc&page=2` means — two copies of this
 * drift the moment one of them gains a filter.
 *
 * `basePath` is the only thing that differs between them: `/search` keeps the
 * query in the URL, `/category/mobiles/smartphones` carries it in the path. The
 * serialiser takes it as an argument rather than inferring it, so a category
 * page can never accidentally emit a link back to `/search`.
 */

export interface ListingParams extends SearchFilters {
  readonly page?: number;
}

type RawParams = Record<string, string | string[] | undefined>;

/**
 * Parses filters out of a query string.
 *
 * Everything here arrives from the URL, so nothing is trusted: `sort` is
 * matched against the union rather than cast to it, and the numeric fields go
 * through `positiveInt`, which rejects `NaN`, negatives and `1e9` alike. An
 * unparseable value is dropped rather than defaulted loudly — a shopper who
 * hand-edits a URL should get a listing, not an error page.
 */
export function parseListingParams(params: RawParams): ListingParams {
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
    ...(toFils(single('minPrice')) != null ? { minPrice: toFils(single('minPrice'))! } : {}),
    ...(toFils(single('maxPrice')) != null ? { maxPrice: toFils(single('maxPrice'))! } : {}),
    ...(positiveInt(single('page')) != null ? { page: positiveInt(single('page'))! } : {}),
    ...(sort === 'price_asc' || sort === 'price_desc' || sort === 'rating' || sort === 'relevance'
      ? { sort }
      : {}),
  };
}

/** Whole, non-negative, and small enough that it cannot be a denial of service. */
function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100_000_000) return undefined;
  return parsed;
}

/**
 * PRICE IS DIRHAMS IN THE URL AND FILS EVERYWHERE ELSE.
 *
 * The repository compares against `price_from`, which is minor units — AED
 * 4,699 is 469900. Putting that number in a URL and in the filter box would ask
 * a shopper to type 46990 for "under AED 470", so the boundary is converted
 * here, once, in both directions: `?minPrice=500` means AED 500.
 *
 * Doing it in the parser rather than the form is what keeps a hand-edited URL
 * and a submitted form meaning the same thing.
 */
const FILS_PER_DIRHAM = 100;

function toFils(value: string | undefined): number | undefined {
  const dirhams = positiveInt(value);
  return dirhams == null ? undefined : dirhams * FILS_PER_DIRHAM;
}

/** Fils back to the whole dirhams a URL and an input carry. */
export function toDirhams(fils: number | undefined): number | undefined {
  return fils == null ? undefined : Math.round(fils / FILS_PER_DIRHAM);
}

/**
 * Builds a listing URL from the current filters plus a patch.
 *
 * Any change to a *filter* resets to page 1. Landing on page 4 of a narrower
 * result set that only has two pages is the classic faceted-listing dead end —
 * the shopper ticks "in stock" and gets an empty screen. Paging is therefore
 * the one patch that is allowed to set `page` itself.
 */
export function buildListingHref(
  basePath: string,
  current: ListingParams,
  patch: Partial<ListingParams> = {},
): string {
  const changesFilter = Object.keys(patch).some((key) => key !== 'page');
  const merged: ListingParams = {
    ...current,
    ...patch,
    ...(changesFilter && patch.page === undefined ? { page: undefined } : {}),
  };

  const params = new URLSearchParams();
  if (merged.query) params.set('q', merged.query);
  if (merged.category) params.set('category', merged.category);
  if (merged.brand) params.set('brand', merged.brand);
  if (merged.inStockOnly) params.set('inStock', 'true');
  if (merged.minPrice != null) params.set('minPrice', String(toDirhams(merged.minPrice)));
  if (merged.maxPrice != null) params.set('maxPrice', String(toDirhams(merged.maxPrice)));
  if (merged.sort && merged.sort !== 'relevance') params.set('sort', merged.sort);
  // Page 1 is the canonical URL for the first page — emitting `?page=1` would
  // create a second address for a page that already has one.
  if (merged.page && merged.page > 1) params.set('page', String(merged.page));

  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/**
 * Whether a listing URL is worth indexing.
 *
 * A category page is a real destination. The same page filtered to one brand
 * under AED 500 sorted by rating is one of thousands of near-identical
 * permutations, and letting a crawler discover them all is how a 40-page store
 * reports 40,000 indexed pages of thin content and loses the ranking of the
 * pages that matter. Pagination stays indexable — page 3 holds products that
 * appear nowhere else.
 */
export function isIndexableListing(filters: ListingParams): boolean {
  return (
    !filters.query &&
    !filters.brand &&
    !filters.inStockOnly &&
    filters.minPrice == null &&
    filters.maxPrice == null &&
    (!filters.sort || filters.sort === 'relevance')
  );
}

/** The window of page numbers to render, always including first and last. */
export function paginationWindow(page: number, pageCount: number, span = 2): number[] {
  const pages = new Set<number>([1, pageCount]);
  for (let n = page - span; n <= page + span; n += 1) {
    if (n >= 1 && n <= pageCount) pages.add(n);
  }
  return [...pages].sort((a, b) => a - b);
}

export { DEFAULT_PAGE_SIZE };
