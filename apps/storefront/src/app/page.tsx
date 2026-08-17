import Link from 'next/link';
import { formatCount } from '@voltix/ui';
import { ProductCard } from '@/components/product-card';
import { listCategories, listProducts } from '@/lib/catalog';
import { whatsappHref } from '@/lib/contact';
import { localiseCategory } from '@/lib/types';
import { resolveLocale, translator } from '@/lib/locale';

/**
 * Homepage.
 *
 * Revalidated rather than fully static, because the locale is read from a
 * cookie in the root layout — see the trade-off note in lib/locale.ts. Content
 * is still cached and served from the edge between revalidations; personalised
 * strips are deliberately absent from the initial render and stream in as
 * separate islands, because making the whole homepage dynamic to personalise
 * one row is the trade that quietly destroys LCP on commerce sites.
 */
export const revalidate = 300;

export default async function HomePage() {
  const locale = await resolveLocale();
  const t = translator(locale);
  const [products, categories] = await Promise.all([listProducts(), listCategories()]);
  const deals = products.filter((p) => p.compareAtPrice);
  const whatsapp = whatsappHref();

  return (
    <>
      <section className="container hero">
        <div>
          <h1>{t('home.heroTitle')}</h1>
          <p>{t('home.heroBody')}</p>
          <div className="hero__cta">
            <Link className="button button--primary" href="/search?category=smartphones">
              {t('home.shopPhones')}
            </Link>
            {whatsapp && (
              <a className="button button--whatsapp" href={whatsapp}>
                {t('home.whatsapp')}
              </a>
            )}
          </div>
        </div>

        <div className="hero__panel">
          <h2>{t('home.whyTitle')}</h2>
          {/*
            THE IMEI CLAIM WAS REMOVED FROM THE WARRANTY BULLET. DO NOT PUT IT BACK.

            This used to read "…with the IMEI recorded against your order." The
            software has never done that. `serial_units` exists in the schema
            (packages/db/src/schema/inventory.ts) with an `imei` column, and
            NOTHING in this repository writes a row to it — not goods receipt,
            not dispatch, not checkout. The claim was a blanket promise on the
            homepage, so it was made about chargers and mice as well as handsets.
            Logged as debt P-03 (High) against requirement C-05.

            WHAT WOULD HAVE TO BE TRUE TO RESTORE IT:
              1. Goods receipt captures a serial/IMEI per unit into `serial_units`.
              2. Dispatch binds that unit to an `order_items` row
                 (`serial_units.order_item_id`, which already exists).
              3. The claim is then rendered only where a `serial_units` row
                 actually exists for the line — NOT gated on
                 `variants.isSerialised`, which only records that a product
                 line is *meant* to be serial-tracked. That column is populated
                 (the seeder sets it for smartphones) and gating on it would
                 keep showing this promise on every handset, which is precisely
                 where it is false today.

            The replacement says only what the system does do: the warranty
            length is real (`products.warrantyMonths`), and the dated,
            TRN-bearing invoice is real (packages/invoicing) and is what a
            service centre actually asks to see.
          */}
          {/*
            A term-and-definition list, because that is what these are: four
            labelled assurances. It was a `<ul>` of `<li><strong>Label</strong>
            — body</li>`, laid out as a baseline-aligned flex row, and the
            label was a flex item free to shrink. So "Official UAE warranty"
            collapsed into a three-line column beside its own body text while
            "Pay how you like" got two — four rows that each wrapped
            differently and lined up with nothing.

            Stacking the term above its description removes the em-dash too.
            That dash was doing the separating a line break should do, and it
            had to be typed into the markup rather than the stylesheet, which
            meant it stayed an em-dash on the Arabic page as well.
          */}
          <dl className="assurances">
            <div className="assurances__item">
              <dt>{t('home.whyWarrantyTitle')}</dt>
              <dd>{t('home.whyWarrantyBody')}</dd>
            </div>
            <div className="assurances__item">
              <dt>{t('home.whyDeliveryTitle')}</dt>
              <dd>{t('home.whyDeliveryBody')}</dd>
            </div>
            <div className="assurances__item">
              <dt>{t('home.whyPaymentTitle')}</dt>
              <dd>{t('home.whyPaymentBody')}</dd>
            </div>
            <div className="assurances__item">
              <dt>{t('home.whyStockTitle')}</dt>
              <dd>{t('home.whyStockBody')}</dd>
            </div>
          </dl>
        </div>
      </section>

      {/* A store with nothing in it says so. The alternative — the demo
          catalogue, which used to fill this space whenever a tenant came back
          empty — reads as a working shop until the first add-to-cart. */}
      {products.length === 0 && (
        <section className="container section">
          <div className="empty-state">
            <p className="empty-state__title">{t('home.emptyTitle')}</p>
            <p>{t('home.emptyBody')}</p>
          </div>
        </section>
      )}

      {categories.length > 0 && (
        <section className="container section">
          <div className="section__head">
            <h2>{t('home.categories')}</h2>
            <Link href="/search">{t('home.browseAll')}</Link>
          </div>
          {/*
            A category tile is its own block, not a `.product-card` with the
            padding overridden inline. It was the latter, and the two disagreed
            about everything that matters: the product card is a media-first
            tile whose text sits in a padded footer, so reusing it for a
            text-only tile meant an inline `padding` to undo the footer, no
            control over how the two lines relate, and — because the card sizes
            itself to its image — a row of boxes whose height was set by
            whichever category name happened to wrap onto a second line.

            The count is `formatCount`, not `{category.count}`. A bare number
            renders Western digits on the Arabic page while every other numeral
            around it is Eastern Arabic.
          */}
          <div className="category-grid">
            {categories.map((category) => (
              <Link
                key={category.slug}
                href={`/category${category.path}`}
                className="category-card"
              >
                <h3 className="category-card__name">{localiseCategory(category, locale).name}</h3>
                <span className="category-card__count">
                  {formatCount(category.count, locale)}{' '}
                  {category.count === 1 ? t('search.product') : t('search.products')}
                </span>
                {/* The chevron is ornament — the link's accessible name is the
                    heading, and a screen reader announcing "arrow" adds
                    nothing to "Smartphones, link". */}
                <span className="category-card__go" aria-hidden="true">
                  →
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {deals.length > 0 && (
        <section className="container section">
          <div className="section__head">
            <h2>{t('home.deals')}</h2>
            <Link href="/search?sort=price_asc">{t('home.allDeals')}</Link>
          </div>
          <div className="product-grid">
            {deals.map((product) => (
              <ProductCard key={product.id} product={product} locale={locale} t={t} />
            ))}
          </div>
        </section>
      )}

      {products.length > 0 && (
        <section className="container section">
          <div className="section__head">
            <h2>{t('home.popular')}</h2>
            <Link href="/search?sort=rating">{t('home.topRated')}</Link>
          </div>
          <div className="product-grid">
            {products.map((product) => (
              <ProductCard key={product.id} product={product} locale={locale} t={t} />
            ))}
          </div>
          <p className="vat-note vat-note--after-grid">{t('vat.inclusive')}</p>
        </section>
      )}
    </>
  );
}
