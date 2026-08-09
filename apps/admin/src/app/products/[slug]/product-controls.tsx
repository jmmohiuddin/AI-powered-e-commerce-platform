'use client';

import { useState, useTransition } from 'react';
import { adjustStockAction, setStatusAction, type ActionResult } from '../actions';

/**
 * Publish/unpublish and per-variant stock adjustment.
 *
 * Publishing is a one-click action because it is reversible and the domain
 * refuses it when the product is not sellable. Stock adjustment demands a
 * reason because "the count changed and nobody knows why" is exactly what makes
 * a stocktake dispute unresolvable — the reason is a required field, not a
 * note someone may skip.
 */
export function ProductControls({
  productId,
  slug,
  status,
  canWrite,
}: {
  productId: string;
  slug: string;
  status: string;
  canWrite: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  if (!canWrite) return null;

  const run = (next: 'draft' | 'active' | 'archived') =>
    startTransition(async () => setResult(await setStatusAction(productId, slug, next)));

  return (
    <div className="actions">
      {result && (
        <p className={`actions__result ${result.ok ? 'is-ok' : 'is-error'}`} role="status">
          {result.ok ? result.message : result.error}
        </p>
      )}
      <div className="actions__row">
        {status !== 'active' && (
          <button
            type="button"
            className="btn btn--primary"
            disabled={pending}
            onClick={() => run('active')}
          >
            Publish
          </button>
        )}
        {status === 'active' && (
          <button type="button" className="btn" disabled={pending} onClick={() => run('draft')}>
            Unpublish
          </button>
        )}
        {status !== 'archived' && (
          <button type="button" className="btn" disabled={pending} onClick={() => run('archived')}>
            Archive
          </button>
        )}
        <a className="btn" href={`/products/${slug}/edit`}>
          Edit details
        </a>
      </div>
    </div>
  );
}

export function StockAdjuster({
  variantId,
  sku,
  slug,
  canAdjust,
}: {
  variantId: string;
  sku: string;
  slug: string;
  canAdjust: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [open, setOpen] = useState(false);

  if (!canAdjust) return null;

  if (!open) {
    return (
      <button type="button" className="btn btn--small" onClick={() => setOpen(true)}>
        Adjust
      </button>
    );
  }

  return (
    <form
      className="stock-adjust"
      action={(formData) =>
        startTransition(async () => {
          const r = await adjustStockAction(variantId, slug, formData);
          setResult(r);
          if (r.ok) setOpen(false);
        })
      }
    >
      <label className="field">
        <span className="sr-only">Units to add or remove for {sku}</span>
        <input
          name="delta"
          type="number"
          required
          autoFocus
          placeholder="+5 or -2"
          inputMode="numeric"
        />
      </label>
      <label className="field">
        <span className="sr-only">Reason</span>
        <select name="reason" defaultValue="stocktake">
          <option value="stocktake">Stocktake</option>
          <option value="purchase_received">Stock received</option>
          <option value="damage">Damaged</option>
          <option value="theft">Lost / stolen</option>
          <option value="manual_adjustment">Other</option>
        </select>
      </label>
      <input name="note" placeholder="Note (optional)" maxLength={200} />
      <button type="submit" className="btn btn--primary btn--small" disabled={pending}>
        {pending ? '…' : 'Save'}
      </button>
      <button type="button" className="btn btn--small" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {result && !result.ok && (
        <p className="actions__result is-error" role="alert">
          {result.error}
        </p>
      )}
    </form>
  );
}
