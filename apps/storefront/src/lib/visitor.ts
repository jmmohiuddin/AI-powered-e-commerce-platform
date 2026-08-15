import 'server-only';
import { headers } from 'next/headers';
import { userAgent } from 'next/server';
import { cartSessionToken } from './session';

/**
 * WHO IS ON THE OTHER END OF THIS RENDER.
 *
 * Every event this storefront records from a Server Action is caused by a
 * person: somebody pressed a button. The two discovery events are not. They are
 * recorded from a page render, and a render happens for anything that asks for
 * the URL — Googlebot, an uptime probe, a WhatsApp link-preview fetcher, and the
 * router prefetching a page nobody has looked at yet.
 *
 * That difference is the whole reason this file exists. "Product views" that
 * silently include crawler traffic is not a slightly noisy metric, it is a
 * misleading one: crawl volume tracks how many links point at a product, so the
 * products that look most popular are the ones linked from the homepage, and a
 * merchant acting on that report would restock the wrong phone.
 *
 * There is no honest way to identify a person from one HTTP request. What
 * follows is the strongest evidence available on the server without shipping
 * client-side JavaScript, and each rule is a filter rather than a guess.
 */

export interface PageVisitor {
  /**
   * The cart cookie, or `''` when this browser has never been given one.
   *
   * Read-only — `ensureCartSession()` mints a cookie and Next forbids setting
   * one during a render, so a page can only ever observe what is already there.
   *
   * It is empty for most first visits, because the cookie is minted by a cart
   * action rather than by arriving. Callers that record behaviour against it
   * are therefore sampling shoppers who already have a basket, which biases
   * every rate computed from those rows — see the note on `AnalyticsEventType`
   * in packages/commerce/src/analytics.ts before using them as a denominator.
   *
   * Minting an identifier here or in the proxy so that browsing could be
   * counted was considered and DECLINED by the owner: a cookie set on ordinary
   * browsing to record behaviour is an analytics cookie rather than a strictly
   * necessary one, and this storefront has no consent mechanism (PDPL, PRD
   * L-07). The gap is deliberate. Reopen the decision, not the code.
   */
  readonly sessionId: string;
  /**
   * True when this request is machinery rather than a shopper: a known crawler,
   * or a speculative prefetch of a page that may never be shown.
   */
  readonly automated: boolean;
}

/**
 * Classifies the current request.
 *
 * Reads request state directly, so it must be called during render — never
 * inside an `after()` callback, which runs after React's lifecycle and throws
 * on `cookies()`/`headers()` in a Server Component.
 */
export async function pageVisitor(): Promise<PageVisitor> {
  const [sessionId, headerList] = await Promise.all([cartSessionToken(), headers()]);

  /**
   * Bot detection comes from Next's own `userAgent` helper rather than a regex
   * kept here. It is maintained against a real device/crawler database and
   * ships with the framework, so it costs no dependency and does not rot in
   * this file the year a new crawler appears.
   *
   * It catches declared crawlers, which is all a User-Agent can ever prove — a
   * scraper that lies is indistinguishable from a browser at this layer. That
   * is acceptable here because the cookie rule below catches most of what
   * lying scrapers do anyway: they rarely carry a session cookie.
   */
  const { isBot } = userAgent({ headers: headerList });

  /**
   * A prefetch is the router fetching a page the shopper is *near*, not one
   * they asked for. Counting it would credit a view to every product card a
   * cursor happened to pass over. The proxy already recognises these two
   * headers for the same reason (see proxy.ts's matcher); `sec-purpose` is the
   * standardised spelling browsers are moving to.
   */
  const prefetch =
    headerList.get('next-router-prefetch') !== null ||
    headerList.get('purpose') === 'prefetch' ||
    (headerList.get('sec-purpose') ?? '').includes('prefetch');

  return { sessionId, automated: isBot || prefetch };
}
