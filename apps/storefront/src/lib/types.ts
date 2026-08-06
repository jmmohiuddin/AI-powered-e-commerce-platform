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
  readonly specs: Readonly<Record<string, string>>;
  /** { "ar-AE": { title, subtitle, … } } — falls back to the base fields. */
  readonly translations?: Readonly<Record<string, LocaleOverrides>>;
  readonly imageUrl: string;
  readonly imageAlt: string;
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
  readonly category?: string;
  readonly brand?: string;
  readonly minPrice?: number;
  readonly maxPrice?: number;
  readonly inStockOnly?: boolean;
  readonly sort?: 'relevance' | 'price_asc' | 'price_desc' | 'rating';
}

export interface SearchResult {
  readonly products: readonly ProductView[];
  readonly facets: {
    readonly brands: ReadonlyArray<{ value: string; count: number }>;
    readonly categories: ReadonlyArray<{ value: string; slug: string; count: number }>;
    readonly priceRange: { min: number; max: number };
  };
  readonly intent: string;
  readonly total: number;
}

export interface CategoryView {
  readonly slug: string;
  readonly name: string;
  readonly count: number;
  readonly translations?: unknown;
}

/**
 * Resolves a product's fields for a locale, falling back to the base values.
 *
 * A half-translated catalogue should read as partly English, not as a page
 * with empty headings. Falling back per-field rather than per-product means a
 * product with an Arabic title but no Arabic description shows the Arabic
 * title.
 */
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
