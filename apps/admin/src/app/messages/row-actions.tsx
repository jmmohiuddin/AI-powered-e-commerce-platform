'use client';

import { useState, useTransition } from 'react';
import {
  approveDraftAction,
  discardDraftAction,
  resendFailedAction,
  type MessageActionResult,
} from './actions';

/**
 * Approve / discard for drafts, resend for failures.
 *
 * Approve is one click with no confirmation dialog — the review IS the
 * confirmation. The whole card above this button is the message, read in full;
 * a second "are you sure?" teaches people to click through both without
 * reading either.
 */
export function MessageRowActions({ id, kind }: { id: string; kind: 'draft' | 'failed' }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (fn: (id: string) => Promise<MessageActionResult>) => {
    startTransition(async () => {
      const result = await fn(id);
      setError(result.ok ? null : (result.error ?? 'Something went wrong.'));
    });
  };

  return (
    <div className="actions__row">
      {error && (
        <p className="message__error" role="alert">
          {error}
        </p>
      )}
      {kind === 'draft' ? (
        <>
          <button
            type="button"
            className="btn btn--primary"
            disabled={pending}
            onClick={() => run(approveDraftAction)}
          >
            {pending ? 'Working…' : 'Approve and send'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={pending}
            onClick={() => run(discardDraftAction)}
          >
            Discard
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn"
          disabled={pending}
          onClick={() => run(resendFailedAction)}
        >
          {pending ? 'Working…' : 'Try again'}
        </button>
      )}
    </div>
  );
}
