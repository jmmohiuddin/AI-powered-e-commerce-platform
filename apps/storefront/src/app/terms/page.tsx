import type { Metadata } from 'next';
import Link from 'next/link';
import {
  FULL_TAX_INVOICE_THRESHOLD,
  RETURN_POLICY,
  UAE,
  UAE_VAT_RATE_BPS,
} from '@voltix/core';
import { formatPrice } from '@voltix/ui';
import { fill, legalCopy, listSentence } from '@/lib/legal';
import { resolveLocale } from '@/lib/locale';
import { paymentRegistry } from '@/lib/session';
import { merchantIdentity } from '@/lib/merchant';

export async function generateMetadata(): Promise<Metadata> {
  const { terms } = legalCopy(await resolveLocale());
  return { title: terms.metaTitle, description: terms.metaDescription };
}

/**
 * TERMS OF SALE — UAE consumer protection (PRD requirement L-05).
 *
 * Split from the privacy notice because the two answer different questions to
 * different regulators. Privacy is PDPL: what happens to your data. This is
 * Federal Law 15/2020 as amended and Cabinet Decision 66/2023: who the licensed
 * entity behind the shop is, that the displayed price is the price charged,
 * that a dated invoice is issued, and that the warranty is honoured. Merging
 * them would bury the licensing disclosure in the middle of a data policy,
 * which is the one place a shopper checking who they are buying from will not
 * look.
 *
 * Every figure is derived: the VAT rate from `UAE_VAT_RATE_BPS`, the full-tax-
 * invoice threshold from `FULL_TAX_INVOICE_THRESHOLD` (the same constant
 * `requiredInvoiceKind()` decides with), the return windows from
 * `RETURN_POLICY` — whose change-of-mind window is now environment
 * configuration — and the payment methods from the registry that checkout
 * actually offers. Nothing here can promise something the software does not do
 * without the constant behind it changing first.
 */
export default async function TermsPage() {
  const locale = await resolveLocale();
  const copy = legalCopy(locale);
  const t = copy.terms;
  const merchant = await merchantIdentity();

  // What checkout can genuinely take, in the order it offers it. Reading the
  // registry rather than listing methods means an unconfigured gateway is never
  // advertised here as accepted.
  // De-duplicated: Stripe and Network International both present as "Card",
  // which is right at checkout and reads as a stutter in a sentence.
  const methods = [...new Set(paymentRegistry().list().map((gateway) => gateway.displayName))];

  const hasIdentity = Boolean(
    merchant.legalName ??
      merchant.legalAddress ??
      merchant.taxRegistrationNumber ??
      merchant.tradeLicenceNumber,
  );

  return (
    <div className="container section" style={{ maxWidth: '760px' }}>
      <h1 style={{ fontSize: 'var(--text-2xl)', marginBottom: 'var(--space-2)' }}>{t.title}</h1>
      <p className="muted" style={{ marginBottom: 'var(--space-6)' }}>{t.intro}</p>

      <h2 className="section-title">{t.sellerHeading}</h2>
      {hasIdentity ? (
        <>
          <p>{t.sellerIntro}</p>
          <div className="notice">
            {merchant.legalName && <p><strong>{merchant.legalName}</strong></p>}
            {merchant.legalAddress && (
              <p style={{ whiteSpace: 'pre-line' }}>{merchant.legalAddress}</p>
            )}
            {merchant.taxRegistrationNumber && (
              <p>
                {copy.privacy.controllerTrn}:{' '}
                <span dir="ltr">{merchant.taxRegistrationNumber}</span>
              </p>
            )}
            {merchant.tradeLicenceNumber && (
              <p>
                {copy.privacy.controllerLicence}:{' '}
                <span dir="ltr">{merchant.tradeLicenceNumber}</span>
              </p>
            )}
          </div>
        </>
      ) : (
        <p>{t.sellerUnknown}</p>
      )}

      <h2 className="section-title">{t.pricesHeading}</h2>
      <p>{fill(t.pricesBody, { vatRate: UAE_VAT_RATE_BPS / 100 })}</p>
      <p>
        {t.pricesDeliveryBefore}
        <Link href="/delivery">{copy.deliveryPageInline}</Link>
        {t.pricesDeliveryAfter}
      </p>

      <h2 className="section-title">{t.invoiceHeading}</h2>
      <p>{t.invoiceBody}</p>
      <p>
        {fill(t.invoiceFull, {
          threshold: formatPrice(FULL_TAX_INVOICE_THRESHOLD.amount, UAE.currency, locale),
        })}
      </p>

      <h2 className="section-title">{t.warrantyHeading}</h2>
      <p>{t.warrantyBody}</p>
      {/*
        THE IMEI DISCLOSURE.

        Stated positively rather than left as a silence. The storefront used to
        promise that the IMEI was recorded against the order, on the homepage,
        on every product page and in two answerable facts, and nothing in the
        system has ever written a row to `serial_units`. Deleting those four
        sentences makes the site stop lying; saying this makes it tell the
        truth, which is not the same thing — a buyer who read the old copy, or
        who simply assumes a retailer logs the serial, otherwise carries an
        expectation the warranty process will not meet.

        Delete this paragraph when serial capture ships, not before.
      */}
      <p className="muted">{t.warrantyNoImei}</p>

      <h2 className="section-title">{t.returnsHeading}</h2>
      {/*
        Both windows come from `RETURN_POLICY`, the same object /returns renders
        from and the returns workflow enforces. `changeOfMindDays` is now read
        from `RETURNS_CHANGE_OF_MIND_DAYS` on each access, so when counsel rules
        on L-06 this sentence, the returns page and the workflow all move
        together on a restart — which is the whole point of making it
        configuration rather than a constant.
      */}
      <p>
        {fill(t.returnsBodyBefore, {
          days: RETURN_POLICY.changeOfMindDays,
          defectDays: RETURN_POLICY.defectiveGoodsDays,
        })}
        <Link href="/returns">{copy.returnsPageInline}</Link>
        {t.returnsBodyAfter}
      </p>

      <h2 className="section-title">{t.paymentHeading}</h2>
      <p>
        {methods.length > 0
          ? fill(t.paymentBody, { providers: listSentence(methods, locale) })
          : t.paymentNone}
      </p>

      <h2 className="section-title">{t.orderHeading}</h2>
      <p>{t.orderBody}</p>

      <h2 className="section-title">{t.lawHeading}</h2>
      <p>{t.lawBody}</p>
      <p className="muted">
        {copy.lastUpdatedLabel}: {copy.lastUpdated}
      </p>

      <p style={{ marginTop: 'var(--space-6)' }}>
        <Link href="/privacy">{copy.seeAlsoPrivacy}</Link> ·{' '}
        <Link href="/contact">{copy.contactUs}</Link>
      </p>
    </div>
  );
}
