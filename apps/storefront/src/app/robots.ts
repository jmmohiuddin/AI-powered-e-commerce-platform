import type { MetadataRoute } from 'next';

/**
 * ROBOTS
 *
 * What a crawler may spend its budget on. Everything disallowed here is either
 * private, transactional, or an infinite URL space — never merely unfinished.
 *
 *  • `/search` — unbounded near-duplicates from arbitrary queries. The
 *    `/category/**` pages exist to be the indexable version of the same
 *    listings. Note this is belt-and-braces: the page also sends `noindex`,
 *    which is the directive that actually removes a URL already in the index.
 *    A `Disallow` alone cannot, because a blocked page can never be re-crawled
 *    to discover the tag telling Google to drop it.
 *  • `/orders` — renders a delivery emirate and an order total against a phone
 *    number. Indexing a successful lookup would cache a customer's order in a
 *    search result.
 *  • `/checkout`, `/cart` — session-scoped and worthless to a crawler; also the
 *    two places where a crawler following links does real work per request.
 *  • `/api` — machine surface, including the payment webhooks.
 */
export default function robots(): MetadataRoute.Robots {
  const base = (process.env.STOREFRONT_URL || 'http://localhost:3000').replace(/\/$/, '');

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/search', '/orders', '/checkout', '/cart', '/api/'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
