import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePermission } from '../../../lib/auth';
import { catalogueOptions } from '../actions';
import { ProductForm } from '../product-form';

export const metadata: Metadata = { title: 'New product' };
export const dynamic = 'force-dynamic';

/**
 * Create a product.
 *
 * The form asks for one variant alongside the product, because price and stock
 * live on the variant and a product without one cannot be sold or counted.
 * Making it optional would only move the empty case into every screen that has
 * to render it — and into the merchant's first confused support message.
 */
export default async function NewProductPage() {
  await requirePermission('product:write');
  const options = await catalogueOptions();

  return (
    <>
      <div className="page-head">
        <div>
          <p className="crumb">
            <Link href="/products">← Products</Link>
          </p>
          <h1>New product</h1>
          <p>Saved as a draft. Nothing appears on the storefront until you publish it.</p>
        </div>
      </div>

      <ProductForm mode="create" options={options} />
    </>
  );
}
