import { sql } from 'drizzle-orm';
import { uuidv7 } from '@voltix/db';
import type { TenantContext, Tx } from './types';

/**
 * COMMERCE ANALYTICS — the funnel, written down.
 *
 * `analytics_events` has existed since the first migration with no writer, so
 * the store has never been able to answer the only question that matters when
 * sales are disappointing: at which step do people leave. Guessing at that from
 * order counts alone is guessing at the shape of a hole from the sound it makes.
 *
 * WHY THESE EVENTS AND NOT A GENERIC PAGE TRACKER. A third-party page tracker
 * would report sessions and bounces, neither of which names a defect. These
 * events are chosen so that every one of them, when its count moves, points at
 * something a person can go and fix: `checkout_failed` carries the reason and
 * the step, so a spike is a specific broken thing rather than a mood.
 *
 * WRITTEN OUTSIDE THE ORDER TRANSACTION, DELIBERATELY.
 * The notifications outbox is written *inside* the order transaction, and that
 * is right for it: a confirmation the customer never receives is a customer-
 * visible failure, so it must live or die with the order. Analytics is the
 * opposite trade. A lost event costs a row in a report; an event that throws
 * inside the order transaction costs the sale itself. So `recordAnalyticsEvent`
 * is always called in its own transaction, after the real work has committed,
 * and the storefront's `track` wrapper swallows every error it can raise.
 *
 * It is awaited rather than fired and forgotten. On a serverless runtime an
 * un-awaited promise is killed when the response is returned, which would drop
 * events non-deterministically and — worse — drop them in exactly the cases
 * where the handler returned fastest, biasing the funnel toward the happy path.
 * One indexed INSERT is a millisecond or two, and correctness of the record is
 * worth more than that here.
 *
 * PII: NOT IN HERE. No phone numbers, no street addresses, no email. The order
 * already stores those under a lookup that requires a second factor, and a
 * second copy in a high-volume table that exists to be exported into reports is
 * how personal data escapes. The emirate IS recorded — it is a region, not an
 * address, and requirement L-03 needs supplies attributed per emirate. That
 * attribution cannot be reconstructed later, which is the whole reason it is
 * captured from the first order rather than when the threshold is near.
 */

/**
 * Event names.
 *
 * These follow the requirement (audit §16), not the illustrative list in the
 * `analytics_events` doc comment, which named a generic e-commerce set that was
 * never implemented. Past tense throughout: an event records something that
 * happened, and naming half of them as commands invites someone to fire one
 * hoping to cause the thing.
 */
export type AnalyticsEventType =
  | 'product_viewed'
  | 'search_performed'
  | 'checkout_started'
  | 'checkout_failed'
  | 'cod_refused'
  | 'order_placed';

/**
 * STILL NOT HERE, AND STILL DELIBERATELY NOT DECLARED.
 *
 * `payment_settled` / `payment_failed` belong in the webhook settlement path,
 * which is the one place they cannot safely go. `settlePaymentWebhookEvent`
 * runs inside the job's transaction and the job runner offers no post-commit
 * hook, so an event written there would sit on the money path — a reporting
 * INSERT that fails repeatedly would exhaust the job's attempts and leave a real
 * payment unsettled. Adding them needs an after-commit seam in the runner first.
 * Card success rate is worth having; it is not worth buying with that.
 *
 * Listing them in the union above would recreate the exact defect this codebase
 * kept producing: a declared capability with nothing behind it, which reads as
 * covered to everyone downstream.
 */

/**
 * THE DISCOVERY HALF, AND WHAT ITS NUMBERS ACTUALLY COUNT.
 *
 * `product_viewed` and `search_performed` are recorded from page renders rather
 * than from a Server Action, which makes them the only events here whose
 * denominator is a matter of judgement rather than arithmetic. A render happens
 * for crawlers, for link-preview fetchers and for router prefetches, none of
 * which are shopping. The storefront filters those out before calling in (see
 * `apps/storefront/src/lib/visitor.ts`) and records a view only against a
 * browser that is carrying a cart session cookie, so the id on a
 * `product_viewed` row is the same id that later appears on `checkout_started`
 * and `order_placed` — which is the only reason a funnel can be computed from
 * these rows at all.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ `product_viewed` IS A FLOOR, NOT A COUNT OF PRODUCT VIEWS.              │
 * │ It systematically undercounts, by an amount these tables cannot         │
 * │ measure. It is NOT site traffic and NOT a page-view metric.             │
 * │                                                                         │
 * │ DO NOT COMPUTE A VIEW-TO-ADD-TO-CART CONVERSION RATE FROM IT.           │
 * │ That specific ratio is not computable from these rows. Any number you   │
 * │ get will be far too high, and nothing here tells you by how much.       │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * WHY IT IS A FLOOR RATHER THAN A FILTERED COUNT. The filters above remove
 * crawlers and prefetches, which is ordinary hygiene. The undercount is a
 * different and larger thing. The cart cookie is minted by
 * `ensureCartSession()`, which runs only inside a Server Action, and the only
 * actions that call it are add-to-cart and its siblings. The cookie therefore
 * does not exist until a shopper has already put something in a basket, and
 * every product view *before* that moment — for most shoppers, all of them, and
 * for everyone who never adds anything, every single one — is not recorded at
 * all. These rows count views by browsers that already have a basket, not views
 * by people deciding whether to start one.
 *
 * WHY THE CONVERSION RATE IN PARTICULAR IS UNRECOVERABLE.
 * `add_to_cart / product_viewed` divides a numerator and a denominator drawn
 * from different populations. The denominator is missing precisely the visits
 * that did not convert — that is not noise, it is the exact complement of what
 * the ratio is trying to measure — so the rate is biased upward, and the size
 * of the bias depends on how many people browsed without ever starting a
 * basket, which is a number this table does not contain and cannot be
 * back-filled from. There is no correction factor to apply. A merchant acting
 * on it would conclude the product page converts well and go hunting for the
 * problem somewhere it is not.
 *
 * WHAT THESE ROWS DO SUPPORT, and support properly:
 *   • view counts per product compared against each other — the same bias
 *     applies to every product, so the ranking is sound even though the levels
 *     are not;
 *   • views landing on out-of-stock products, which is a merchandising defect
 *     with a name and an owner;
 *   • any funnel step at or after `checkout_started`, where every session in
 *     the numerator is also in the denominator by construction.
 *
 * WHAT WOULD WIDEN IT, AND WHY IT WAS DECLINED. Widening this to all visitors
 * needs one thing: a session identifier minted before the first cart action —
 * in practice a cookie set on document requests in `proxy.ts`. That is not a
 * refactor and it is not an oversight anybody forgot to clean up. A cookie set
 * on ordinary browsing for the purpose of recording behaviour is a different
 * kind of cookie from a cart cookie: the cart cookie is strictly necessary to
 * provide something the shopper asked for, and an analytics cookie is not, so
 * it needs a consent mechanism this storefront does not have (PDPL; PRD L-07,
 * "build to the principles, not to a deadline").
 *
 * It was put to the owner as a product decision and DECLINED. The honest floor
 * is the intended state of this metric, not a temporary one. Do not add the
 * cookie to improve these numbers without reopening that decision first.
 */

export interface AnalyticsEvent {
  readonly type: AnalyticsEventType;
  /**
   * The cart cookie. Required by the table, and the only thing that stitches a
   * `checkout_started` to the `checkout_failed` that followed it — without it
   * the two are unrelated rows and there is no funnel, only totals.
   */
  readonly sessionId: string;
  readonly customerId?: string;
  /**
   * The product and variant a `product_viewed` is about.
   *
   * Their own columns rather than keys in `properties`, because
   * `analytics_events_product_idx` is on `(product_id, type)` — "how many views
   * did this product get" is an index scan through the column and a full scan
   * through the jsonb. Both must be uuids; the caller is responsible for not
   * passing a slug-shaped id from a fallback catalogue.
   */
  readonly productId?: string;
  readonly variantId?: string;
  /**
   * What the shopper typed, on a `search_performed`.
   *
   * The richer per-search record lives in `search_queries` (see
   * `recordSearchQuery`); this column exists so a funnel query does not have to
   * join to it just to segment the step by query.
   */
  readonly searchQuery?: string;
  /** Minor units, matching every other money column in the schema. */
  readonly value?: number;
  readonly currency?: string;
  /**
   * Everything that is specific to one event type.
   *
   * Kept as jsonb rather than widening the table because these keys differ per
   * event and will keep changing; a column per reason code would be a migration
   * every time someone adds a failure mode.
   */
  readonly properties?: Record<string, unknown>;
}

/**
 * Writes one event. Assumes it is running in its own transaction.
 *
 * Note there is no partitioning: the table's doc comment claims monthly
 * partitions "see migration 0003", and 0003 adds a column to `users`. Nothing
 * partitions this table. At this store's volume that is irrelevant for years,
 * but retention will one day be a long DELETE rather than a DETACH, and someone
 * reading that comment would plan for the wrong thing.
 */
export async function recordAnalyticsEvent(tx: Tx, ctx: TenantContext, event: AnalyticsEvent): Promise<void> {
  await tx.execute(sql`
    INSERT INTO analytics_events
      (id, tenant_id, session_id, customer_id, type, product_id, variant_id, search_query,
       value, currency, country_code, properties, created_at)
    VALUES (${uuidv7()}, ${ctx.tenantId}, ${event.sessionId}, ${event.customerId ?? null},
            ${event.type}, ${event.productId ?? null}, ${event.variantId ?? null},
            ${event.searchQuery ?? null},
            ${event.value ?? null}, ${event.currency ?? ctx.currency},
            'AE', ${JSON.stringify(event.properties ?? {})}::jsonb, now())
  `);
}

/* ─────────────────────────── The search log ──────────────────────────── */

/**
 * WHAT SHOPPERS ASKED FOR, AND WHAT THEY GOT.
 *
 * `search_queries` is a separate table from `analytics_events` and has been
 * empty since the first migration, which is why the store cannot answer the
 * question the roadmap calls its highest-value report (docs/07-roadmap.md §66):
 * which searches return nothing. A zero-result search is a customer naming, in
 * their own words, a product the shop failed to sell them — the only demand
 * signal here that arrives already written down.
 *
 * It is not folded into `analytics_events` because the two are different
 * shapes. The funnel table is one narrow row per step, queried by type over
 * time; this is a wide row per search with its own indexes on
 * `(tenant_id, result_count)` and `(tenant_id, normalised_query)`, queried by
 * outcome. Putting `latency_ms` and `result_count` into a shared `properties`
 * jsonb would make the zero-result report a full scan of the highest-volume
 * table in the system.
 *
 * NO PII, on the same terms as the events table — a query string is what the
 * shopper typed about the catalogue, and the one caller records it only after
 * the funnel's own filters have run.
 */
export interface SearchQueryLog {
  /** The cart cookie when the browser has one. Null is honest for a first visit. */
  readonly sessionId?: string | null;
  readonly customerId?: string;
  /** Exactly what was typed, before normalisation — the merchandiser reads this. */
  readonly query: string;
  /** Matches across the whole result set, not the page that was rendered. */
  readonly resultCount: number;
  /**
   * Which retrievers actually contributed, reported by the retrieval layer
   * rather than inferred from intent. The distinction matters: the semantic leg
   * is inert until embeddings are backfilled, so a strategy derived from the
   * *intended* weighting would record `hybrid` for queries that were answered
   * lexically and quietly invalidate any comparison between the two.
   */
  readonly strategy?: 'lexical' | 'semantic' | 'hybrid';
  /** Wall-clock milliseconds spent in retrieval, not in rendering. */
  readonly latencyMs?: number;
}

/**
 * The grouping key for the zero-result report.
 *
 * Two shoppers who mean the same thing must land on the same row or the report
 * fragments into a long tail of near-duplicates and stops being readable. That
 * is mostly casing and spacing in English, and considerably more than that in
 * Arabic, which this store serves as a first-class locale:
 *
 *  • harakat (the short-vowel marks) are optional and inconsistently typed;
 *  • alef carries three written forms (أ إ آ) for one letter people mean;
 *  • ya/alef-maqsura and ta-marbuta/ha are routinely interchanged;
 *  • tatweel is decorative stretching with no phonetic value;
 *  • Arabic-Indic digits are the same numbers as ASCII ones.
 *
 * Folding those together is what makes "سماعات" one row rather than four.
 * Internal punctuation is deliberately kept — `SM-S928B` and `SMS928B` are not
 * the same part number, and collapsing them would merge two genuinely different
 * searches.
 */
export function normaliseSearchQuery(query: string): string {
  return query
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The longest thing that is still a search.
 *
 * `query` and `normalised_query` are unbounded `text`, and what goes into them
 * arrives in a URL, so without a ceiling anyone can write kilobytes per request
 * into the store's highest-volume reporting table. It is refused rather than
 * truncated: a truncated row would sit in the zero-result report as a query
 * nobody typed, and no shopper has ever typed two hundred characters looking
 * for a phone charger.
 */
export const MAX_SEARCH_QUERY_LENGTH = 200;

/**
 * Writes one search. Assumes it is running in its own transaction, for the same
 * reason `recordAnalyticsEvent` does.
 *
 * `clicked_product_id`, `clicked_position` and `converted_order_id` are left
 * null. They cannot be filled from a page render — knowing which result was
 * clicked means observing a click, and this storefront ships no client-side
 * analytics. Writing a placeholder would be worse than leaving them null: the
 * zero-*click* report would read as "nobody ever clicked anything", which is
 * indistinguishable from a catastrophic relevance failure.
 */
export async function recordSearchQuery(
  tx: Tx,
  ctx: TenantContext,
  log: SearchQueryLog,
): Promise<void> {
  if (!log.query || log.query.length > MAX_SEARCH_QUERY_LENGTH) return;

  await tx.execute(sql`
    INSERT INTO search_queries
      (id, tenant_id, session_id, customer_id, query, normalised_query,
       result_count, strategy, latency_ms, created_at)
    VALUES (${uuidv7()}, ${ctx.tenantId}, ${log.sessionId || null}, ${log.customerId ?? null},
            ${log.query}, ${normaliseSearchQuery(log.query)},
            ${log.resultCount}, ${log.strategy ?? null}, ${log.latencyMs ?? null}, now())
  `);
}

/**
 * The reason a checkout did not become an order.
 *
 * Derived from the `DomainError` code rather than its message, because messages
 * are customer-facing copy and get rewritten; a report keyed on prose silently
 * splits into two series the day someone improves the wording.
 */
export function failureReason(error: unknown): { reason: string; step: string } {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'UNKNOWN';

  /**
   * Which step the shopper was standing on when it failed.
   *
   * This is the half that makes the number actionable: `OUT_OF_STOCK` at the
   * stock step means the catalogue is lying to shoppers, while the same code
   * from the reservation step means someone else got there first — the first is
   * a merchandising defect, the second is ordinary contention.
   */
  const step =
    {
      VALIDATION_FAILED: 'details',
      OUT_OF_STOCK: 'stock',
      RISK_BLOCKED: 'risk',
      ADVANCE_REQUIRED: 'payment',
      PAYMENT_FAILED: 'payment',
      CONFLICT: 'submit',
    }[code] ?? 'unknown';

  return { reason: code, step };
}
