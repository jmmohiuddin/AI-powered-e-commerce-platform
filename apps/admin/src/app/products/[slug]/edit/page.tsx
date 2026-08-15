import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePermission } from '../../../../lib/auth';
import { getProductDetail } from '../../../../lib/catalogue-queries';
import { catalogueOptions } from '../../actions';
import { ProductForm } from '../../product-form';
import { ProductMedia } from '../product-media';

export const metadata: Metadata = { title: 'Edit product' };
export const dynamic = 'force-dynamic';

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const session = await requirePermission('product:write');
  const { slug } = await params;

  const [product, options] = await Promise.all([
    getProductDetail(session.tenantId, slug),
    catalogueOptions(),
  ]);
  if (!product) notFound();

  // Root-relative media paths resolve against the storefront, not the admin.
  const storefront = (process.env.STOREFRONT_URL || 'http://localhost:3000').replace(/\/$/, '');

  return (
    <>
      <div className="page-head">
        <div>
          <p className="crumb">
            <Link href={`/products/${product.slug}`}>← {product.title}</Link>
          </p>
          <h1>Edit details</h1>
          {/* Says plainly what this form does *not* touch, so nobody hunts for
              a price field that deliberately is not here. */}
          <p>
            Price, cost and stock are changed on the product page — each is recorded separately.
          </p>
        </div>
      </div>

      <ProductForm
        mode="edit"
        options={options}
        values={{
          id: product.id,
          slug: product.slug,
          title: product.title,
          subtitle: product.subtitle,
          description: product.description,
          highlights: product.highlights,
          translations: product.translations,
          brandId: product.brandId,
          categoryId: product.categoryId,
          condition: product.condition,
          warrantyMonths: product.warrantyMonths,
        }}
      />

      {/* The same manager as the product page. Images are not part of the
          details form's save — each upload, reorder and deletion is its own
          committed action — so it sits outside the form rather than inside it,
          where a Cancel button would imply it could undo them. */}
      <h2 className="section-title">Images</h2>
      <div className="card">
        <ProductMedia
          productId={product.id}
          slug={product.slug}
          images={[...product.images]}
          canWrite
          storefrontOrigin={storefront}
        />
      </div>
    </>
  );
}
