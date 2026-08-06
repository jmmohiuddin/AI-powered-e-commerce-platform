'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { signIn, type LoginState } from './actions';

/**
 * The only client component in the auth flow.
 *
 * It exists for two things a server render cannot do: restore the typed email
 * after a failed attempt, and disable the button while the request is in
 * flight. The second matters more than it looks — Argon2 verification takes a
 * deliberate ~250 ms, and a form that appears inert for a quarter of a second
 * gets double-submitted.
 */
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="auth__submit" disabled={pending}>
      {pending ? 'Signing in…' : 'Sign in'}
    </button>
  );
}

export function LoginForm({ next }: { next: string }) {
  const [state, formAction] = useActionState<LoginState, FormData>(signIn, {});

  return (
    <form action={formAction} className="auth__form" noValidate>
      <input type="hidden" name="next" value={next} />

      {state.error ? (
        // `role="alert"` so a screen reader announces the failure without the
        // user having to hunt for what changed. `aria-live` on an empty node
        // that later fills is unreliable across readers; a node that appears
        // already carrying role=alert is not.
        <p className="auth__error" role="alert">
          {state.error}
        </p>
      ) : null}

      <label className="auth__field">
        <span>Email</span>
        <input
          name="email"
          type="email"
          defaultValue={state.email ?? ''}
          // `key` forces React to remount the input when the echoed value
          // changes. Without it, `defaultValue` is ignored on re-render — it
          // only applies at mount — and the field stays stubbornly empty.
          key={state.email ?? ''}
          autoComplete="username"
          required
          autoFocus
          spellCheck={false}
          // Staff type their address on phones in a warehouse. Autocapitalise
          // turns "amal@" into "Amal@" and the lookup is lowercased anyway, but
          // the visible mismatch reads as a typo and costs a retry.
          autoCapitalize="none"
        />
      </label>

      <label className="auth__field">
        <span>Password</span>
        <input name="password" type="password" autoComplete="current-password" required />
      </label>

      <SubmitButton />
    </form>
  );
}
