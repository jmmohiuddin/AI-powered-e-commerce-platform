'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { enrol, submitMfaCode, type MfaState } from './actions';

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="auth__submit" disabled={pending}>
      {pending ? 'Checking…' : label}
    </button>
  );
}

/**
 * `inputMode="numeric"` plus `autoComplete="one-time-code"` is the pairing that
 * makes this bearable on a phone: the numeric keypad appears, and iOS offers
 * the code from the notification without a trip to the authenticator app.
 * `pattern` rather than `type="number"` — a number input strips leading zeros,
 * and roughly a tenth of all TOTP codes start with one.
 */
function CodeField({ label = 'Authentication code' }: { label?: string }) {
  return (
    <label className="auth__field">
      <span>{label}</span>
      <input
        name="code"
        inputMode="numeric"
        pattern="[0-9A-Za-z-]*"
        autoComplete="one-time-code"
        maxLength={11}
        required
        autoFocus
        className="auth__code"
      />
    </label>
  );
}

export function VerifyForm() {
  const [state, action] = useActionState<MfaState, FormData>(submitMfaCode, {});
  return (
    <form action={action} className="auth__form">
      {state.error ? (
        <p className="auth__error" role="alert">
          {state.error}
        </p>
      ) : null}
      <CodeField />
      <Submit label="Verify" />
    </form>
  );
}

export function EnrolForm({ secret, qrSvg }: { secret: string; qrSvg: string }) {
  const [state, action] = useActionState<MfaState, FormData>(enrol, {});

  if (state.recoveryCodes) {
    return (
      <div className="auth__form">
        <h2 className="auth__subhead">Save your recovery codes</h2>
        <p className="auth__lede">
          These are shown once and never again. Each works a single time, and they are the only way
          back in if you lose your phone. Print them or put them in a password manager now.
        </p>
        <ul className="auth__codes">
          {state.recoveryCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        {/*
          A plain link rather than a button that navigates: the codes must stay
          on screen until the user deliberately leaves, and a form submit here
          risks a double-post re-rendering the page without them.
        */}
        <a className="auth__submit auth__submit--link" href="/">
          I have saved them — continue
        </a>
      </div>
    );
  }

  return (
    <form action={action} className="auth__form">
      {state.error ? (
        <p className="auth__error" role="alert">
          {state.error}
        </p>
      ) : null}

      <ol className="auth__steps">
        <li>Install Google Authenticator, 1Password, or any TOTP app.</li>
        <li>Scan this code.</li>
        <li>Enter the six digits it shows.</li>
      </ol>

      {/*
        The SVG is generated server-side from a URI we constructed, so there is
        no user input in it — but it is still rendered into the DOM as markup,
        so it is worth being explicit that the source is trusted rather than
        leaving a future reader to wonder.
      */}
      <div className="auth__qr" dangerouslySetInnerHTML={{ __html: qrSvg }} />

      <details className="auth__manual">
        <summary>Can&apos;t scan it?</summary>
        <p>Enter this key manually in your authenticator app:</p>
        <code>{secret.replace(/(.{4})/g, '$1 ').trim()}</code>
      </details>

      <input type="hidden" name="secret" value={secret} />
      <CodeField label="Code from your app" />
      <Submit label="Confirm and enable" />
    </form>
  );
}
