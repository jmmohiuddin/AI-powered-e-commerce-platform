import 'server-only';
import { cache } from 'react';
import { after } from 'next/server';
import {
  recordAnalyticsEvent,
  recordSearchQuery,
  type AnalyticsEvent,
  type SearchQueryLog,
} from '@voltix/commerce';
import { inTenant, tenantContext } from './session';

/**
 * The only way the storefront records an event.
 *
 * It exists so that no call site can get the important part wrong. Recording a
 * shopper's behaviour must never be able to cost the shop a sale, and there are
 * two ways to break that rule: write the event inside the caller's transaction
 * so a failed INSERT rolls back their order, or let the promise reject and take
 * a Server Action down with it. Both are easy to do by accident and neither is
 * visible in review. So the transaction is opened here, and every error dies
 * here.
 *
 * Swallowing errors is normally a smell, and it is the correct behaviour
 * exactly once: when the failure of the subsystem is strictly less costly than
 * the failure it would cause upstream. A missing row in a report is less costly
 * than a checkout that 500s. It is logged rather than silently dropped, so a
 * broken writer shows up in the logs instead of as a mysteriously flat funnel.
 */
export async function track(event: AnalyticsEvent): Promise<void> {
  try {
    const ctx = tenantContext();
    await inTenant((tx) => recordAnalyticsEvent(tx, ctx, event));
  } catch (error) {
    console.error('[analytics] failed to record %s: %s', event.type, String(error));
  }
}

/**
 * The same rule for the search log, which is a second table rather than a
 * second event — see `recordSearchQuery`.
 */
export async function trackSearchQuery(log: SearchQueryLog): Promise<void> {
  try {
    const ctx = tenantContext();
    await inTenant((tx) => recordSearchQuery(tx, ctx, log));
  } catch (error) {
    console.error('[analytics] failed to record search %s: %s', log.query, String(error));
  }
}

/**
 * RECORDING FROM A PAGE RENDER RATHER THAN FROM AN ACTION.
 *
 * The events above are written from Server Actions, where awaiting the INSERT
 * inline is right: the shopper is already waiting for the action to finish, and
 * an un-awaited promise on a serverless runtime is killed the moment the
 * response is returned — dropping events precisely in the fastest cases, which
 * would bias the funnel toward the happy path.
 *
 * A page render is the opposite situation. The shopper is waiting for *bytes*,
 * and a database round trip awaited inside the component is a round trip added
 * to time-to-first-byte on the two highest-traffic pages in the store. The
 * `analytics_events` table's own doc comment makes the rule explicit: analytics
 * must not be able to slow down or fail a page render.
 *
 * `after()` resolves both halves rather than trading one for the other. The
 * callback runs once the response has finished, so it is off the render path,
 * and it is not fire-and-forget: Next hands the promise to the platform's
 * `waitUntil`, which extends the invocation until it settles. The promise
 * therefore survives exactly the serverless teardown that made the un-awaited
 * version unusable.
 *
 * Two consequences the call sites have to respect, both from the framework
 * rather than from us:
 *
 *  1. `cookies()` and `headers()` cannot be read inside the callback of a
 *     Server Component — they must be read during render and passed in. That is
 *     why `pageVisitor()` is called by the page and the resulting values are
 *     closed over here.
 *  2. React may render a component more than once for a single request, and a
 *     product page that reports two views for one visit is a product page whose
 *     numbers are wrong. `renderGuard` below is what stops that.
 */

/**
 * One mutable box per key per request.
 *
 * `cache()` memoises on *argument identity*, so memoising the write itself
 * would not work here: each render builds a fresh event object, every call
 * would miss, and the guard would guard nothing. Keying on a string the caller
 * chooses is what makes the second render find the first render's box.
 */
const renderGuard = cache((_key: string) => ({ scheduled: false }));

function once(key: string, schedule: () => void): void {
  const guard = renderGuard(key);
  if (guard.scheduled) return;
  guard.scheduled = true;
  schedule();
}

/** `key` identifies the thing being recorded, not the request — see `once`. */
export function trackAfterRender(key: string, event: AnalyticsEvent): void {
  once(`event:${key}`, () => after(() => track(event)));
}

export function trackSearchQueryAfterRender(key: string, log: SearchQueryLog): void {
  once(`search:${key}`, () => after(() => trackSearchQuery(log)));
}
