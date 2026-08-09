'use client';

import { useState, useTransition } from 'react';
import { createProductAction, updateProductAction, type ActionResult } from './actions';

export interface CatalogueOptions {
  brands: { id: string; name: string }[];
  categories: { id: string; name: string }[];
}

export interface ProductFormValues {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  brandId: string | null;
  categoryId: string | null;
  condition: string;
  warrantyMonths: number | null;
}

/**
 * One form for both create and edit.
 *
 * Two shapes of the same object would drift — a field added to create and
 * forgotten on edit is the classic version of this bug, and it shows up as
 * "I can set it when I add a product but not afterwards". The only difference
 * between the modes is the variant block, which exists solely at creation
 * because afterwards price and stock are edited through their own actions with
 * their own ledger consequences.
 */
export function ProductForm({
  mode,
  options,
  values,
}: {
  mode: 'create' | 'edit';
  options: CatalogueOptions;
  values?: ProductFormValues;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const r =
        mode === 'create'
          ? await createProductAction(formData)
          : await updateProductAction(values!.id, values!.slug, formData);
      // createProductAction redirects on success, so anything returned here is
      // a failure. Edit returns a result either way.
      setResult(r);
    });
  };

  return (
    <form action={onSubmit} className="stack-md">
      {result && !result.ok && (
        <p className="actions__result is-error" role="alert">
          {result.error}
        </p>
      )}
      {result?.ok && result.message && (
        <p className="actions__result is-ok" role="status">
          {result.message}
        </p>
      )}

      <section className="card stack-md">
        <h2 className="section-title section-title--flush">Details</h2>

        <label className="field">
          <span>Title *</span>
          <input
            name="title"
            required
            maxLength={200}
            defaultValue={values?.title ?? ''}
            placeholder="Samsung Galaxy S25 Ultra"
            autoFocus={mode === 'create'}
          />
        </label>

        <label className="field">
          <span>Subtitle</span>
          <input
            name="subtitle"
            maxLength={200}
            defaultValue={values?.subtitle ?? ''}
            placeholder='6.9" QHD+ · 200MP · Snapdragon 8 Elite'
          />
        </label>

        <label className="field">
          <span>Description</span>
          <textarea
            name="description"
            rows={4}
            defaultValue={values?.description ?? ''}
            placeholder="What it is, who it suits, and what is in the box."
          />
        </label>

        <div className="field-row">
          <label className="field">
            <span>Brand</span>
            <select name="brandId" defaultValue={values?.brandId ?? ''}>
              <option value="">No brand</option>
              {options.brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Category</span>
            <select name="categoryId" defaultValue={values?.categoryId ?? ''}>
              <option value="">Uncategorised</option>
              {options.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="field-row">
          <label className="field">
            <span>Condition</span>
            <select name="condition" defaultValue={values?.condition ?? 'new'}>
              {['new', 'refurbished', 'open_box', 'used'].map((c) => (
                <option key={c} value={c}>
                  {c.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Warranty (months)</span>
            <input
              name="warrantyMonths"
              type="number"
              min={0}
              max={120}
              defaultValue={values?.warrantyMonths ?? ''}
              placeholder="12"
            />
          </label>
        </div>
      </section>

      {mode === 'create' && (
        <section className="card stack-md">
          <h2 className="section-title section-title--flush">First variant</h2>
          <p className="muted">
            Price and stock live on the variant. You can add more variants after saving.
          </p>

          <div className="field-row">
            <label className="field">
              <span>SKU *</span>
              <input
                name="sku"
                required
                maxLength={64}
                placeholder="SAM-S25U-256-TG"
                autoComplete="off"
              />
            </label>

            <label className="field">
              <span>Variant name *</span>
              <input name="variantTitle" required defaultValue="Default" placeholder="256GB · Grey" />
            </label>
          </div>

          <div className="field-row">
            <label className="field">
              {/* VAT-inclusive, stated on the label rather than in a tooltip —
                  UAE consumer prices are displayed inclusive, and a merchant
                  entering the ex-VAT figure here would underprice everything. */}
              <span>Price (AED, incl. VAT) *</span>
              <input
                name="price"
                required
                type="number"
                step="0.01"
                min="0"
                placeholder="4699.00"
                inputMode="decimal"
              />
            </label>

            <label className="field">
              <span>Cost (AED)</span>
              <input
                name="costPrice"
                type="number"
                step="0.01"
                min="0"
                placeholder="4280.00"
                inputMode="decimal"
              />
            </label>

            <label className="field">
              <span>Opening stock</span>
              <input name="onHand" type="number" min="0" defaultValue="0" inputMode="numeric" />
            </label>
          </div>
        </section>
      )}

      <div className="actions__row">
        <button type="submit" className="btn btn--primary" disabled={pending}>
          {pending ? 'Saving…' : mode === 'create' ? 'Create draft' : 'Save changes'}
        </button>
        <a className="btn" href={mode === 'create' ? '/products' : `/products/${values?.slug}`}>
          Cancel
        </a>
      </div>
    </form>
  );
}
