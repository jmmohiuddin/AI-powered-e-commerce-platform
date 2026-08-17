import type { Metadata } from 'next';
import Link from 'next/link';
import {
  fill,
  legalCopy,
  listSentence,
  paymentProcessorNames,
} from '@/lib/legal';
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE_SECONDS, resolveLocale } from '@/lib/locale';
import { CART_COOKIE, CART_COOKIE_MAX_AGE_SECONDS, paymentRegistry } from '@/lib/session';
import { merchantIdentity } from '@/lib/merchant';

export async function generateMetadata(): Promise<Metadata> {
  const { privacy } = legalCopy(await resolveLocale());
  return { title: privacy.metaTitle, description: privacy.metaDescription };
}

/**
 * PRIVACY NOTICE — UAE Personal Data Protection Law (PRD requirement L-07).
 *
 * There was no privacy page, and no legal disclosure page of any kind. The
 * routes were contact, products, category, checkout, search, cart, delivery,
 * returns and orders — a store taking names, phone numbers and home addresses
 * from UAE residents with nothing at all to say about what happened to them.
 *
 * DERIVED, NOT DESCRIBED. Every concrete fact on this page is read from the
 * thing that makes it true: the cookie names and lifetimes from the constants
 * that set them, the payment processors from the registry that is built from
 * configuration, the seller's legal identity from the `tenants` row the tax
 * invoice is issued from. `app/delivery/page.tsx` set this rule by computing
 * its charges with the same function checkout charges with. The stakes are
 * higher here: a delivery page that drifts quotes the wrong fee, whereas a
 * privacy page that drifts makes a false statement about someone's data.
 *
 * WHERE A VALUE IS UNSET, THE LINE IS ABSENT. No placeholders. A privacy notice
 * carrying an invented registered address is worse than no privacy notice: it
 * tells a data subject where to send a request that nobody will receive.
 *
 * The one thing here that is a commitment rather than a fact about the code is
 * breach notification. It is marked as such in the copy.
 */
export default async function PrivacyPage() {
  const locale = await resolveLocale();
  const copy = legalCopy(locale);
  const c = copy.privacy;
  const merchant = await merchantIdentity();

  // Only processors this deployment can actually route a payment to. Cash on
  // delivery is registered but maps to no processor, so it drops out.
  const processors = paymentProcessorNames(paymentRegistry().list().map((g) => g.id));

  const hasIdentity = Boolean(
    merchant.legalName ??
      merchant.legalAddress ??
      merchant.taxRegistrationNumber ??
      merchant.tradeLicenceNumber,
  );

  // `-u-nu-latn` pinned, for the reason `westernDigits()` in packages/ui gives:
  // the project shows Western digits in Arabic too, and without pinning whether
  // a reader sees "30" or "٣٠" depends on which locale tag reaches the
  // formatter rather than on a decision anyone made.
  const number = new Intl.NumberFormat(`${locale}-u-nu-latn`);
  const days = (seconds: number) =>
    fill(c.cookieDays, { n: number.format(Math.round(seconds / 86_400)) });

  return (
    <div className="container container--prose section">
      <h1 className="page__title">{c.title}</h1>
      <p className="page__intro">{c.intro}</p>

      <h2 className="section-title">{c.controllerHeading}</h2>
      {hasIdentity && <p>{c.controllerIntro}</p>}
      {hasIdentity ? (
        <div className="notice">
          {merchant.legalName && <p><strong>{merchant.legalName}</strong></p>}
          {merchant.legalAddress && (
            <p>
              {c.controllerAddress}: <span className="pre-line">{merchant.legalAddress}</span>
            </p>
          )}
          {merchant.taxRegistrationNumber && (
            // `dir="ltr"` on the number itself: a 15-digit TRN inside an RTL
            // paragraph reorders visually without it, and a misread tax number
            // is the one thing on this page that must be transcribable.
            <p>
              {c.controllerTrn}: <span dir="ltr">{merchant.taxRegistrationNumber}</span>
            </p>
          )}
          {merchant.tradeLicenceNumber && (
            <p>
              {c.controllerLicence}: <span dir="ltr">{merchant.tradeLicenceNumber}</span>
            </p>
          )}
        </div>
      ) : (
        // Nothing invented. If the tenant row carries no legal identity, the
        // page says the details are not published and points the shopper at a
        // human, rather than printing a name and licence number that would look
        // authoritative and be fiction.
        <p>{c.controllerUnknown}</p>
      )}

      <h2 className="section-title">{c.collectHeading}</h2>
      <p>{c.collectIntro}</p>
      <ul className="prose-list">
        <li>{c.collectRequired}</li>
        <li>{c.collectOptional}</li>
        <li>{c.collectBusiness}</li>
        <li>{c.collectOrder}</li>
      </ul>
      <p>{c.collectNoAccount}</p>
      <p><strong>{c.collectNoCard}</strong></p>

      <h2 className="section-title">{c.basisHeading}</h2>
      <ul className="prose-list">
        <li>{c.basisContract}</li>
        <li>{c.basisLegal}</li>
        <li>{c.basisInterest}</li>
      </ul>

      <h2 className="section-title">{c.cookiesHeading}</h2>
      <p>{c.cookiesIntro}</p>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>{c.cookieColName}</th>
              <th>{c.cookieColPurpose}</th>
              <th>{c.cookieColLifetime}</th>
            </tr>
          </thead>
          <tbody>
            {/*
              Names and lifetimes come from the constants that set the cookies —
              `CART_COOKIE` in lib/session.ts and `LOCALE_COOKIE` in lib/locale.ts.
              Rename a cookie or change a maxAge and this table follows. There is
              no third row because there is no third cookie: no analytics, no
              advertising, no third-party script. See lib/visitor.ts, where the
              decision not to mint a browsing identifier is recorded.
            */}
            <tr>
              <td><code dir="ltr">{CART_COOKIE}</code></td>
              <td>{c.cookieCart}</td>
              <td>{days(CART_COOKIE_MAX_AGE_SECONDS)}</td>
            </tr>
            <tr>
              <td><code dir="ltr">{LOCALE_COOKIE}</code></td>
              <td>{c.cookieLocale}</td>
              <td>{days(LOCALE_COOKIE_MAX_AGE_SECONDS)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>{c.cookiesNone}</p>

      <h2 className="section-title">{c.technicalHeading}</h2>
      <p>{c.technicalBody}</p>

      <h2 className="section-title">{c.transferHeading}</h2>
      {/*
        The disclosure this page most needed to exist for. Postgres is on Neon
        in ap-southeast-1 and the app is served from Vercel's sin1 — both
        Singapore, both outside the UAE, for customers who are all inside it.
        Flagged in the TRD at §3.2 as a compliance input rather than only a
        latency one. Stated in a notice box because burying a cross-border
        transfer in body text is the thing PDPL disclosure is meant to prevent.
      */}
      <div className="notice">
        <p>{c.transferBody}</p>
        <p className="muted">{c.transferReview}</p>
      </div>

      <h2 className="section-title">{c.recipientsHeading}</h2>
      <p>{c.recipientsIntro}</p>
      <ul className="prose-list">
        <li>
          {processors.length > 0
            ? fill(c.recipientsPayment, { providers: listSentence(processors, locale) })
            : c.recipientsPaymentNone}
        </li>
        <li>{c.recipientsCourier}</li>
        <li>{c.recipientsMessaging}</li>
      </ul>
      <p>{c.recipientsNoSale}</p>

      <h2 className="section-title">{c.retentionHeading}</h2>
      <p>{c.retentionBody}</p>
      {/*
        Said out loud because it is true and because the alternative is worse.
        Nothing in this repository deletes or anonymises personal data on a
        schedule — no retention job, no purge, no anonymisation pass. Publishing
        "we keep your data for N months" would have been the ordinary thing to
        write and would have been a lie enforced by nothing.
      */}
      <p className="muted">{c.retentionHonest}</p>

      <h2 className="section-title">{c.rightsHeading}</h2>
      <p>{c.rightsIntro}</p>
      <ul className="prose-list">
        {c.rightsList.map((right) => (
          <li key={right}>{right}</li>
        ))}
      </ul>
      <p>
        {c.rightsHowBefore}
        <Link href="/contact">{copy.contactPageInline}</Link>
        {c.rightsHowAfter}
      </p>
      <p className="muted">{c.rightsVerify}</p>

      <h2 className="section-title">{c.securityHeading}</h2>
      <p>{c.securityBody}</p>
      <p>{c.breachBody}</p>

      <h2 className="section-title">{c.changesHeading}</h2>
      <p>{c.changesBody}</p>
      <p className="muted">
        {copy.lastUpdatedLabel}: {copy.lastUpdated}
      </p>

      <p className="page__footnote">
        <Link href="/terms">{copy.seeAlsoTerms}</Link> · <Link href="/contact">{copy.contactUs}</Link>
      </p>
    </div>
  );
}
