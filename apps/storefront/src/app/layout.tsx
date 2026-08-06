import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { listCategories } from '@/lib/catalog';
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
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
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    httpOnly: false,
  });
  revalidatePath('/', 'layout');
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await resolveLocale();
  const dir = directionOf(locale);
  const t = translator(locale);
  const categories = await listCategories();
  const other: Locale = locale === 'ar-AE' ? 'en-AE' : 'ar-AE';

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
              {categories.map((category) => (
                <li key={category.slug}>
                  <Link href={`/search?category=${category.slug}`}>{category.name}</Link>
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
                  {categories.map((c) => (
                    <li key={c.slug}>
                      <Link href={`/search?category=${c.slug}`}>{c.name}</Link>
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
                  <li>
                    {/* Click-to-call and WhatsApp are ordinary purchase paths in
                        this market, not support links. */}
                    <a href="tel:+97145550000" dir="ltr">
                      +971 4 555 0000
                    </a>
                  </li>
                  <li>
                    <a href="https://wa.me/971500000000">WhatsApp us</a>
                  </li>
                  <li>Open 10am–10pm, Monday to Sunday</li>
                </ul>
              </div>
            </div>
            <p className="site-footer__legal">
              Voltix Electronics Trading L.L.C. · TRN 100123456700003 · Trade Licence CN-1234567 ·
              All prices include 5% VAT. Demo storefront — product data is sample data for
              evaluation, not a live catalogue.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
