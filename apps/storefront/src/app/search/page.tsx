import type { Metadata } from 'next';
import { ProductCard } from '@/components/product-card';
import { formatCount } from '@voltix/ui';
import { ListingFacets, ListingPagination, ListingSort } from '@/components/listing-controls';
import { searchProducts } from '@/lib/catalog';
import { whatsappHref } from '@/lib/contact';
import { parseListingParams } from '@/lib/listing';
import { clientIdentifier, limitSearch } from '@/lib/rate-limit';
import { resolveLocale, translator } from '@/lib/locale';
import { MAX_SEARCH_QUERY_LENGTH } from '@voltix/commerce';
import { trackAfterRender, trackSearchQueryAfterRender } from '@/lib/analytics';
import { pageVisitor } from '@/lib/visitor';
import type { ListingParams } from '@/lib/listing';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const BASE_PATH = '/search';

/**
 * WHICH RENDERS COUNT AS "A SEARCH".
 *
 * Exactly one: the first page of an unrefined query. Everything else on this
 * route is a *re-*rendering of a search that was already recorded, and counting
 * those would corrupt the one report this log exists to produce.
 *
 * Paging is the obvious case — a shopper reading pages 1 to 4 did not search
 * four times, and logging it that way inflates query volume by however patient
 * they are.
 *
 * Facet refinement is the dangerous case. `?q=airpods&brand=Sony` legitimately
 * returns nothing, and logging that as a zero-result row would file "airpods"
 * as a query the catalogue could not answer — when in fact it answered it, and
 * the shopper then filtered the answer away. The target this table is meant to
 * move is the share of *searches* that return nothing (18% → under 6%,
 * docs/07-roadmap.md); admitting empty filter combinations into the numerator
 * would make that number describe shopper behaviour instead of catalogue gaps,
 * and it would never come down.
 *
 * `search_queries` has no column for a filter set, which is the schema agreeing
 * with all of that: it records what was asked of the catalogue, not how the
 * answer was then narrowed.
 */
function isFirstUnrefinedSearch(filters: ListingParams): boolean {
  return (
    Boolean(filters.query) &&
    // Both writes take the query verbatim into an unbounded `text` column, and
    // the value arrives in a URL. The ceiling is refused rather than truncated
    // so nothing is filed under a query nobody typed — see
    // MAX_SEARCH_QUERY_LENGTH.
    filters.query!.length <= MAX_SEARCH_QUERY_LENGTH &&
    (filters.page ?? 1) === 1 &&
    !filters.category &&
    !filters.brand &&
    !filters.inStockOnly &&
    filters.minPrice == null &&
    filters.maxPrice == null
  );
}

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
    // Category pages under /category/** are the indexable surface — they now
    // exist, which is what makes this exclusion correct rather than a gap.
    robots: { index: false, follow: true },
  };
}

export default async function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const locale = await resolveLocale();
  const t = translator(locale);
  const filters = parseListingParams(params);
  const whatsapp = whatsappHref();

  /**
   * Only a query is throttled, never plain browsing.
   *
   * Retrieval is the expensive half — hybrid lexical plus semantic ranking —
   * and it is the half a scraper drives. Filtering and sorting an already
   * narrow result set is not worth a counter, and rate-limiting the category
   * links in the header would throttle ordinary shopping.
   */
  const throttled = filters.query ? !(await limitSearch(await clientIdentifier())).allowed : false;
  if (throttled) {
    return (
      <div className="container section">
        <div className="notice notice--warn" role="status">
          <strong>{t('limit.title')}</strong>
          <p>{t('limit.search')}</p>
        </div>
      </div>
    );
  }

  /**
   * Retrieval time, not render time.
   *
   * Measured around this call alone because that is the number a merchant can
   * act on: it is the cost of the hybrid ranking, and it is what will change
   * when the semantic leg is switched on. Wrapping the whole component would
   * fold in hydration and React rendering and make a slow query indisting-
   * uishable from a heavy page.
   */
  const startedAt = Date.now();
  const result = await searchProducts(filters);
  const latencyMs = Date.now() - startedAt;

  /**
   * THE SEARCH LOG, AND THE FUNNEL STEP BESIDE IT.
   *
   * Two writes with two different jobs. `search_queries` is the merchandising
   * record — what was asked for, what came back, how it was retrieved and how
   * long it took — and it is the table the roadmap calls the highest-value
   * report the store has, empty since the first migration. `search_performed`
   * is the funnel step, so that "searched, then left" can be told apart from
   * "searched, then bought".
   *
   * They differ on one point deliberately. The event table's `session_id` is
   * NOT NULL and only means something if it is the *same* id that later carries
   * a `checkout_started`, so the funnel step is recorded only for a browser
   * that has a cart session. `search_queries.session_id` is nullable, and a
   * search by someone who has never had a basket is still a customer telling
   * the merchant what they could not find — so it is logged with a null
   * session rather than dropped. The zero-result report must not be restricted
   * to people who already bought something.
   */
  const visitor = await pageVisitor();
  if (!visitor.automated && isFirstUnrefinedSearch(filters)) {
    const query = filters.query!;

    trackSearchQueryAfterRender(query, {
      sessionId: visitor.sessionId || null,
      query,
      // The whole match, not the page — `result.total` is the number the
      // zero-result report has to key on.
      resultCount: result.total,
      strategy: result.strategy,
      latencyMs,
    });

    if (visitor.sessionId) {
      trackAfterRender(`search_performed:${query}`, {
        type: 'search_performed',
        sessionId: visitor.sessionId,
        searchQuery: query,
        properties: {
          resultCount: result.total,
          // The classifier's reading of the query — a spike in zero-result
          // `identifier` searches means shoppers are typing model numbers the
          // catalogue does not carry, which is a different fix from a spike in
          // zero-result `exploratory` ones.
          intent: result.intent,
          strategy: result.strategy,
          latencyMs,
          locale,
        },
      });
    }
  }

  return (
    <div className="container listing">
      <ListingFacets
        basePath={BASE_PATH}
        filters={filters}
        facets={result.facets}
        locale={locale}
        t={t}
      />

      <section>
        <div className="listing__head">
          <div>
            <h1 className="page__title page__title--compact">
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

          <ListingSort basePath={BASE_PATH} filters={filters} locale={locale} t={t} />
        </div>

        {result.products.length === 0 ? (
          <div className="empty-state">
            <p className="empty-state__title">{t('search.emptyTitle')}</p>
            {/* A dead end is a lost sale. Every zero-result page offers a route
                onward, and the query is logged so the merchant can see the
                demand they are failing to meet. */}
            <p>
              {t('search.emptyBody')}
              {whatsapp && (
                <>
                  {' '}
                  <a href={whatsapp}>WhatsApp</a>
                </>
              )}
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
              basePath={BASE_PATH}
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
  );
}
