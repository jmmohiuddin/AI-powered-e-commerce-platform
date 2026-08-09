'use client';

import { useState, useTransition } from 'react';
import {
  addNoteAction,
  cancelOrderAction,
  confirmOrderAction,
  markFulfilledAction,
  recordCodPaymentAction,
  openReturnAction,
  refundOrderAction,
  type ActionResult,
} from './actions';

/**
 * The action bar.
 *
 * Which buttons appear is decided by `availableActions()` on the server — the
 * same state machine that will accept or reject the transition. So a button is
 * present exactly when clicking it will work, rather than being present always
 * and failing sometimes.
 *
 * Cancel is behind a confirmation with a required reason. It is the only
 * destructive action here (it releases stock and cannot be undone), and a
 * single misclick on a row of similar-looking buttons should not be able to do
 * it. Everything else is one click, because friction on safe actions is just
 * friction.
 */
export function OrderActions({
  number,
  actions,
  canCancel,
  canWrite,
  canRefund,
  canManageReturns,
  isCod,
  refundableMinor,
  currency,
}: {
  number: string;
  actions: readonly string[];
  canCancel: boolean;
  canWrite: boolean;
  canRefund: boolean;
  canManageReturns: boolean;
  isCod: boolean;
  /** Paid minus already refunded, in fils. The ceiling the form enforces. */
  refundableMinor: number;
  currency: string;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [returning, setReturning] = useState(false);

  const run = (fn: () => Promise<ActionResult>) => {
    startTransition(async () => {
      const next = await fn();
      setResult(next);
      setConfirming(false);
      // The refund form stays open on failure so the typed reason and amount
      // survive a rejection — retyping both after "issuer declined" is how a
      // stressed operator refunds the wrong number on the second attempt.
      if (next.ok) setRefunding(false);
    });
  };

  const showConfirm = canWrite && actions.includes('confirm');
  // 'create_shipment' is the state machine's name for "there is still
  // something here to send". Until the per-line shipment screen exists, this
  // button fulfils the order in full — named for what it does, not for the
  // action key behind it.
  const showFulfil = canWrite && actions.includes('create_shipment');
  const showCancel = canCancel && actions.includes('cancel');
  // Offered only where money can actually move: a COD order still awaiting
  // payment, and an order with a captured balance left to give back.
  const showCollect = canWrite && isCod && actions.includes('request_payment');
  const showRefund = canRefund && actions.includes('refund') && refundableMinor > 0;
  // `create_return` means the order has fulfilled units that could come back.
  const showReturn = canManageReturns && actions.includes('create_return');
  const refundableLabel = `${(refundableMinor / 100).toFixed(2)} ${currency}`;

  return (
    <div className="actions">
      {result && (
        <p className={`actions__result ${result.ok ? 'is-ok' : 'is-error'}`} role="status">
          {result.ok ? result.message : result.error}
        </p>
      )}

      <div className="actions__row">
        {showConfirm && (
          <button
            type="button"
            className="btn btn--primary"
            disabled={pending}
            onClick={() => run(() => confirmOrderAction(number))}
          >
            Confirm order
          </button>
        )}

        {showFulfil && (
          <button
            type="button"
            className="btn btn--primary"
            disabled={pending}
            onClick={() => run(() => markFulfilledAction(number))}
          >
            Mark fulfilled
          </button>
        )}

        {showCollect && (
          <button
            type="button"
            className="btn"
            disabled={pending}
            onClick={() => run(() => recordCodPaymentAction(number))}
          >
            Record cash collected
          </button>
        )}

        {showRefund && !refunding && (
          <button
            type="button"
            className="btn btn--danger"
            disabled={pending}
            onClick={() => setRefunding(true)}
          >
            Refund…
          </button>
        )}

        {showReturn && !returning && (
          <button
            type="button"
            className="btn"
            disabled={pending}
            onClick={() => setReturning(true)}
          >
            Open return…
          </button>
        )}

        {showCancel && !confirming && (
          <button
            type="button"
            className="btn btn--danger"
            disabled={pending}
            onClick={() => setConfirming(true)}
          >
            Cancel order
          </button>
        )}

        {!showConfirm && !showFulfil && !showCancel && !showCollect && !showRefund && (
          // Explaining the absence beats an empty bar. "Nothing I can do here"
          // and "the buttons failed to load" look identical otherwise, and the
          // second one generates a support ticket.
          <p className="muted">
            No actions available in this state
            {!canWrite && !canCancel ? ' for your role' : ''}.
          </p>
        )}
      </div>

      {refunding && (
        <form
          className="actions__confirm"
          action={(formData) => run(() => refundOrderAction(number, formData))}
        >
          <p>
            <strong>Refunding order #{number}.</strong> Up to {refundableLabel} can be returned.
          </p>
          <label>
            <span>Amount ({currency})</span>
            <input
              name="amount"
              type="number"
              step="0.01"
              min="0.01"
              // The maximum is stated and enforced here as a courtesy, and
              // enforced again server-side against the ledger — a number input
              // is a hint, not a control, and this one gives money away.
              max={(refundableMinor / 100).toFixed(2)}
              defaultValue={(refundableMinor / 100).toFixed(2)}
              autoFocus
              inputMode="decimal"
            />
          </label>
          <label>
            <span>Reason</span>
            <input name="reason" required maxLength={200} placeholder="Item returned, faulty" />
          </label>
          <div className="actions__row">
            <button type="submit" className="btn btn--danger" disabled={pending}>
              {pending ? 'Refunding…' : 'Issue refund'}
            </button>
            <button type="button" className="btn" onClick={() => setRefunding(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {confirming && (
        <form
          className="actions__confirm"
          action={(formData) => run(() => cancelOrderAction(number, formData))}
        >
          <label>
            <span>Why is this being cancelled?</span>
            <input
              name="reason"
              required
              autoFocus
              maxLength={200}
              placeholder="Customer changed their mind"
            />
          </label>
          <div className="actions__row">
            <button type="submit" className="btn btn--danger" disabled={pending}>
              {pending ? 'Cancelling…' : 'Cancel the order and return stock'}
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </div>
        </form>
      )}

      {returning && (
        <form
          className="actions__confirm"
          action={(formData) => run(() => openReturnAction(number, formData))}
        >
          <label>
            <span>Why is it coming back?</span>
            <select name="reason" defaultValue="changed_mind">
              {['damaged', 'defective', 'wrong_item', 'not_as_described', 'changed_mind', 'other'].map(
                (r) => (
                  <option key={r} value={r}>
                    {r.replace(/_/g, ' ')}
                  </option>
                ),
              )}
            </select>
          </label>
          <label>
            <span>What does the customer get?</span>
            <select name="resolution" defaultValue="refund">
              {['refund', 'exchange', 'store_credit', 'repair', 'warranty_replacement'].map((r) => (
                <option key={r} value={r}>
                  {r.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">
            Opens a return for everything still returnable on this order. No money moves and no
            stock changes until it is received and inspected on the Returns screen.
          </p>
          <div className="actions__row">
            <button type="submit" className="btn btn--primary" disabled={pending}>
              {pending ? 'Opening…' : 'Open the return'}
            </button>
            <button type="button" className="btn" onClick={() => setReturning(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <form
        className="actions__note"
        action={(formData) => run(() => addNoteAction(number, formData))}
      >
        <label>
          <span className="sr-only">Internal note</span>
          <input name="note" placeholder="Add an internal note…" maxLength={2000} />
        </label>
        <button type="submit" className="btn" disabled={pending}>
          Add note
        </button>
      </form>
    </div>
  );
}
