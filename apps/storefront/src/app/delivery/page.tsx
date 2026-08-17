import type { Metadata } from 'next';
import Link from 'next/link';
import { DELIVERY_ZONES, EMIRATES, UAE, UAE_VAT_RATE_BPS } from '@voltix/core';
import { formatPrice } from '@voltix/ui';
import { resolveLocale } from '@/lib/locale';
import { deliveryFee } from '@/lib/session';

export const metadata: Metadata = {
  title: 'Delivery & charges',
  description:
    'Delivery times and charges across all seven emirates, free delivery threshold, and cash on delivery terms.',
};

/**
 * The delivery page is generated from the same constants the checkout charges
 * from — `DELIVERY_ZONES` and `deliveryFee()`.
 *
 * A hand-written table is the usual approach and it is a liability: the day
 * someone changes the free-delivery threshold in code, this page keeps
 * promising the old one, and a customer who reads it before checking out is
 * quoted a different number at payment. That is a chargeback and a bad review,
 * caused by a stale paragraph.
 */
export default async function DeliveryPage() {
  const locale = await resolveLocale();

  // Derived, not typed in. If the threshold changes, this sentence changes.
  const freeFrom = (() => {
    // Binary search would be over-engineering for a constant; probe the
    // function that actually decides, so the page can never disagree with it.
    for (let amount = 0; amount <= 100_000; amount += 100) {
      if (deliveryFee('DU', amount) === 0) return amount;
    }
    return null;
  })();

  return (
    <div className="container container--prose section">
      <h1 className="page__title">
        Delivery &amp; charges
      </h1>
      <p className="page__intro">
        We deliver to all seven emirates. Prices shown across the site already include{' '}
        {UAE_VAT_RATE_BPS / 100}% VAT.
      </p>

      {freeFrom !== null && (
        <div className="notice notice--lead">
          <strong>Free delivery on orders over {formatPrice(freeFrom, UAE.currency, locale)}</strong>
          <p>Applies to every emirate. Below that, the charge depends on where you are.</p>
        </div>
      )}

      <h2 className="section-title">Times and charges</h2>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>Emirate</th>
              <th>Typical delivery</th>
              <th>Same day</th>
              <th className="numeric">Charge</th>
            </tr>
          </thead>
          <tbody>
            {EMIRATES.map((emirate) => {
              const zone = DELIVERY_ZONES[emirate.code];
              return (
                <tr key={emirate.code}>
                  <td>{emirate.name}</td>
                  <td>
                    {zone.standardDays} working day{zone.standardDays === 1 ? '' : 's'}
                  </td>
                  <td>
                    {/* The cut-off hour is the useful half. "Same day available"
                        without it is a promise the customer discovers is false
                        at 3pm — which is worse than not offering it. */}
                    {zone.sameDayCutoffHour !== null
                      ? `Order before ${zone.sameDayCutoffHour}:00`
                      : '—'}
                  </td>
                  <td className="numeric">
                    {formatPrice(deliveryFee(emirate.code, 0), UAE.currency, locale)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2 className="section-title">Working days</h2>
      <p>
        {/*
          Saturday–Sunday, not Friday–Saturday. The UAE moved to a Sat–Sun
          weekend in January 2022 and plenty of storefronts still quote the old
          one — which makes every delivery estimate wrong by a day or two, in
          the direction that disappoints.
        */}
        Our weekend is <strong>Saturday and Sunday</strong>, so delivery estimates count Monday to
        Friday. An order placed on Thursday afternoon is picked on Monday.
      </p>

      <h2 className="section-title">Addresses without a postcode</h2>
      <p>
        The UAE has no postal-code system, so we ask for your <strong>emirate</strong>, your{' '}
        <strong>area or community</strong>, and either a <strong>building name</strong> or a{' '}
        <strong>Makani number</strong> — the 10-digit code on the blue plate at most entrances.
        A Makani number gets the driver to your door rather than to your street, which is the
        difference between one phone call and three.
      </p>
      <p className="muted">
        A PO Box is fine for correspondence but couriers cannot deliver to one, so we ask for a
        physical address as well.
      </p>

      <h2 className="section-title">Cash on delivery</h2>
      <p>
        Available across the country. Please have the exact amount ready — drivers carry limited
        change. For high-value orders we may call to confirm before dispatch, and occasionally ask
        for a part payment in advance; this is about refused deliveries, not about you.
      </p>

      <p className="page__footnote">
        Already ordered? <Link href="/orders">Track your order</Link>. Something else?{' '}
        <Link href="/contact">Contact us</Link>.
      </p>
    </div>
  );
}
