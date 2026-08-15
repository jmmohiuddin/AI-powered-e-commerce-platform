import { describe, expect, it } from 'vitest';
import {
  buildListingHref,
  isIndexableListing,
  paginationWindow,
  parseListingParams,
} from './listing';

describe('parseListingParams', () => {
  it('reads the price filter that buildHref never used to serialise, converting AED to fils', () => {
    // `?minPrice=100` is AED 100; the repository compares against fils.
    const filters = parseListingParams({ minPrice: '100', maxPrice: '500' });
    expect(filters).toMatchObject({ minPrice: 10_000, maxPrice: 50_000 });
  });

  it('drops values that are not whole non-negative integers', () => {
    // All of these reached an OFFSET or a price comparison before.
    for (const bad of ['-1', 'abc', '1.5', '1e9', '', '99999999999']) {
      expect(parseListingParams({ page: bad }).page, bad).toBeUndefined();
      expect(parseListingParams({ minPrice: bad }).minPrice, bad).toBeUndefined();
    }
  });

  it('ignores a sort value that is not one of the four', () => {
    expect(parseListingParams({ sort: 'price_asc' }).sort).toBe('price_asc');
    expect(parseListingParams({ sort: 'DROP TABLE' }).sort).toBeUndefined();
  });

  it('takes the first value when a parameter is repeated', () => {
    expect(parseListingParams({ brand: ['Samsung', 'Xiaomi'] }).brand).toBe('Samsung');
  });
});

describe('buildListingHref', () => {
  it('keeps links on the page that rendered them', () => {
    const filters = { brand: 'Samsung' };
    expect(buildListingHref('/search', filters, { sort: 'rating' })).toBe(
      '/search?brand=Samsung&sort=rating',
    );
    expect(buildListingHref('/category/smartphones', filters, { sort: 'rating' })).toBe(
      '/category/smartphones?brand=Samsung&sort=rating',
    );
  });

  it('resets to page 1 when a filter changes', () => {
    // The faceted-listing dead end: narrow the results while on page 4 and the
    // shopper lands on a page that no longer exists.
    const onPageFour = { page: 4, brand: 'Samsung' };
    expect(buildListingHref('/search', onPageFour, { inStockOnly: true })).toBe(
      '/search?brand=Samsung&inStock=true',
    );
  });

  it('keeps the page when only paging', () => {
    expect(buildListingHref('/search', { brand: 'Samsung' }, { page: 3 })).toBe(
      '/search?brand=Samsung&page=3',
    );
  });

  it('never emits ?page=1, so the first page has one address', () => {
    expect(buildListingHref('/category/audio', {}, { page: 1 })).toBe('/category/audio');
  });

  it('round-trips the price filter through the AED/fils boundary', () => {
    // The bug this guards: the form is labelled AED, so if the URL carried fils
    // a shopper typing 500 would filter to AED 5.
    const href = buildListingHref('/search', {}, { minPrice: 10_000, maxPrice: 50_000 });
    expect(href).toBe('/search?minPrice=100&maxPrice=500');

    const reparsed = parseListingParams({ minPrice: '100', maxPrice: '500' });
    expect(reparsed).toMatchObject({ minPrice: 10_000, maxPrice: 50_000 });
  });
});

describe('isIndexableListing', () => {
  it('indexes a clean category page and its pagination', () => {
    expect(isIndexableListing({})).toBe(true);
    expect(isIndexableListing({ page: 3 })).toBe(true);
  });

  it('refuses the facet permutations that would flood the index', () => {
    expect(isIndexableListing({ brand: 'Samsung' })).toBe(false);
    expect(isIndexableListing({ minPrice: 10_000 })).toBe(false);
    expect(isIndexableListing({ inStockOnly: true })).toBe(false);
    expect(isIndexableListing({ sort: 'price_asc' })).toBe(false);
    expect(isIndexableListing({ query: 'phone' })).toBe(false);
  });

  it('treats explicit relevance sort as clean, since it is the default', () => {
    expect(isIndexableListing({ sort: 'relevance' })).toBe(true);
  });
});

describe('paginationWindow', () => {
  it('always offers the first and last page', () => {
    const window = paginationWindow(10, 20);
    expect(window[0]).toBe(1);
    expect(window.at(-1)).toBe(20);
    expect(window).toContain(10);
  });

  it('does not repeat or leave gaps on a short series', () => {
    expect(paginationWindow(1, 3)).toEqual([1, 2, 3]);
    expect(paginationWindow(1, 1)).toEqual([1]);
  });
});
