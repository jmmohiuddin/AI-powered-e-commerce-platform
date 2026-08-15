import type { Metadata } from 'next';
import Link from 'next/link';
import { lookupOrder } from '@voltix/commerce';
import { formatPrice } from '@voltix/ui';
import { EMIRATES, normaliseUaePhone } from '@voltix/core';
import { inTenant, tenantContext } from '@/lib/session';
import { clientIdentifier, limitOrderLookup } from '@/lib/rate-limit';
import { resolveLocale, translator } from '@/lib/locale';

export const metadata: Metadata = {
  title: 'Track your order',
  description: 'Check the status of your Voltix order with your order number and phone number.',
  // Never indexed: the results carry a delivery address, and a search engine
  // that crawls a successful lookup would cache someone's home address.
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * GUEST ORDER TRACKING
 *
 * Most orders in this market are placed without an account, so "where is my
 * order" cannot depend on signing in. Two factors instead: the order number,
 * plus the phone it was placed with.
 *
 * One factor would not do. Order numbers are sequential — that is a deliberate
 * property, because a merchant needs gap-free numbering for accounting — which
 * means anyone can guess the next one. This page shows a delivery address, so a
 * bare number lookup would be an address-enumeration endpoint.
 *
 * This route was linked from the footer and from the order confirmation page
 * before it existed. A customer who had just paid and clicked "Track order" got
 * a 404, which is the single worst moment to look broken.
 */
export default async function TrackOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ number?: string; phone?: string }>;
}) {
  const { number, phone } = await searchParams;
  const locale = await resolveLocale();
  const t = translator(locale);
  const ctx = tenantContext();

  const submitted = Boolean(number && phone);
  const normalised = phone ? normaliseUaePhone(phone) : null;

  /**
   * Throttled before the query, not after.
   *
   * Two factors raise the cost of enumeration but do not cap it: the phone is
   * often knowable and the order number is sequential, so an unlimited attempt
   * budget turns this page into a confirmation oracle for "did this person
   * order from here". The limit is what makes the second factor mean something.
   *
   * Counted per attempt rather than per failure. Counting only misses lets an
   * attacker who has found one valid pair keep probing for free, and the
   * legitimate use of this page is one or two lookups.
   */
  const throttled = submitted ? !(await limitOrderLookup(await clientIdentifier())).allowed : false;

  const order =
    submitted && normalised && !throttled
      ? await inTenant((tx) => lookupOrder(tx, ctx, number!, normalised)).catch(() => null)
      : null;

  return (
    <div className="container section" style={{ maxWidth: '640px' }}>
      <h1 style={{ fontSize: 'var(--text-2xl)', marginBottom: 'var(--space-2)' }}>
        Track your order
      </h1>
      <p className="muted" style={{ marginBottom: 'var(--space-5)' }}>
        Enter your order number and the mobile number you ordered with.
      </p>

      {/*
        A GET form. The lookup is a read, so it belongs in the URL: the customer
        can bookmark it, and refreshing does not re-post anything. The phone
        number does land in the query string, which is the one real cost — but
        the alternative, a POST, cannot be linked from the confirmation email
        that this page exists to serve.
      */}
      <form method="get" className="track-form">
        <label className="field">
          <span>Order number</span>
          <input
            name="number"
            defaultValue={number ?? ''}
            required
            inputMode="numeric"
            placeholder="10001"
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span>Mobile number</span>
          <input
            name="phone"
            defaultValue={phone ?? ''}
            required
            type="tel"
            inputMode="tel"
            placeholder="05X XXX XXXX"
            autoComplete="tel"
          />
        </label>
        <button type="submit" className="button button--primary">
          Find my order
        </button>
      </form>

      {throttled && (
        <div className="notice notice--warn" role="status">
          <strong>{t('limit.title')}</strong>
          <p>{t('limit.orders')}</p>
        </div>
      )}

      {/* Silent on whether the order exists. Saying "too many attempts" only
          after a hit would answer the question the limit exists to refuse. */}
      {submitted && !throttled && !order && (
        <div className="notice notice--warn" role="status">
          <strong>We could not find that order.</strong>
          <p>
            Check the order number and make sure the mobile number is the one you ordered with. Both
            <code> 0501234567</code> and <code>+971 50 123 4567</code> work.
          </p>
          <p>
            Still stuck? <Link href="/contact">Contact us</Link> and we will look it up.
          </p>
        </div>
      )}

      {order && (
        <div className="track-result">
          <div className="track-result__head">
            <div>
              <p className="muted">Order</p>
              <h2>#{order.number}</h2>
            </div>
            <div className="track-result__total">
              <p className="muted">Total</p>
              <strong>{formatPrice(order.total, order.currency, locale)}</strong>
            </div>
          </div>

          <ProgressTrail
            status={order.status}
            paymentStatus={order.paymentStatus}
            fulfilmentStatus={order.fulfilmentStatus}
          />

          <dl className="track-result__facts">
            <div>
              <dt>Placed</dt>
              <dd>
                {order.placedAt
                  ? new Intl.DateTimeFormat(locale, {
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                      timeZone: 'Asia/Dubai',
                    }).format(new Date(order.placedAt))
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Items</dt>
              <dd>{order.itemCount}</dd>
            </div>
            <div>
              <dt>Delivering to</dt>
              {/* The emirate only — never the full address. Knowing the order
                  number and phone is enough to check progress; it is not enough
                  to be handed the street and building. */}
              <dd>{EMIRATES.find((e) => e.code === order.emirate)?.name ?? '—'}</dd>
            </div>
            <div>
              <dt>Payment</dt>
              <dd>{order.paymentStatus.replace(/_/g, ' ')}</dd>
            </div>
          </dl>

          <p className="muted" style={{ marginTop: 'var(--space-4)' }}>
            Something wrong with this order? <Link href="/contact">Get in touch</Link> — quote
            #{order.number} and we can help straight away.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The four states a customer actually cares about.
 *
 * Not the nine the database tracks. "partially_fulfilled" is a warehouse
 * concern; the shopper wants to know whether it is coming today. Cancelled
 * short-circuits the whole trail rather than rendering a progress bar for
 * something that is not progressing.
 */
function ProgressTrail({
  status,
  paymentStatus,
  fulfilmentStatus,
}: {
  status: string;
  paymentStatus: string;
  fulfilmentStatus: string;
}) {
  if (status === 'cancelled') {
    return (
      <div className="notice notice--warn" role="status">
        <strong>This order was cancelled.</strong>
        <p>Any payment taken is refunded to the original method within 5–10 working days.</p>
      </div>
    );
  }

  const steps = [
    { label: 'Order placed', done: true },
    {
      label: 'Payment confirmed',
      done: paymentStatus === 'paid' || paymentStatus === 'authorised',
      // Cash on delivery never reaches "paid" before the courier arrives, so
      // labelling it "waiting" forever would read as a problem. It is not one.
      note: paymentStatus === 'unpaid' ? 'Paying on delivery' : undefined,
    },
    {
      label: 'Packed',
      done: fulfilmentStatus !== 'unfulfilled' || status === 'processing' || status === 'completed',
    },
    { label: 'Delivered', done: fulfilmentStatus === 'fulfilled' || status === 'completed' },
  ];

  return (
    <ol className="trail">
      {steps.map((step) => (
        <li key={step.label} className={step.done ? 'trail__step is-done' : 'trail__step'}>
          <span className="trail__dot" aria-hidden="true" />
          <span>
            {step.label}
            {step.note && <em className="trail__note">{step.note}</em>}
          </span>
        </li>
      ))}
    </ol>
  );
}
