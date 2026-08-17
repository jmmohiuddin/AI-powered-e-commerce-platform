import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { lookupOrder } from '@voltix/commerce';
import { formatPrice } from '@voltix/ui';
import { normaliseUaePhone } from '@voltix/core';
import { inTenant, tenantContext } from '@/lib/session';
import { resolveLocale, translator } from '@/lib/locale';

export const metadata: Metadata = {
  title: 'Order confirmed',
  // A confirmation page carries a delivery address. It is never indexed and
  // never sends a referrer.
  robots: { index: false, follow: false },
};
export const dynamic = 'force-dynamic';

type Params = Promise<{ number: string }>;
type Search = Promise<{ phone?: string }>;

export default async function ConfirmationPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const { number } = await params;
  const { phone } = await searchParams;
  const locale = await resolveLocale();
  const t = translator(locale);
  const ctx = tenantContext();

  /**
   * Two factors, even on the confirmation page.
   *
   * An order number is sequential and therefore guessable, and this page shows
   * a delivery address. Requiring the phone the order was placed with means a
   * stranger incrementing the number in the URL sees nothing.
   */
  const normalised = phone ? normaliseUaePhone(phone) : null;
  if (!normalised) notFound();

  const order = await inTenant((tx) => lookupOrder(tx, ctx, number, normalised)).catch(() => null);
  if (!order) notFound();

  const paid = order.paymentStatus === 'paid';

  return (
    <div className="container container--focused section">
      <div className="confirmation">
        <p className="confirmation__badge">Order confirmed</p>
        <h1 className="page__title">
          Thank you, {order.customerName ?? 'and welcome'}
        </h1>
        <p className="page__intro">
          Order <strong>#{order.number}</strong> ·{' '}
          {formatPrice(order.total, order.currency, locale)}
        </p>

        <dl className="summary__rows">
          <div>
            <dt>Payment</dt>
            <dd>{paid ? 'Paid' : 'Cash on delivery'}</dd>
          </div>
          <div>
            <dt>Items</dt>
            <dd>{order.itemCount}</dd>
          </div>
          <div>
            <dt>Delivering to</dt>
            <dd>{emirateName(order.emirate)}</dd>
          </div>
        </dl>

        <p className="page__footnote">
          {paid
            ? 'We have your payment. You will get an SMS when the parcel is dispatched.'
            : 'Have the exact amount ready — the courier collects on delivery. You will get an SMS before they arrive.'}
        </p>

        <div className="hero__cta">
          <Link className="button button--secondary" href={`/orders?number=${order.number}`}>
            {t('nav.trackOrder')}
          </Link>
          <Link className="button button--primary" href="/search">
            {t('home.browseAll')}
          </Link>
        </div>

        {/*
          The promise this page has always made, now kept on the page itself.
          The link carries the same phone that got the shopper here, because the
          invoice route enforces the same two factors — an invoice shows the
          delivery address, every line, and a business buyer's TRN.
        */}
        <p className="vat-note vat-note--after-grid">
          <a href={`/checkout/confirmation/${order.number}/invoice?phone=${encodeURIComponent(normalised)}`}>
            Download your tax invoice
          </a>{' '}
          — it shows the VAT breakdown and our TRN. A copy is sent with your order.
        </p>
      </div>
    </div>
  );
}

function emirateName(code: string | null): string {
  const names: Record<string, string> = {
    DU: 'Dubai',
    AZ: 'Abu Dhabi',
    SH: 'Sharjah',
    AJ: 'Ajman',
    UQ: 'Umm Al Quwain',
    RK: 'Ras Al Khaimah',
    FU: 'Fujairah',
  };
  return code ? (names[code] ?? code) : 'the UAE';
}
