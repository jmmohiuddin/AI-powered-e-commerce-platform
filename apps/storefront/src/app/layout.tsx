import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { listCategories } from '@/lib/catalog';
import { supportPhone, telHref, whatsappHref } from '@/lib/contact';
import { legalCopy } from '@/lib/legal';
import { merchantIdentity } from '@/lib/merchant';
import { localiseCategory } from '@/lib/types';
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE_SECONDS,
  directionOf,
  resolveLocale,
  translator,
  type Locale,
} from '@/lib/locale';
import './globals.css';

/**
 * Root layout.
 *
 * Header, nav and footer are server components with no client JavaScript. On a
 * listing page that is the difference between a 40KB and a 300KB hydration
 * payload, and on the mid-range Android phones that carry most UAE mobile
 * traffic that difference is seconds of Interaction to Next Paint.
 * Interactivity is added per-island (variant picker, cart), never page-wide.
 *
 * `lang` and `dir` are set from the resolved locale. `dir` on the root element
 * is what makes every logical CSS property in globals.css flip — it is one
 * attribute doing the work that a separate RTL stylesheet would otherwise do.
 */

export const metadata: Metadata = {
  // `||` not `??`: `new URL('')` throws, which would take down every page.
  metadataBase: new URL(process.env.STOREFRONT_URL || 'http://localhost:3000'),
  title: {
    default: 'Voltix — Smartphones, accessories & electronics in the UAE',
    template: '%s · Voltix',
  },
  description:
    'Genuine smartphones, mobile accessories and computer gear with official UAE warranty, card, Tabby and cash on delivery, and same-day dispatch across the Emirates.',
  openGraph: { type: 'website', siteName: 'Voltix', locale: 'en_AE', alternateLocale: ['ar_AE'] },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0c0a09' },
  ],
};

/**
 * Language switch as a server action — no client bundle for a control most
 * visitors use once, if ever.
 */
async function switchLocale(formData: FormData) {
  'use server';
  const next = String(formData.get('locale') ?? DEFAULT_LOCALE) as Locale;
  const store = await cookies();
  store.set(LOCALE_COOKIE, next, {
    path: '/',
    maxAge: LOCALE_COOKIE_MAX_AGE_SECONDS,
    sameSite: 'lax',
    httpOnly: false,
  });
  revalidatePath('/', 'layout');
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await resolveLocale();
  const dir = directionOf(locale);
  const t = translator(locale);
  const legal = legalCopy(locale);
  // Two independent reads, issued together rather than in series — the footer
  // needs both and neither depends on the other.
  const [categories, merchant] = await Promise.all([listCategories(), merchantIdentity()]);
  const other: Locale = locale === 'ar-AE' ? 'en-AE' : 'ar-AE';
  const phone = supportPhone();
  const telephone = telHref();
  const whatsapp = whatsappHref();

  return (
    <html lang={locale} dir={dir}>
      <body>
        <a className="skip-link" href="#main">
          {t('nav.skip')}
        </a>

        <header className="site-header">
          <div className="container site-header__inner">
            <Link href="/" className="logo">
              volt<span>ix</span>
            </Link>

            <form className="search-form" action="/search" role="search">
              <label className="visually-hidden" htmlFor="q">
                {t('nav.search')}
              </label>
              <input
                id="q"
                name="q"
                type="search"
                placeholder={t('nav.searchPlaceholder')}
                autoComplete="off"
              />
              <button type="submit">{t('nav.searchButton')}</button>
            </form>

            <div className="header-actions">
              {/*
                No "Account" link, because there are no customer accounts yet.
                Order tracking covers what an account would be used for here —
                checking on a purchase — and it works for guests, which is how
                most orders in this market are placed. A link to a sign-in page
                that does not exist is a 404 in the header of every page.
              */}
              <Link href="/orders">{t('nav.trackOrder')}</Link>
              <Link href="/cart">{t('nav.cart')}</Link>
              <form action={switchLocale}>
                <input type="hidden" name="locale" value={other} />
                <button className="locale-switch" type="submit" lang={other}>
                  {t('locale.switch')}
                </button>
              </form>
            </div>
          </div>
        </header>

        <nav className="nav-bar" aria-label={t('nav.categories')}>
          <div className="container">
            <ul>
              {/* Top level only. A nav listing every leaf of a deep taxonomy is
                  a nav nobody reads; drill-down belongs on the category page. */}
              {categories
                .filter((category) => category.depth === 0)
                .map((category) => (
                  <li key={category.slug}>
                    <Link href={`/category${category.path}`}>
                      {localiseCategory(category, locale).name}
                    </Link>
                  </li>
                ))}
              <li>
                <Link href="/search?sort=price_asc">{t('nav.deals')}</Link>
              </li>
            </ul>
          </div>
        </nav>

        <main id="main">{children}</main>

        <footer className="site-footer">
          <div className="container">
            <div className="site-footer__grid">
              <div>
                <h3>{t('footer.shop')}</h3>
                <ul>
                  {categories
                    .filter((c) => c.depth === 0)
                    .map((c) => (
                      <li key={c.slug}>
                        <Link href={`/category${c.path}`}>
                          {localiseCategory(c, locale).name}
                        </Link>
                      </li>
                    ))}
                </ul>
              </div>
              <div>
                <h3>{t('footer.help')}</h3>
                <ul>
                  <li>
                    <Link href="/orders">{t('nav.trackOrder')}</Link>
                  </li>
                  <li>
                    <Link href="/returns">Returns &amp; warranty</Link>
                  </li>
                  <li>
                    <Link href="/delivery">Delivery &amp; charges</Link>
                  </li>
                  <li>
                    <Link href="/contact">Contact us</Link>
                  </li>
                  {/* The two legal pages. Reachable from every page rather than
                      only from checkout: a shopper deciding whether to hand over
                      an address is making that decision on a product page. */}
                  <li>
                    <Link href="/privacy">{legal.seeAlsoPrivacy}</Link>
                  </li>
                  <li>
                    <Link href="/terms">{legal.seeAlsoTerms}</Link>
                  </li>
                </ul>
              </div>
              <div>
                <h3>{t('footer.buying')}</h3>
                <ul>
                  <li>Card, Apple Pay &amp; Google Pay</li>
                  <li>Tabby — 4 interest-free payments</li>
                  <li>{t('trust.cod')}</li>
                  <li>{t('vat.inclusive')}</li>
                </ul>
              </div>
              <div>
                <h3>{t('footer.contact')}</h3>
                <ul>
                  {phone && telephone && (
                    <li>
                      {/* Click-to-call and WhatsApp are ordinary purchase paths in
                          this market, not support links. */}
                      <a href={telephone} dir="ltr">
                        {phone}
                      </a>
                    </li>
                  )}
                  {whatsapp && (
                    <li>
                      <a href={whatsapp}>WhatsApp us</a>
                    </li>
                  )}
                  <li>Open 10am–10pm, Monday to Sunday</li>
                </ul>
              </div>
            </div>
            {/*
              THE LICENSING DISCLOSURE, READ FROM THE TENANT ROW.

              This line used to carry the legal name, TRN and trade licence as
              literal text. The same TRN is printed on every tax invoice from
              `tenants.tax_registration_number`, so the footer was a second copy
              of a legally significant number with nothing keeping the two in
              agreement — and on any tenant other than the seeded demo it was
              simply another merchant's details.

              Each part is omitted when the column is null rather than replaced
              with a placeholder: an invented trade licence number on a live
              storefront is a false statement to a regulator. See lib/merchant.ts.
            */}
            <p className="site-footer__legal">
              {merchant.legalName && <>{merchant.legalName} · </>}
              {merchant.taxRegistrationNumber && (
                <>TRN <span dir="ltr">{merchant.taxRegistrationNumber}</span> · </>
              )}
              {merchant.tradeLicenceNumber && (
                <>Trade Licence <span dir="ltr">{merchant.tradeLicenceNumber}</span> · </>
              )}
              {t('vat.inclusive')} · <Link href="/privacy">{legal.seeAlsoPrivacy}</Link> ·{' '}
              <Link href="/terms">{legal.seeAlsoTerms}</Link> · Demo storefront — product data is
              sample data for evaluation, not a live catalogue.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
