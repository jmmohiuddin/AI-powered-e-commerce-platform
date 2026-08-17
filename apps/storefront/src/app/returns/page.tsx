import type { Metadata } from 'next';
import Link from 'next/link';
import { RETURN_POLICY } from '@voltix/core';

export const metadata: Metadata = {
  title: 'Returns & warranty',
  description:
    'How to return an item, what is covered by warranty, and what cannot be returned once opened.',
};

/**
 * The numbers come from `RETURN_POLICY`, the same constant the returns workflow
 * enforces. If the window changes in code, this page changes with it — a
 * published policy that contradicts what the system actually allows is a
 * consumer-protection problem, not just a stale paragraph.
 */
export default function ReturnsPage() {
  const { changeOfMindDays, defectiveGoodsDays, merchantPaysReturnShippingOnDefect } =
    RETURN_POLICY;

  return (
    <div className="container container--prose section">
      <h1 className="page__title">
        Returns &amp; warranty
      </h1>
      <p className="page__intro">
        Electronics are expensive and you should be able to change your mind. Here is exactly where
        you stand.
      </p>

      <h2 className="section-title">Changed your mind — {changeOfMindDays} days</h2>
      <p>
        Return anything within {changeOfMindDays} days of delivery for a full refund, provided it is
        unused and in its original packaging with all accessories. Refunds go back to the method you
        paid with, within 5–10 working days once we have the item.
      </p>
      <p className="muted">
        Return shipping for a change of mind is at your cost. Bring it to us and there is no charge.
      </p>

      <h2 className="section-title">Faulty on arrival — {defectiveGoodsDays} days</h2>
      <p>
        If an item is faulty, we replace it or refund you in full within {defectiveGoodsDays} days —
        your choice, not ours.
        {merchantPaysReturnShippingOnDefect && ' We pay the return shipping.'} You do not need the
        original packaging for a faulty item, though it helps the item survive the trip back.
      </p>

      <h2 className="section-title">What cannot be returned</h2>
      <p>Three categories, and each has a reason rather than a policy:</p>
      <ul className="prose-list">
        <li>
          <strong>Opened in-ear headphones and earbuds.</strong> Hygiene — the same reason no
          retailer takes them back. Sealed and unopened is fine.
        </li>
        <li>
          <strong>Activated software and digital licence keys.</strong> Once redeemed, the licence
          is yours and cannot be un-issued.
        </li>
        <li>
          <strong>Personalised or engraved items.</strong> They cannot be resold to anyone else.
        </li>
      </ul>
      <p className="muted">
        None of this affects your rights if an item is faulty. A defect overrides all three.
      </p>

      <h2 className="section-title">Manufacturer warranty</h2>
      <p>
        Every product carries its manufacturer&rsquo;s UAE warranty — typically 12 months, longer on
        some brands, and shown on each product page. Keep your invoice: it is your proof of purchase
        and it carries our TRN, which service centres ask for.
      </p>
      <p>
        {/*
          Worth saying plainly. Grey-market stock is common in this market and
          its warranty is not honoured by the local service centre, which the
          buyer discovers only when something breaks.
        */}
        We sell only region-official stock, so the warranty is honoured by the authorised service
        centre here rather than by whoever imported it.
      </p>

      <h2 className="section-title">Starting a return</h2>
      <ol className="prose-list">
        <li>
          Find your order on the <Link href="/orders">tracking page</Link> — you will need your
          order number and the mobile number you ordered with.
        </li>
        <li>
          <Link href="/contact">Contact us</Link> with the order number and what is wrong. A photo
          helps for anything faulty.
        </li>
        <li>We arrange collection or give you the drop-off address, and confirm the refund amount.</li>
      </ol>

      <p className="page__footnote muted">
        Refunds are for the amount you paid. Where the fault was ours, that includes the original
        delivery charge; for a change of mind, the delivery charge is not refunded.
      </p>
    </div>
  );
}
