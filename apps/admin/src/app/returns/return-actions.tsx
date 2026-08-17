'use client';

import { useState, useTransition } from 'react';
import {
  approveReturn,
  cancelReturn,
  completeReturn,
  inspectReturn,
  markReceived,
  rejectReturn,
  type ReturnActionResult,
} from './actions';

/**
 * One row's worth of controls.
 *
 * Which buttons appear follows the same transition table the server enforces,
 * so a button is present exactly when pressing it will work. The inspection
 * step is the one that expands into a form, because it is the only step that
 * captures a decision rather than just acknowledging a fact — and that decision
 * (resellable or not) is what keeps damaged goods off the shelf.
 */
export function ReturnActions({
  id,
  status,
  resolution,
}: {
  id: string;
  status: string;
  resolution: string;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ReturnActionResult | null>(null);
  const [inspecting, setInspecting] = useState(false);

  const run = (fn: () => Promise<ReturnActionResult>) => {
    startTransition(async () => {
      setResult(await fn());
      setInspecting(false);
    });
  };

  const buttons: Array<{ label: string; onClick: () => void; tone?: string }> = [];

  if (status === 'requested') {
    buttons.push({ label: 'Approve', onClick: () => run(() => approveReturn(id)), tone: 'btn--primary' });
    buttons.push({ label: 'Reject', onClick: () => run(() => rejectReturn(id)), tone: 'btn--danger' });
  }
  if (status === 'approved' || status === 'in_transit') {
    buttons.push({
      label: 'Mark received',
      onClick: () => run(() => markReceived(id)),
      tone: 'btn--primary',
    });
  }
  if (status === 'received') {
    buttons.push({ label: 'Inspect', onClick: () => setInspecting(true), tone: 'btn--primary' });
  }
  if (status === 'inspected') {
    buttons.push({
      label: resolution === 'refund' ? 'Complete and refund' : 'Complete',
      onClick: () => run(() => completeReturn(id)),
      tone: 'btn--primary',
    });
    buttons.push({ label: 'Reject', onClick: () => run(() => rejectReturn(id)), tone: 'btn--danger' });
  }
  if (['approved', 'in_transit', 'received'].includes(status)) {
    buttons.push({ label: 'Cancel', onClick: () => run(() => cancelReturn(id)) });
  }

  return (
    <div className="actions actions--bare">
      {result && (
        <p className={`actions__result ${result.ok ? 'is-ok' : 'is-error'}`} role="status">
          {result.ok ? result.message : result.error}
        </p>
      )}

      {buttons.length > 0 && !inspecting && (
        <div className="actions__row">
          {buttons.map((b) => (
            <button
              key={b.label}
              type="button"
              className={`btn ${b.tone ?? ''}`}
              disabled={pending}
              onClick={b.onClick}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}

      {buttons.length === 0 && !inspecting && (
        <p className="muted">No action needed — this return is {status.replace(/_/g, ' ')}.</p>
      )}

      {inspecting && (
        <form className="actions__confirm" action={(fd) => run(() => inspectReturn(id, fd))}>
          <label>
            <span>What arrived?</span>
            <input
              name="note"
              required
              autoFocus
              maxLength={500}
              placeholder="Unopened, all accessories present"
            />
          </label>
          <div className="actions__row">
            {/* Two explicit buttons rather than a checkbox that defaults to
                one answer. Restocking a damaged unit is the expensive
                mistake, so neither outcome is the path of least resistance. */}
            <button
              type="submit"
              name="restockable"
              value="yes"
              className="btn btn--primary"
              disabled={pending}
            >
              Good — restock it
            </button>
            <button
              type="submit"
              name="restockable"
              value="no"
              className="btn btn--danger"
              disabled={pending}
            >
              Damaged — do not restock
            </button>
            <button type="button" className="btn" onClick={() => setInspecting(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
