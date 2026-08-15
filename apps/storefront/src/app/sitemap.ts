import type { MetadataRoute } from 'next';
import { listCategoryPaths, listProductSlugs } from '@/lib/catalog';

/**
 * SITEMAP
 *
 * The store had none, which for a catalogue is the difference between Google
 * finding the products it happens to crawl to and being handed the full list.
 * Category pages matter most here — they are the only indexable listings, and
 * the deeper ones are otherwise three clicks from anywhere.
 *
 * BOTH LOCALES POINT AT THE SAME URL. That is not an oversight: en-AE and ar-AE
 * are served from one address and chosen by cookie (see lib/locale.ts, which
 * documents the trade and the `/[locale]/…` migration that would change it).
 * Declaring the alternates anyway is what tells a crawler an Arabic rendering
 * exists; it mirrors exactly what products/[slug] already claims in its
 * `alternates.languages`. If the locale ever moves into the path, this and that
 * page change together.
 */

const CHANGE_FREQUENCY = {
  home: 'daily',
  category: 'daily',
  product: 'weekly',
  content: 'monthly',
} as const;

/** Static pages worth crawling. Excludes anything in `robots.ts`'s disallow list. */
const CONTENT_ROUTES = ['/contact', '/delivery', '/returns'] as const;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = (process.env.STOREFRONT_URL || 'http://localhost:3000').replace(/\/$/, '');
  const entry = (path: string, changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency'], priority: number, lastModified?: Date) => {
    const url = `${base}${path}`;
    return {
      url,
      ...(lastModified ? { lastModified } : {}),
      changeFrequency,
      priority,
      alternates: { languages: { 'en-AE': url, 'ar-AE': url } },
    };
  };

  /**
   * A failure here must not take the sitemap down.
   *
   * `catalog` rethrows database errors in production, and an uncaught throw in
   * this route serves a 500 to Googlebot for `/sitemap.xml`. A sitemap missing
   * its product URLs is a bad day; a sitemap that 500s repeatedly gets the file
   * dropped from Search Console altogether.
   */
  const [categoryPaths, productSlugs] = await Promise.all([
    listCategoryPaths().catch(() => []),
    listProductSlugs().catch(() => []),
  ]);

  return [
    entry('/', CHANGE_FREQUENCY.home, 1),
    ...categoryPaths.map((path) => entry(`/category${path}`, CHANGE_FREQUENCY.category, 0.8)),
    ...productSlugs.map((product) =>
      entry(
        `/products/${product.slug}`,
        CHANGE_FREQUENCY.product,
        0.7,
        product.updatedAt ?? undefined,
      ),
    ),
    ...CONTENT_ROUTES.map((path) => entry(path, CHANGE_FREQUENCY.content, 0.3)),
  ];
}
