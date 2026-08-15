import 'server-only';
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { withTenantRead, schema, type Database } from '@voltix/db';
import { classifyQuery, reciprocalRankFusion } from '@voltix/ai';
import { DEFAULT_PAGE_SIZE, PLACEHOLDER_IMAGE } from './types';
import type {
  CategoryDetail,
  CategoryView,
  ProductSpec,
  ProductView,
  SearchFilters,
  SearchResult,
} from './types';

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

const { products, variants, brands, categories, media, stockLevels, attributes, productAttributeValues } =
  schema;

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

/** Shared predicate. Hidden and soft-deleted categories are not a public surface. */
function visibleCategories(tenantId: string) {
  return and(
    eq(categories.tenantId, tenantId),
    eq(categories.isVisible, true),
    isNull(categories.deletedAt),
  );
}

/**
 * The count a category should show is its *subtree's*, not its own row's.
 *
 * A `LEFT JOIN products ON category_id` counts only products filed directly on
 * the node, so "Mobiles (0) › Smartphones (48)" — the parent looks empty and
 * nobody clicks it. Matching on the materialised path prefix instead counts
 * everything beneath, which is what the number means to a shopper. The
 * `path || '/%'` guard is what stops `/audio` from swallowing `/audiobooks`.
 */
/**
 * The outer column is written out by hand, and it has to be.
 *
 * Interpolating `${categories.path}` emits a BARE `"path"`. Read in the outer
 * query that is unambiguous, so the source looks right — but inside this
 * subquery `JOIN categories descendant` puts a second `path` in scope, and an
 * unqualified name binds to the innermost one. Postgres therefore compared
 * `descendant.path` against itself, which is true for every row, so every
 * category reported the store's entire product count. Five categories, all
 * reading "6 products", on the homepage.
 *
 * It is invisible in review because the defect is in the EMITTED sql, not the
 * sql in the file. Confirmed against Postgres' statement log: the bare form
 * returned 6/6/6/6/6 and the qualified form 1/1/1/2/1.
 */
const OUTER_CATEGORY_PATH = sql.raw('"categories"."path"');

function subtreeCount(tenantId: string) {
  return sql<number>`(
    SELECT count(*)::int FROM products p
    JOIN categories descendant ON descendant.id = p.category_id
    WHERE p.tenant_id = ${tenantId}
      AND p.status = 'active'
      AND p.deleted_at IS NULL
      AND (descendant.path = ${OUTER_CATEGORY_PATH}
           OR descendant.path LIKE ${OUTER_CATEGORY_PATH} || '/%')
  )`;
}

const categorySelection = (tenantId: string) => ({
  slug: categories.slug,
  name: categories.name,
  path: categories.path,
  depth: categories.depth,
  translations: categories.translations,
  count: subtreeCount(tenantId),
});

export function listCategories(tenantId: string): Promise<CategoryView[]> {
  return withTenantRead(tenantId, (tx) =>
    tx
      .select(categorySelection(tenantId))
      .from(categories)
      .where(visibleCategories(tenantId))
      .orderBy(asc(categories.depth), asc(categories.position), asc(categories.name)),
  ) as Promise<CategoryView[]>;
}

/**
 * One category by its materialised path, with the ancestors and children a
 * listing page needs, in three queries rather than a recursive walk.
 *
 * Ancestors come from the path itself: `/mobiles/smartphones` has exactly one
 * ancestor path, `/mobiles`, and they are computable in the application without
 * asking Postgres to recurse. That is the whole point of storing `path`.
 */
export function getCategoryByPath(
  tenantId: string,
  path: string,
): Promise<CategoryDetail | undefined> {
  return withTenantRead(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        ...categorySelection(tenantId),
        id: categories.id,
        description: categories.description,
        metaTitle: categories.metaTitle,
        metaDescription: categories.metaDescription,
      })
      .from(categories)
      .where(and(visibleCategories(tenantId), eq(categories.path, path)))
      .limit(1);

    if (!row) return undefined;

    const ancestorPaths = ancestorPathsOf(path);
    const [ancestors, children] = await Promise.all([
      ancestorPaths.length > 0
        ? tx
            .select(categorySelection(tenantId))
            .from(categories)
            .where(and(visibleCategories(tenantId), inArray(categories.path, ancestorPaths)))
            .orderBy(asc(categories.depth))
        : Promise.resolve([]),

      tx
        .select(categorySelection(tenantId))
        .from(categories)
        .where(and(visibleCategories(tenantId), eq(categories.parentId, row.id)))
        .orderBy(asc(categories.position), asc(categories.name)),
    ]);

    return {
      ...row,
      ...(row.description ? { description: row.description } : {}),
      ...(row.metaTitle ? { metaTitle: row.metaTitle } : {}),
      ...(row.metaDescription ? { metaDescription: row.metaDescription } : {}),
      ancestors,
      children,
    } as CategoryDetail;
  });
}

/** `/a/b/c` → `['/a', '/a/b']`. Root has none. */
function ancestorPathsOf(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  return segments.slice(0, -1).map((_, i) => `/${segments.slice(0, i + 1).join('/')}`);
}

/** Every visible category path, for the sitemap. */
export function listCategoryPaths(tenantId: string): Promise<Array<{ path: string }>> {
  return withTenantRead(tenantId, (tx) =>
    tx
      .select({ path: categories.path })
      .from(categories)
      .where(visibleCategories(tenantId))
      .orderBy(asc(categories.path)),
  );
}

/** Every published product slug, for the sitemap. */
export function listProductSlugs(
  tenantId: string,
): Promise<Array<{ slug: string; updatedAt: Date | null }>> {
  return withTenantRead(tenantId, (tx) =>
    tx
      .select({ slug: products.slug, updatedAt: products.updatedAt })
      .from(products)
      .where(published(tenantId))
      .orderBy(asc(products.slug)),
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
    /**
     * What actually ran, not what was asked for.
     *
     * Set from the retrievers that returned candidates, below. A browse with no
     * query never reaches the retrieval block at all, and 'lexical' is the
     * truthful label for the plain filtered listing it becomes.
     */
    let strategy: SearchResult['strategy'] = 'lexical';

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

      // Empty until the embedding backfill runs, which is why this is measured
      // rather than assumed: every query today is answered lexically, and a
      // report that claimed otherwise would make the eventual switch to real
      // hybrid retrieval unmeasurable.
      strategy =
        semantic.length === 0 ? 'lexical' : lexical.rows.length === 0 ? 'semantic' : 'hybrid';

      const fused = reciprocalRankFusion([
        { label: 'lexical', results: lexical.rows, weight: lexicalWeight },
        { label: 'semantic', results: semantic, weight: semanticWeight },
      ]);
      orderedIds = fused.map((r) => r.id);
      if (orderedIds.length === 0) {
        return {
          products: [],
          total: 0,
          intent,
          strategy,
          facets: emptyFacets(),
          ...pagination(0, 0, 0),
        };
      }
    }

    const conditions = [published(tenantId)];
    if (orderedIds) conditions.push(inArray(products.id, orderedIds));
    if (filters.categoryPath) {
      // Subtree match, so `/mobiles` includes everything filed beneath it. The
      // `|| '/%'` is deliberate: a bare `LIKE path || '%'` would make /audio
      // match /audiobooks.
      conditions.push(
        sql`${products.categoryId} IN (
          SELECT id FROM categories
          WHERE tenant_id = ${tenantId}
            AND (path = ${filters.categoryPath} OR path LIKE ${filters.categoryPath} || '/%')
        )`,
      );
    }
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

    /**
     * The true match count, from its own query.
     *
     * This was `hydrated.length` after a LIMIT, which is self-consistent and
     * wrong: any result set larger than a page reported exactly one page's
     * worth, so "60 products" was what a 400-product category looked like and
     * pagination arithmetic built on it could never offer a second page.
     *
     * One extra count is cheap next to hydration, and it runs in the same
     * transaction on the same snapshot — so the total can never disagree with
     * the rows beside it.
     */
    const totalRows = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(products)
      .where(and(...conditions));

    const total = totalRows[0]?.total ?? 0;
    const { page, pageSize, pageCount } = pagination(total, filters.page, filters.pageSize);

    const matched = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(...conditions))
      .orderBy(orderBy)
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const ids = matched.map((r) => r.id);
    const [hydrated, facets] = await Promise.all([
      hydrate(tx, tenantId, ids),
      // Faceted over the whole match, not this page — a brand filter that only
      // lists the brands visible on page 3 is a filter that hides products.
      computeFacets(tx, tenantId, and(...conditions)),
    ]);

    return { products: hydrated, total, intent, strategy, facets, page, pageSize, pageCount };
  });
}

/** A ceiling on what a crafted `?pageSize=` can ask the database to hydrate. */
const MAX_PAGE_SIZE = 60;

/**
 * Clamps page and size against the real total.
 *
 * Page numbers arrive from the URL, so they are attacker-controlled: `?page=-1`
 * would become a negative OFFSET (a Postgres error) and `?page=99999` a pointless
 * scan. Both resolve to the last real page instead.
 */
function pagination(
  total: number,
  requestedPage = 1,
  requestedSize = DEFAULT_PAGE_SIZE,
): { page: number; pageSize: number; pageCount: number } {
  const pageSize = Math.min(Math.max(Math.trunc(requestedSize) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Math.trunc(requestedPage) || 1, 1), pageCount);
  return { page, pageSize, pageCount };
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
 * Renders one attribute value the way a shopper expects to read it.
 *
 * The value lives in one of three typed columns according to the attribute's
 * declared `type`, and reading the wrong one yields `null` rather than a wrong
 * answer. Two details matter:
 *
 *  - A measurement is its number AND its unit. "Battery: 5,000" is not a
 *    specification, it is a number that raises a question.
 *  - A boolean is "Yes" or "No". Rendering the raw `true` leaks the column type
 *    onto the page.
 *
 * Returns `null` when there is no value to show, so an attribute attached to a
 * product but left blank does not become an empty table row.
 */
function formatSpecValue(row: {
  type: string;
  unit: string | null;
  valueText: string | null;
  valueNumber: number | null;
  valueBoolean: boolean | null;
}): string | null {
  const withUnit = (text: string) => (row.unit ? `${text} ${row.unit}` : text);

  switch (row.type) {
    case 'boolean':
      return row.valueBoolean == null ? null : row.valueBoolean ? 'Yes' : 'No';

    case 'number':
    case 'measurement': {
      if (row.valueNumber == null) return null;
      // Grouped so a battery capacity reads as 5,000 rather than 5000. Fixed to
      // en-AE because this runs at hydration, before a locale is known; the
      // Arabic follow-up will need the number and the unit, not this string.
      return withUnit(new Intl.NumberFormat('en-AE').format(row.valueNumber));
    }

    // text and enum both live in value_text; an enum is a text value the
    // merchant chose from a list rather than typed.
    default: {
      const text = row.valueText?.trim();
      return text ? withUnit(text) : null;
    }
  }
}

/**
 * Loads the full view for a set of product ids in five queries, not N+1.
 *
 * The naive shape — fetch products, then loop fetching variants — issues one
 * round trip per product. On a 24-tile listing page that is 24 sequential
 * queries against a database that may be a continent away. Five batched
 * queries and an in-memory join is the difference between 40 ms and 900 ms.
 *
 * The fifth is the specifications, batched over the whole page's products for
 * the same reason as the other four.
 */
async function hydrate(tx: Tx, tenantId: string, ids: string[]): Promise<ProductView[]> {
  if (ids.length === 0) return [];

  const [productRows, variantRows, mediaRows, stockRows, specRows] = await Promise.all([
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
        width: media.width,
        height: media.height,
        blurDataUrl: media.blurDataUrl,
        position: media.position,
      })
      .from(media)
      // Images only. The table also holds video, 3D models and documents, and a
      // datasheet PDF rendered as the hero shot is a memorable bug.
      .where(and(inArray(media.productId, ids), eq(media.kind, 'image')))
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

    /**
     * Specifications, for every product on the page at once.
     *
     * `product_attribute_values` holds the value and `attributes` holds what it
     * means — the name, the unit, the type that says which value column to
     * read. Ordered by `attributes.position` so the merchant controls the order
     * of the table, with the name as a tiebreak so equal positions do not
     * shuffle between requests.
     */
    tx
      .select({
        productId: productAttributeValues.productId,
        key: attributes.key,
        label: attributes.name,
        type: attributes.type,
        unit: attributes.unit,
        isKeySpec: attributes.isKeySpec,
        valueText: productAttributeValues.valueText,
        valueNumber: productAttributeValues.valueNumber,
        valueBoolean: productAttributeValues.valueBoolean,
      })
      .from(productAttributeValues)
      .innerJoin(attributes, eq(attributes.id, productAttributeValues.attributeId))
      .where(
        and(
          eq(productAttributeValues.tenantId, tenantId),
          inArray(productAttributeValues.productId, ids),
        ),
      )
      .orderBy(asc(attributes.position), asc(attributes.name)),
  ]);

  const availability = new Map(stockRows.map((r) => [r.variantId, Number(r.available)]));
  const variantsByProduct = new Map<string, typeof variantRows>();
  for (const v of variantRows) {
    const list = variantsByProduct.get(v.productId) ?? [];
    list.push(v);
    variantsByProduct.set(v.productId, list);
  }
  /**
   * ALL the images, not just the first.
   *
   * This kept only the leading row, which made a gallery impossible however
   * many photographs a merchant uploaded — the query already returned them and
   * they were dropped on the floor here. Grouping instead costs one map and no
   * extra round trip: the ordering by `position` comes from the query above, so
   * the array is already in display order.
   */
  const mediaByProduct = new Map<string, (typeof mediaRows)[number][]>();
  for (const m of mediaRows) {
    if (!m.productId) continue;
    const list = mediaByProduct.get(m.productId) ?? [];
    list.push(m);
    mediaByProduct.set(m.productId, list);
  }

  // Grouped in `attributes.position` order, which the query already applied.
  // A row whose value is blank is dropped here rather than rendered as an empty
  // cell — an attribute can be attached to a product without being filled in.
  const specsByProduct = new Map<string, ProductSpec[]>();
  for (const row of specRows) {
    const value = formatSpecValue(row);
    if (value === null) continue;
    const list = specsByProduct.get(row.productId) ?? [];
    list.push({ key: row.key, label: row.label, value, isKeySpec: row.isKeySpec });
    specsByProduct.set(row.productId, list);
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

      const specs = specsByProduct.get(row.id) ?? [];

      const images = (mediaByProduct.get(row.id) ?? []).map((m) => ({
        url: m.url,
        // Left empty rather than defaulted to the title here — `imagesOf()`
        // applies that fallback against the *localised* title.
        alt: m.altText ?? '',
        ...(m.width != null ? { width: m.width } : {}),
        ...(m.height != null ? { height: m.height } : {}),
        ...(m.blurDataUrl ? { blurDataUrl: m.blurDataUrl } : {}),
      }));

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
        // Was hardcoded `{}`, so the specification table — the comparison an
        // electronics shopper is actually making — was empty on every page
        // against a real database, and only ever filled for the demo catalogue.
        specs: Object.fromEntries(specs.map((spec) => [spec.label, spec.value])),
        ...(specs.length > 0 ? { specDetails: specs } : {}),
        translations: (row.translations ?? {}) as ProductView['translations'],
        // Was a `/products/<slug>.svg` path that has never existed for any
        // product, so every image-less product pointed at a 404.
        imageUrl: images[0]?.url ?? PLACEHOLDER_IMAGE,
        imageAlt: images[0]?.alt || row.title,
        images,
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

/**
 * Facet counts over the entire match, not the current page.
 *
 * Takes the same predicate the listing was built from rather than the page's
 * ids: counting only what is on screen makes "Samsung (3)" mean "3 on this
 * page", and every brand absent from page 1 vanishes from the filter that
 * exists to find it.
 */
async function computeFacets(
  tx: Tx,
  tenantId: string,
  where: SQL | undefined,
): Promise<SearchResult['facets']> {
  const [brandRows, categoryRows, priceRow] = await Promise.all([
    tx
      .select({ value: brands.name, count: sql<number>`count(*)::int` })
      .from(products)
      .innerJoin(brands, eq(brands.id, products.brandId))
      .where(where)
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
      .where(where)
      .groupBy(categories.name, categories.slug),

    tx
      .select({
        min: sql<number>`coalesce(min(${products.priceFrom}), 0)::int`,
        max: sql<number>`coalesce(max(${products.priceFrom}), 0)::int`,
      })
      .from(products)
      .where(where),
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
