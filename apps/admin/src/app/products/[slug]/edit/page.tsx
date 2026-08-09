import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePermission } from '../../../../lib/auth';
import { getProductDetail } from '../../../../lib/catalogue-queries';
import { catalogueOptions } from '../../actions';
import { ProductForm } from '../../product-form';

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
          brandId: product.brandId,
          categoryId: product.categoryId,
          condition: product.condition,
          warrantyMonths: product.warrantyMonths,
        }}
      />
    </>
  );
}
