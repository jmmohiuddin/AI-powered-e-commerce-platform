import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatPrice } from '@voltix/ui';
import { can, requirePermission } from '../../../lib/auth';
import { getProductDetail } from '../../../lib/catalogue-queries';
import { ProductControls, StockAdjuster } from './product-controls';
import { ProductMedia } from './product-media';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Product · ${slug}` };
}

/**
 * Product detail: the variant table is the point.
 *
 * A product is a marketing object; a *variant* is what has a price, a cost, a
 * SKU and a stock count, and every operational question is asked at that level.
 * So the page leads with the per-variant grid rather than the description copy.
 *
 * Margin is shown per variant and is null where cost is unknown — the same rule
 * as the inventory screen. A blank is honest; a computed 100% margin against a
 * missing cost is a number someone would price against.
 */
export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const session = await requirePermission('product:read');
  const { slug } = await params;

  const product = await getProductDetail(session.tenantId, slug);
  if (!product) notFound();

  const [canWrite, canAdjust] = await Promise.all([can('product:write'), can('inventory:adjust')]);
  const storefront = (process.env.STOREFRONT_URL || 'http://localhost:3000').replace(/\/$/, '');
  const totalOnHand = product.variants.reduce((sum, v) => sum + v.onHand, 0);
  const totalReserved = product.variants.reduce((sum, v) => sum + v.reserved, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <p className="crumb">
            <Link href="/products">← Products</Link>
          </p>
          <h1>{product.title}</h1>
          <p>
            {[product.brandName, product.categoryName].filter(Boolean).join(' · ') || '—'}
            {product.subtitle ? ` · ${product.subtitle}` : ''}
          </p>
        </div>
        <div className="page-head__status">
          <span
            className={`pill ${
              product.status === 'active'
                ? 'pill--success'
                : product.status === 'draft'
                  ? 'pill--warn'
                  : 'pill--neutral'
            }`}
          >
            {product.status}
          </span>
          <span className="pill pill--neutral">{product.condition.replace(/_/g, ' ')}</span>
        </div>
      </div>

      <ProductControls
        productId={product.id}
        slug={product.slug}
        status={product.status}
        canWrite={canWrite}
      />

      <div className="kpi-grid">
        <div className="card">
          <p className="kpi__label">In stock</p>
          <p className="kpi__value">{totalOnHand}</p>
          <p className="kpi__note">
            {totalReserved > 0 ? `${totalReserved} reserved for open carts` : 'none reserved'}
          </p>
        </div>
        <div className="card">
          <p className="kpi__label">Sold (30 days)</p>
          <p className="kpi__value">{product.sold30d}</p>
          <p className="kpi__note">across all variants</p>
        </div>
        <div className="card">
          <p className="kpi__label">Rating</p>
          <p className="kpi__value">
            {product.ratingAverage === null ? '—' : product.ratingAverage.toFixed(1)}
          </p>
          <p className="kpi__note">
            {product.ratingCount} {product.ratingCount === 1 ? 'review' : 'reviews'}
          </p>
        </div>
        <div className="card">
          <p className="kpi__label">Warranty</p>
          <p className="kpi__value">
            {product.warrantyMonths ? `${product.warrantyMonths}m` : '—'}
          </p>
          <p className="kpi__note">manufacturer UAE cover</p>
        </div>
      </div>

      {/* Above the variant table on purpose. A product with no photograph does
          not sell however correct its pricing is, so the gap should be the
          first thing a merchant sees on the page. */}
      <h2 className="section-title">Images</h2>
      <div className="card">
        <ProductMedia
          productId={product.id}
          slug={product.slug}
          images={[...product.images]}
          canWrite={canWrite}
          storefrontOrigin={storefront}
        />
      </div>

      <h2 className="section-title">Variants</h2>
      <div className="card table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Option</th>
              <th className="numeric">Price</th>
              <th className="numeric">Cost</th>
              <th className="numeric">Margin</th>
              <th className="numeric">On hand</th>
              <th className="numeric">Reserved</th>
              <th className="numeric">Incoming</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {product.variants.map((v) => (
              <tr key={v.id}>
                <td>
                  <span className="cell-title">{v.sku}</span>
                  {!v.isActive && <div className="kpi__note">inactive</div>}
                </td>
                <td>{v.title}</td>
                <td className="numeric">{formatPrice(v.price, v.currency)}</td>
                <td className="numeric">
                  {v.costPrice === null ? (
                    <span className="muted">—</span>
                  ) : (
                    formatPrice(v.costPrice, v.currency)
                  )}
                </td>
                <td className="numeric">
                  {v.marginBps === null ? (
                    <span className="muted">—</span>
                  ) : (
                    `${(v.marginBps / 100).toFixed(1)}%`
                  )}
                </td>
                <td className="numeric">
                  <span
                    className={`pill ${
                      v.onHand <= 0 ? 'pill--danger' : v.onHand <= 5 ? 'pill--warn' : 'pill--neutral'
                    }`}
                  >
                    {v.onHand}
                  </span>
                </td>
                <td className="numeric">{v.reserved || '—'}</td>
                <td className="numeric">{v.incoming || '—'}</td>
                <td>
                  <StockAdjuster
                    variantId={v.id}
                    sku={v.sku}
                    slug={product.slug}
                    canAdjust={canAdjust}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {product.description && (
        <>
          <h2 className="section-title">Description</h2>
          <div className="card">
            <p className="muted">{product.description}</p>
          </div>
        </>
      )}

      <p style={{ marginTop: 'var(--space-5)' }} className="muted">
        {product.status === 'active' ? (
          <>
            Live at{' '}
            <a href={`${storefront}/products/${product.slug}`} target="_blank" rel="noopener noreferrer">
              {storefront}/products/{product.slug}
            </a>
          </>
        ) : (
          // Saying why it is not linked beats a dead link to a 404.
          <>Not published — this product is {product.status} and not visible on the storefront.</>
        )}
      </p>
    </>
  );
}
