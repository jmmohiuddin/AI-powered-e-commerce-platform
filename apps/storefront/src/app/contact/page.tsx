import type { Metadata } from 'next';
import Link from 'next/link';
import { UAE_VAT_RATE_BPS } from '@voltix/core';
import { supportEmail, supportPhone, telHref, whatsappHref, whatsappNumber } from '@/lib/contact';

export const metadata: Metadata = {
  title: 'Contact us',
  description: 'WhatsApp, phone and email — how to reach Voltix, and when we reply.',
};

/**
 * Contact page.
 *
 * WhatsApp leads, and that is a market decision rather than a stylistic one: in
 * the UAE it is the default channel for retail support, and a shopper who has
 * to compose an email is a shopper who calls a competitor instead. Phone is
 * second because high-value electronics purchases get confirmed by voice.
 *
 * There is no contact *form* here. A form that emails a mailbox nobody watches
 * is worse than no form — it absorbs the message and gives the customer a false
 * sense that it arrived. Real channels only, until the support inbox is wired
 * up and someone owns it.
 */
export default function ContactPage() {
  const whatsapp = whatsappNumber();
  const whatsappLink = whatsappHref();
  const phone = supportPhone();
  const telephone = telHref();
  const email = supportEmail();

  return (
    <div className="container container--focused section">
      <h1 className="page__title">Contact us</h1>
      <p className="page__intro">
        A real person reads every message. Have your order number ready if it is about an order —
        it saves a round trip.
      </p>

      <div className="contact-grid">
        {whatsapp && whatsappLink && (
          <a
            className="contact-card"
            href={whatsappLink}
            target="_blank"
            // noreferrer alongside noopener: this is an outbound link from a
            // page a customer reaches mid-purchase, and the referrer would
            // leak which page they came from.
            rel="noopener noreferrer"
          >
            <strong>WhatsApp</strong>
            <span>{whatsapp}</span>
            <span className="muted">Fastest — usually within the hour, 9am–9pm</span>
          </a>
        )}

        {phone && telephone && (
          <a className="contact-card" href={telephone}>
            <strong>Call us</strong>
            <span>{phone}</span>
            <span className="muted">Sunday–Thursday, 9am–6pm Gulf Standard Time</span>
          </a>
        )}

        {email && (
          <a className="contact-card" href={`mailto:${email}`}>
            <strong>Email</strong>
            <span>{email}</span>
            <span className="muted">Replies within one working day</span>
          </a>
        )}
      </div>

      {!whatsapp && !phone && !email && (
        // Honest rather than decorative. If nobody has configured a contact
        // channel, saying so beats printing a placeholder number that rings
        // a stranger's phone.
        <div className="notice notice--warn">
          <strong>Contact details are not configured yet.</strong>
          <p>
            Set <code>NEXT_PUBLIC_WHATSAPP_NUMBER</code>, <code>NEXT_PUBLIC_SUPPORT_PHONE</code> or{' '}
            <code>NEXT_PUBLIC_SUPPORT_EMAIL</code> to show them here.
          </p>
        </div>
      )}

      <h2 className="section-title">Before you write</h2>
      <p>Three things answer most messages faster than we can:</p>
      <ul className="prose-list">
        <li>
          <Link href="/orders">Track your order</Link> — status, payment and delivery emirate, with
          your order number and mobile.
        </li>
        <li>
          <Link href="/delivery">Delivery &amp; charges</Link> — times per emirate, the free
          delivery threshold, and how cash on delivery works.
        </li>
        <li>
          <Link href="/returns">Returns &amp; warranty</Link> — the return windows and what cannot
          go back once opened.
        </li>
      </ul>

      <h2 className="section-title">Business customers</h2>
      <p>
        We issue full tax invoices carrying our TRN, which you need to reclaim the{' '}
        {UAE_VAT_RATE_BPS / 100}% VAT. Send us your company TRN with the order number and we will
        reissue the invoice in your company&rsquo;s name.
      </p>

      <p className="page__footnote muted">
        Please do not send card numbers, CVVs, or Emirates ID scans over WhatsApp or email. We will
        never ask for them, and anyone who does is not us.
      </p>
    </div>
  );
}
