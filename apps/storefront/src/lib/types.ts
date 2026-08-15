/**
 * The storefront read model.
 *
 * Deliberately separate from the Drizzle row types. A page needs a
 * denormalised view that no single table holds, and coupling components to the
 * schema means every column rename becomes a UI change. This is the contract
 * between the two, and both the Postgres repository and the demo fallback
 * satisfy it — which is what lets the app run with or without a database.
 */

export interface ProductVariantView {
  readonly id: string;
  readonly sku: string;
  readonly title: string;
  readonly options: Record<string, string>;
  /** Minor units (fils). VAT-inclusive, as UAE law requires. */
  readonly price: number;
  readonly compareAtPrice?: number;
  readonly available: number;
}

export interface ProductImageView {
  readonly url: string;
  /** Never empty on a meaningful image — falls back to the product title. */
  readonly alt: string;
  /** Intrinsic pixels. Present whenever the upload pipeline produced the row. */
  readonly width?: number;
  readonly height?: number;
  /** Tiny base64 LQIP. Feeds `placeholder="blur"`. */
  readonly blurDataUrl?: string;
}

/**
 * One row of the specification table.
 *
 * For electronics this is not decoration: screen size, chipset and battery are
 * the comparison a shopper is actually making, and an empty spec table sends
 * them to a competitor who filled theirs in.
 */
export interface ProductSpec {
  /** `attributes.key` — stable across renames, so it is what React keys on. */
  readonly key: string;
  /** `attributes.name` — what the shopper reads. */
  readonly label: string;
  /** Formatted for display, with the unit already attached. */
  readonly value: string;
  /** `attributes.isKeySpec` — headline specs, shown before the rest. */
  readonly isKeySpec: boolean;
}

export interface LocaleOverrides {
  readonly title?: string;
  readonly subtitle?: string;
  readonly description?: string;
  readonly highlights?: readonly string[];
}

export interface ProductView {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly brand: string;
  readonly category: string;
  readonly categorySlug: string;
  readonly description: string;
  readonly highlights: readonly string[];
  /**
   * Label → display value, in `attributes.position` order.
   *
   * The flat shape every caller already renders. `specDetails` carries the same
   * values with the metadata this cannot express; read them through
   * `specsOf()` rather than choosing between the two at each call site.
   */
  readonly specs: Readonly<Record<string, string>>;
  /**
   * The specs with their attribute metadata.
   *
   * Optional because the demo catalogue predates it and satisfies the contract
   * with `specs` alone — the same arrangement as `imageUrl` and `images`.
   */
  readonly specDetails?: readonly ProductSpec[];
  /** { "ar-AE": { title, subtitle, … } } — falls back to the base fields. */
  readonly translations?: Readonly<Record<string, LocaleOverrides>>;
  /** The first image, or the placeholder. Kept for callers that want just one. */
  readonly imageUrl: string;
  readonly imageAlt: string;
  /**
   * Every image, in `position` order. Optional because the demo catalogue
   * predates it and satisfies the contract with `imageUrl` alone — read it
   * through `imagesOf()` rather than directly.
   */
  readonly images?: readonly ProductImageView[];
  readonly price: number;
  readonly compareAtPrice?: number;
  readonly currency: string;
  readonly ratingAverage?: number;
  readonly ratingCount: number;
  readonly variants: readonly ProductVariantView[];
  readonly warrantyMonths?: number;
  readonly tags: readonly string[];
  readonly answerableFacts: ReadonlyArray<{ question: string; answer: string }>;
}

export interface SearchFilters {
  readonly query?: string;
  /** A single category, by slug. Descendants are NOT included — see `categoryPath`. */
  readonly category?: string;
  /**
   * A category *subtree*, by materialised path.
   *
   * `/mobiles` matches everything filed under mobiles at any depth, which is
   * what a shopper means by "show me phones". `category` above matches one node
   * exactly, which is what a facet checkbox means. They are different questions
   * and conflating them empties the top of any taxonomy deeper than one level.
   */
  readonly categoryPath?: string;
  readonly brand?: string;
  readonly minPrice?: number;
  readonly maxPrice?: number;
  readonly inStockOnly?: boolean;
  readonly sort?: 'relevance' | 'price_asc' | 'price_desc' | 'rating';
  /** 1-based. Out-of-range values are clamped by the repository, never trusted. */
  readonly page?: number;
  readonly pageSize?: number;
}

export interface SearchResult {
  readonly products: readonly ProductView[];
  readonly facets: {
    readonly brands: ReadonlyArray<{ value: string; count: number }>;
    readonly categories: ReadonlyArray<{ value: string; slug: string; count: number }>;
    readonly priceRange: { min: number; max: number };
  };
  readonly intent: string;
  /**
   * Which retrievers actually contributed to this ranking.
   *
   * Reported by the retrieval layer rather than derived from `intent`, and the
   * difference is not academic: `intent` is what the classifier *wanted* to
   * weight, while the semantic leg stays inert until product embeddings are
   * backfilled. Deriving one from the other would log `hybrid` for queries that
   * were answered purely lexically, which is precisely the comparison the
   * `search_queries.strategy` column exists to make.
   *
   * 'lexical' for a browse with no query, because that is what ran.
   */
  readonly strategy: 'lexical' | 'semantic' | 'hybrid';
  /**
   * Every product matching the filters — NOT the number returned on this page.
   *
   * This used to be `products.length` after a LIMIT, so it silently agreed with
   * itself and was wrong for any result set larger than the page. Pagination is
   * arithmetic on this number; a lie here becomes a missing last page.
   */
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
}

/**
 * Products per listing page.
 *
 * Lives here rather than in the repository because the demo catalogue paginates
 * too, and a fallback that pages differently from Postgres is a fallback that
 * hides paging bugs until production.
 */
export const DEFAULT_PAGE_SIZE = 24;

/** { "ar-AE": { name, description, metaTitle, metaDescription } } */
export interface CategoryLocaleOverrides {
  readonly name?: string;
  readonly description?: string;
  readonly metaTitle?: string;
  readonly metaDescription?: string;
}

export interface CategoryView {
  readonly slug: string;
  readonly name: string;
  readonly count: number;
  /** '/mobiles/smartphones' — the materialised ancestor chain, and the route. */
  readonly path: string;
  readonly depth: number;
  readonly translations?: Readonly<Record<string, CategoryLocaleOverrides>>;
}

/** A category page's own row: everything a listing and its metadata need. */
export interface CategoryDetail extends CategoryView {
  readonly description?: string;
  readonly metaTitle?: string;
  readonly metaDescription?: string;
  /** Root first, excluding the category itself. Drives breadcrumbs. */
  readonly ancestors: readonly CategoryView[];
  /** Direct children only — one level of drill-down, not the whole subtree. */
  readonly children: readonly CategoryView[];
}

/**
 * The stand-in for a product with no photograph.
 *
 * A real file rather than an inline generated gradient. The gradient version
 * looked like artwork the merchant had chosen, so a catalogue with no
 * photography looked finished and nobody fixed it — and it shipped a unique,
 * uncacheable blob of SVG inside the HTML of every tile. This is one asset, one
 * cache entry, and unmistakably a placeholder.
 */
export const PLACEHOLDER_IMAGE = '/product-placeholder.svg';

/**
 * A product's images, in display order, with at least one entry.
 *
 * The single accessor every renderer goes through, so the fallback chain lives
 * in one place: real media rows, then the legacy single `imageUrl`, then the
 * placeholder. Alt text falls back to the product title — an empty alt on a
 * product photograph tells a screen reader the image is decorative, which for
 * the only picture of the thing being sold is a lie.
 */
/**
 * The specification rows for a product, key specs first.
 *
 * One accessor so no call site has to know whether it was handed a database
 * product or a demo one. The demo catalogue supplies only the flat `specs` map,
 * which carries no notion of a headline spec, so everything from it sorts as an
 * ordinary row and keeps its insertion order.
 *
 * Key specs lead because `attributes.isKeySpec` exists to mark the handful a
 * shopper compares on. The schema describes it as feeding a collapsed summary;
 * until that component exists, ordering is the honest use of the flag rather
 * than leaving it modelled and ignored.
 */
export function specsOf(product: ProductView): readonly ProductSpec[] {
  const details =
    product.specDetails ??
    Object.entries(product.specs).map(([label, value]) => ({
      key: label,
      label,
      value,
      isKeySpec: false,
    }));

  // Stable: `sort` keeps equal elements in their existing order, which is
  // `attributes.position` from the query, so this promotes the key specs
  // without disturbing the ordering the merchant configured within each group.
  return [...details].sort((a, b) => Number(b.isKeySpec) - Number(a.isKeySpec));
}

export function imagesOf(product: ProductView): readonly ProductImageView[] {
  const images =
    product.images && product.images.length > 0
      ? product.images
      : [{ url: product.imageUrl || PLACEHOLDER_IMAGE, alt: product.imageAlt }];

  // The title fallback is applied here rather than at hydration so it picks up
  // the *localised* title: an Arabic page should not describe its images in
  // English because that is the language the row was written in.
  return images.map((image) => ({ ...image, alt: image.alt || product.title }));
}

/**
 * Resolves a product's fields for a locale, falling back to the base values.
 *
 * A half-translated catalogue should read as partly English, not as a page
 * with empty headings. Falling back per-field rather than per-product means a
 * product with an Arabic title but no Arabic description shows the Arabic
 * title.
 */
/**
 * The same idea for a category, and the reason the nav was English in Arabic.
 *
 * `translations` was selected from the database and typed `unknown`, so every
 * call site quietly ignored it: an Arabic shopper got "Smartphones" in the
 * header, the footer, the breadcrumbs and the page title, while the product
 * tiles beneath them were correctly Arabic.
 */
export function localiseCategory<T extends CategoryView>(category: T, locale: string): T {
  const overrides = category.translations?.[locale];
  if (!overrides) return category;

  // Field-by-field, like `localise` above: a category with an Arabic name but
  // no Arabic meta description keeps the Arabic name.
  // Only keys the translation actually supplies are patched on, so an empty
  // `{ "ar-AE": {} }` cannot blank a name that exists.
  const patch: CategoryLocaleOverrides = {
    ...(overrides.name ? { name: overrides.name } : {}),
    ...(overrides.description ? { description: overrides.description } : {}),
    ...(overrides.metaTitle ? { metaTitle: overrides.metaTitle } : {}),
    ...(overrides.metaDescription ? { metaDescription: overrides.metaDescription } : {}),
  };
  return { ...category, ...patch } as T;
}

export function localise(product: ProductView, locale: string): ProductView {
  const overrides = product.translations?.[locale];
  if (!overrides) return product;

  return {
    ...product,
    title: overrides.title ?? product.title,
    ...(overrides.subtitle ?? product.subtitle
      ? { subtitle: overrides.subtitle ?? product.subtitle }
      : {}),
    description: overrides.description ?? product.description,
    highlights: overrides.highlights ?? product.highlights,
  };
}
