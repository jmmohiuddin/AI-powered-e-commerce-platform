import type { Metadata } from 'next';
import Link from 'next/link';
import { formatPrice } from '@voltix/ui';
import { requirePermission } from '../../lib/auth';
import { listProducts } from '../../lib/catalogue-queries';

export const metadata: Metadata = { title: 'Products' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

/**
 * The catalogue, ordered by what a merchant actually scans for.
 *
 * Stock and 30-day sales sit next to each other deliberately: neither number
 * means much alone, and the pair is the whole reordering decision. A product
 * with 2 left and 40 sold is an emergency; 200 left and 0 sold is money sitting
 * on a shelf. Sorting by most-recently-updated rather than alphabetically
 * matches how this screen is used — you come back to what you just touched.
 */
export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; stock?: string; page?: string }>;
}) {
  const session = await requirePermission('product:read');
  const params = await searchParams;

  const page = Math.max(Number(params.page ?? '1') || 1, 1);
  const result = await listProducts(session.tenantId, {
    search: params.q,
    status: params.status,
    stock: params.stock,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const pages = Math.max(Math.ceil(result.total / PAGE_SIZE), 1);
  const filtered = Boolean(params.q || params.status || params.stock);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Products</h1>
          <p>
            {result.total} {result.total === 1 ? 'product' : 'products'}
            {filtered ? ' matching your filters' : ''}
          </p>
        </div>
      </div>

      {/* A plain GET form, like the orders screen: the filtered view gets a
          real URL an operator can bookmark or paste to a colleague. */}
      <form className="filters card" method="get">
        <input
          type="search"
          name="q"
          defaultValue={params.q ?? ''}
          placeholder="Title, slug or SKU"
          aria-label="Search products"
        />
        <select name="status" defaultValue={params.status ?? ''} aria-label="Status">
          <option value="">Any status</option>
          {['draft', 'active', 'archived'].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select name="stock" defaultValue={params.stock ?? ''} aria-label="Stock level">
          <option value="">Any stock</option>
          <option value="out">Out of stock</option>
          <option value="low">Low (1–5)</option>
          <option value="in">In stock (6+)</option>
        </select>
        <button type="submit">Filter</button>
        {filtered && (
          <Link href="/products" className="filters__clear">
            Clear
          </Link>
        )}
      </form>

      {result.rows.length === 0 ? (
        <div className="card">
          <p className="muted">
            {filtered
              ? 'No products match those filters.'
              : 'No products yet. Run npm run db:seed for a sample UAE catalogue.'}
          </p>
        </div>
      ) : (
        <div className="card table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Product</th>
                <th>Status</th>
                <th className="numeric">Variants</th>
                <th className="numeric">In stock</th>
                <th className="numeric">Sold 30d</th>
                <th className="numeric">Price from</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/products/${p.slug}`}>{p.title}</Link>
                    <div className="kpi__note">
                      {[p.brandName, p.categoryName].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </td>
                  <td>
                    <span
                      className={`pill ${
                        p.status === 'active'
                          ? 'pill--success'
                          : p.status === 'draft'
                            ? 'pill--warn'
                            : 'pill--neutral'
                      }`}
                    >
                      {p.status}
                    </span>
                  </td>
                  <td className="numeric">{p.variantCount}</td>
                  <td className="numeric">
                    {/* Zero stock on an *active* product is the actionable
                        case — it is live on the storefront and unbuyable. A
                        draft with no stock is simply unfinished. */}
                    <span
                      className={`pill ${
                        p.onHand <= 0
                          ? p.status === 'active'
                            ? 'pill--danger'
                            : 'pill--neutral'
                          : p.onHand <= 5
                            ? 'pill--warn'
                            : 'pill--neutral'
                      }`}
                    >
                      {p.onHand}
                    </span>
                  </td>
                  <td className="numeric">{p.sold30d || '—'}</td>
                  <td className="numeric">
                    {p.priceFrom === null ? '—' : formatPrice(p.priceFrom, p.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <nav className="pager" aria-label="Pagination">
          <PagerLink page={page - 1} disabled={page <= 1} params={params} label="← Previous" />
          <span>
            Page {page} of {pages}
          </span>
          <PagerLink page={page + 1} disabled={page >= pages} params={params} label="Next →" />
        </nav>
      )}
    </>
  );
}

function PagerLink({
  page,
  disabled,
  params,
  label,
}: {
  page: number;
  disabled: boolean;
  params: Record<string, string | undefined>;
  label: string;
}) {
  if (disabled) {
    return (
      <span className="pager__link pager__link--disabled" aria-disabled="true">
        {label}
      </span>
    );
  }
  // Carry the active filters through, so paging never silently resets a search.
  const query = new URLSearchParams(
    Object.entries(params).filter(([key, value]) => key !== 'page' && value) as [string, string][],
  );
  query.set('page', String(page));
  return (
    <Link className="pager__link" href={`/products?${query.toString()}`}>
      {label}
    </Link>
  );
}
