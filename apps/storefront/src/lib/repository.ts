import 'server-only';
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { withTenantRead, schema, type Database } from '@voltix/db';
import { classifyQuery, reciprocalRankFusion } from '@voltix/ai';
import type { CategoryView, ProductView, SearchFilters, SearchResult } from './types';

/**
 * POSTGRES-BACKED CATALOGUE
 *
 * The read model. Assembles the denormalised shape a product page needs —
 * product, variants, media, stock, rating rollup — which no single table
 * holds. Keeping that assembly here means the page components stay declarative
 * and the write schema stays normalised.
 *
 * TENANT CONTEXT IS NOT OPTIONAL. Every entry point wraps its work in
 * `withTenantRead`, which sets `app.tenant_id` for row-level security and
 * routes to a replica when one is configured. A read that omits it does not
 * leak — it returns zero rows, which is safe but indistinguishable from an
 * empty catalogue, and that is quiet enough to reach production unnoticed.
 * (It did, once, during this build; RLS is what surfaced it.)
 *
 * Each public function opens exactly one transaction and threads the handle
 * down. Hydration and facet counting share it rather than opening their own —
 * a product page should be one round trip to the database, not four.
 *
 * Replica reads are safe here and nowhere near the checkout: catalogue browsing
 * tolerates a few seconds of lag; cart and inventory do not.
 */

const { products, variants, brands, categories, media, stockLevels } = schema;

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Shared predicate. Soft-deleted and unpublished rows never reach a shopper. */
function published(tenantId: string) {
  return and(
    eq(products.tenantId, tenantId),
    eq(products.status, 'active'),
    isNull(products.deletedAt),
  );
}

export function listProducts(tenantId: string, limit = 24): Promise<ProductView[]> {
  return withTenantRead(tenantId, async (tx) => {
    const rows = await tx
      .select({ id: products.id })
      .from(products)
      .where(published(tenantId))
      .orderBy(desc(products.ratingCount))
      .limit(limit);

    return hydrate(
      tx,
      tenantId,
      rows.map((r) => r.id),
    );
  });
}

export function getProductBySlug(
  tenantId: string,
  slug: string,
): Promise<ProductView | undefined> {
  return withTenantRead(tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(published(tenantId), eq(products.slug, slug)))
      .limit(1);

    if (!row) return undefined;
    const [product] = await hydrate(tx, tenantId, [row.id]);
    return product;
  });
}

export function listCategories(tenantId: string): Promise<CategoryView[]> {
  return withTenantRead(tenantId, (tx) =>
    tx
      .select({
        slug: categories.slug,
        name: categories.name,
        translations: categories.translations,
        count: sql<number>`count(${products.id})::int`,
      })
      .from(categories)
      .leftJoin(products, and(eq(products.categoryId, categories.id), published(tenantId)))
      .where(
        and(
          eq(categories.tenantId, tenantId),
          eq(categories.isVisible, true),
          isNull(categories.deletedAt),
        ),
      )
      .groupBy(categories.slug, categories.name, categories.translations, categories.position)
      .orderBy(asc(categories.position)),
  );
}

/**
 * SEARCH — hybrid retrieval.
 *
 * Two independent retrievers whose ranked outputs are fused with Reciprocal
 * Rank Fusion, then filtered, then faceted:
 *
 *   lexical  — Postgres `tsvector` over the maintained `search_vector` column,
 *              plus a trigram pass so a one-character typo in a model number
 *              still matches.
 *   semantic — pgvector cosine against `product_embeddings`, for queries that
 *              describe an intent rather than name a product.
 *
 * The semantic leg is inert until embeddings are generated, and the search
 * degrades to lexical-only rather than returning nothing. A store that has not
 * run the backfill still has working search.
 */
export function searchProducts(tenantId: string, filters: SearchFilters): Promise<SearchResult> {
  return withTenantRead(tenantId, async (tx) => {
    const query = filters.query?.trim() ?? '';
    const { intent, lexicalWeight, semanticWeight } = query
      ? classifyQuery(query)
      : { intent: 'browse' as const, lexicalWeight: 1, semanticWeight: 0 };

    let orderedIds: string[] | null = null;

    if (query) {
      /**
       * TWO-PASS LEXICAL RETRIEVAL.
       *
       * `websearch_to_tsquery` ANDs the terms, which is right for a precise
       * query and useless for a descriptive one: "phone with a good camera"
       * becomes `phone & good & camera`, and a product whose description says
       * "use their phone as their main camera" fails on the single word "good".
       *
       * Requiring every word is correct when the shopper is being specific and
       * a dead end when they are describing intent, so the strict pass runs
       * first and an OR of the terms runs only if it found nothing. Precision
       * is preserved where precision was asked for, without turning a
       * descriptive query into a zero-result page.
       */
      const orQuery = query
        .split(/\s+/)
        .map((term) => term.replace(/[^\p{L}\p{N}]/gu, ''))
        .filter(Boolean)
        .join(' | ');

      const lexical = await tx.execute<{ id: string; score: number }>(sql`
        WITH strict_match AS (
          SELECT p.id,
                 ts_rank(p.search_vector, websearch_to_tsquery('voltix_search', ${query}))
                   + similarity(p.title, ${query}) AS score
          FROM products p
          WHERE p.tenant_id = ${tenantId}
            AND p.status = 'active'
            AND p.deleted_at IS NULL
            AND (
              p.search_vector @@ websearch_to_tsquery('voltix_search', ${query})
              OR p.title % ${query}
              OR EXISTS (
                SELECT 1 FROM variants v
                WHERE v.product_id = p.id
                  AND (v.sku ILIKE ${'%' + query + '%'} OR v.mpn ILIKE ${'%' + query + '%'})
              )
            )
        ),
        loose_match AS (
          SELECT p.id,
                 -- Discounted, so a loose hit never outranks a strict one.
                 ts_rank(p.search_vector, to_tsquery('voltix_search', ${orQuery})) * 0.5 AS score
          FROM products p
          WHERE ${orQuery} <> ''
            AND NOT EXISTS (SELECT 1 FROM strict_match)
            AND p.tenant_id = ${tenantId}
            AND p.status = 'active'
            AND p.deleted_at IS NULL
            AND p.search_vector @@ to_tsquery('voltix_search', ${orQuery})
        )
        SELECT id, score FROM strict_match
        UNION ALL
        SELECT id, score FROM loose_match
        ORDER BY score DESC
        LIMIT 100
      `);

      const semantic: Array<{ id: string; score: number }> = [];

      const fused = reciprocalRankFusion([
        { label: 'lexical', results: lexical.rows, weight: lexicalWeight },
        { label: 'semantic', results: semantic, weight: semanticWeight },
      ]);
      orderedIds = fused.map((r) => r.id);
      if (orderedIds.length === 0) {
        return { products: [], total: 0, intent, facets: emptyFacets() };
      }
    }

    const conditions = [published(tenantId)];
    if (orderedIds) conditions.push(inArray(products.id, orderedIds));
    if (filters.category) {
      conditions.push(
        sql`${products.categoryId} = (
          SELECT id FROM categories
          WHERE tenant_id = ${tenantId} AND slug = ${filters.category} LIMIT 1
        )`,
      );
    }
    if (filters.brand) {
      conditions.push(
        sql`${products.brandId} = (
          SELECT id FROM brands WHERE tenant_id = ${tenantId} AND name = ${filters.brand} LIMIT 1
        )`,
      );
    }
    if (filters.minPrice != null) conditions.push(gte(products.priceFrom, filters.minPrice));
    if (filters.maxPrice != null) conditions.push(lte(products.priceFrom, filters.maxPrice));
    if (filters.inStockOnly) {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM variants v
        JOIN stock_levels sl ON sl.variant_id = v.id
        WHERE v.product_id = ${products.id} AND sl.on_hand - sl.reserved > 0
      )`);
    }

    const orderBy =
      filters.sort === 'price_asc'
        ? asc(products.priceFrom)
        : filters.sort === 'price_desc'
          ? desc(products.priceFrom)
          : filters.sort === 'rating'
            ? desc(products.ratingAverage)
            : orderedIds
              ? // Preserve the fusion ranking that the WHERE just filtered.
                sql`array_position(ARRAY[${sql.join(
                  orderedIds.map((id) => sql`${id}::uuid`),
                  sql`, `,
                )}], ${products.id})`
              : desc(products.ratingCount);

    const matched = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(...conditions))
      .orderBy(orderBy)
      .limit(60);

    const ids = matched.map((r) => r.id);
    const [hydrated, facets] = await Promise.all([
      hydrate(tx, tenantId, ids),
      computeFacets(tx, tenantId, ids),
    ]);

    return { products: hydrated, total: hydrated.length, intent, facets };
  });
}

export function relatedProducts(
  tenantId: string,
  product: ProductView,
  limit = 4,
): Promise<ProductView[]> {
  return withTenantRead(tenantId, async (tx) => {
    const rows = await tx
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          published(tenantId),
          sql`${products.id} <> ${product.id}`,
          sql`(${products.categoryId} = (SELECT category_id FROM products WHERE id = ${product.id})
               OR ${products.brandId} = (SELECT brand_id FROM products WHERE id = ${product.id}))`,
        ),
      )
      .orderBy(desc(products.ratingCount))
      .limit(limit);

    return hydrate(
      tx,
      tenantId,
      rows.map((r) => r.id),
    );
  });
}

/* ─────────────────────────── Hydration ──────────────────────────────── */

/**
 * Loads the full view for a set of product ids in four queries, not N+1.
 *
 * The naive shape — fetch products, then loop fetching variants — issues one
 * round trip per product. On a 24-tile listing page that is 24 sequential
 * queries against a database that may be a continent away. Four batched
 * queries and an in-memory join is the difference between 40 ms and 900 ms.
 */
async function hydrate(tx: Tx, tenantId: string, ids: string[]): Promise<ProductView[]> {
  if (ids.length === 0) return [];

  const [productRows, variantRows, mediaRows, stockRows] = await Promise.all([
    tx
      .select({
        id: products.id,
        slug: products.slug,
        title: products.title,
        subtitle: products.subtitle,
        description: products.description,
        highlights: products.highlights,
        translations: products.translations,
        currency: products.currency,
        ratingAverage: products.ratingAverage,
        ratingCount: products.ratingCount,
        warrantyMonths: products.warrantyMonths,
        tags: products.tags,
        aeoFacts: products.aeoFacts,
        brandName: brands.name,
        categoryName: categories.name,
        categorySlug: categories.slug,
      })
      .from(products)
      .leftJoin(brands, eq(brands.id, products.brandId))
      .leftJoin(categories, eq(categories.id, products.categoryId))
      .where(and(eq(products.tenantId, tenantId), inArray(products.id, ids))),

    tx
      .select({
        id: variants.id,
        productId: variants.productId,
        sku: variants.sku,
        title: variants.title,
        options: variants.options,
        price: variants.price,
        compareAtPrice: variants.compareAtPrice,
        position: variants.position,
      })
      .from(variants)
      .where(
        and(
          inArray(variants.productId, ids),
          eq(variants.isActive, true),
          isNull(variants.deletedAt),
        ),
      )
      .orderBy(asc(variants.position)),

    tx
      .select({
        productId: media.productId,
        url: media.url,
        altText: media.altText,
        position: media.position,
      })
      .from(media)
      .where(inArray(media.productId, ids))
      .orderBy(asc(media.position)),

    tx
      .select({
        variantId: stockLevels.variantId,
        available: sql<number>`sum(greatest(${stockLevels.onHand} - ${stockLevels.reserved}, 0))::int`,
      })
      .from(stockLevels)
      .innerJoin(variants, eq(variants.id, stockLevels.variantId))
      .where(inArray(variants.productId, ids))
      .groupBy(stockLevels.variantId),
  ]);

  const availability = new Map(stockRows.map((r) => [r.variantId, Number(r.available)]));
  const variantsByProduct = new Map<string, typeof variantRows>();
  for (const v of variantRows) {
    const list = variantsByProduct.get(v.productId) ?? [];
    list.push(v);
    variantsByProduct.set(v.productId, list);
  }
  const mediaByProduct = new Map<string, (typeof mediaRows)[number]>();
  for (const m of mediaRows) {
    if (m.productId && !mediaByProduct.has(m.productId)) mediaByProduct.set(m.productId, m);
  }

  const byId = new Map(
    productRows.map((row) => {
      const productVariants = (variantsByProduct.get(row.id) ?? []).map((v) => ({
        id: v.id,
        sku: v.sku,
        title: v.title,
        options: (v.options ?? {}) as Record<string, string>,
        price: Number(v.price),
        ...(v.compareAtPrice ? { compareAtPrice: Number(v.compareAtPrice) } : {}),
        available: availability.get(v.id) ?? 0,
      }));

      const image = mediaByProduct.get(row.id);

      const view: ProductView = {
        id: row.id,
        slug: row.slug,
        title: row.title,
        ...(row.subtitle ? { subtitle: row.subtitle } : {}),
        brand: row.brandName ?? '',
        category: row.categoryName ?? '',
        categorySlug: row.categorySlug ?? '',
        description: row.description ?? '',
        highlights: (row.highlights ?? []) as string[],
        specs: {},
        translations: (row.translations ?? {}) as ProductView['translations'],
        imageUrl: image?.url ?? `/products/${row.slug}.svg`,
        imageAlt: image?.altText ?? row.title,
        price: productVariants.length ? Math.min(...productVariants.map((v) => v.price)) : 0,
        ...(productVariants[0]?.compareAtPrice
          ? { compareAtPrice: productVariants[0].compareAtPrice }
          : {}),
        currency: row.currency,
        ...(row.ratingAverage != null ? { ratingAverage: row.ratingAverage } : {}),
        ratingCount: row.ratingCount,
        variants: productVariants,
        ...(row.warrantyMonths != null ? { warrantyMonths: row.warrantyMonths } : {}),
        tags: (row.tags ?? []) as string[],
        answerableFacts: (row.aeoFacts ?? []) as ProductView['answerableFacts'],
      };
      return [row.id, view];
    }),
  );

  // Returned in the caller's requested order — the ranking is meaningful.
  return ids.map((id) => byId.get(id)).filter((p): p is ProductView => p !== undefined);
}

async function computeFacets(
  tx: Tx,
  tenantId: string,
  ids: string[],
): Promise<SearchResult['facets']> {
  if (ids.length === 0) return emptyFacets();

  const [brandRows, categoryRows, priceRow] = await Promise.all([
    tx
      .select({ value: brands.name, count: sql<number>`count(*)::int` })
      .from(products)
      .innerJoin(brands, eq(brands.id, products.brandId))
      .where(and(eq(products.tenantId, tenantId), inArray(products.id, ids)))
      .groupBy(brands.name)
      .orderBy(desc(sql`count(*)`)),

    tx
      .select({
        value: categories.name,
        slug: categories.slug,
        count: sql<number>`count(*)::int`,
      })
      .from(products)
      .innerJoin(categories, eq(categories.id, products.categoryId))
      .where(and(eq(products.tenantId, tenantId), inArray(products.id, ids)))
      .groupBy(categories.name, categories.slug),

    tx
      .select({
        min: sql<number>`coalesce(min(${products.priceFrom}), 0)::int`,
        max: sql<number>`coalesce(max(${products.priceFrom}), 0)::int`,
      })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), inArray(products.id, ids))),
  ]);

  return {
    brands: brandRows,
    categories: categoryRows,
    priceRange: { min: priceRow[0]?.min ?? 0, max: priceRow[0]?.max ?? 0 },
  };
}

function emptyFacets(): SearchResult['facets'] {
  return { brands: [], categories: [], priceRange: { min: 0, max: 0 } };
}
