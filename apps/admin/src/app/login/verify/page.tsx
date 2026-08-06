import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { dbAdmin } from '@voltix/db';
import { beginEnrolment, hasMfaEnrolled, resolveSession, SESSION_COOKIE } from '@voltix/auth';
import { EnrolForm, VerifyForm } from './forms';

export const metadata: Metadata = { title: 'Verify', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/**
 * One route serves both the challenge and first-time enrolment.
 *
 * Splitting them would mean the user has to know which state they are in, and
 * they demonstrably do not — "it's asking for a code and I've never set this
 * up" is the single most common MFA support ticket. The page decides.
 */
export default async function VerifyPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect('/login');

  const session = await dbAdmin().transaction((tx) => resolveSession(tx, token));
  if (!session) redirect('/login');

  // Already satisfied — nothing to do here. Without this check, a user who
  // reloads after verifying sits on a challenge page for a factor they have
  // already cleared.
  if (session.mfaSatisfied) redirect('/');

  const enrolled = await dbAdmin().transaction((tx) => hasMfaEnrolled(tx, session.userId));

  if (enrolled) {
    return (
      <div className="auth">
        <div className="auth__brand">
          volt<span>ix</span>
        </div>
        <h1>Two-factor verification</h1>
        <p className="auth__lede">
          Your role can move money, so it needs a second factor. Open your authenticator app.
        </p>
        <VerifyForm />
        <p className="auth__foot">
          Lost your phone? Enter one of the recovery codes you saved during setup — each works once.
        </p>
      </div>
    );
  }

  const challenge = beginEnrolment(session.email);
  // Rendered server-side as an inline SVG string. No image request, no external
  // QR service — sending a TOTP secret to a third-party chart API is a real and
  // surprisingly common way to leak the entire second factor.
  const qr = await QRCode.toString(challenge.uri, {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
  });

  return (
    <div className="auth">
      <div className="auth__brand">
        volt<span>ix</span>
      </div>
      <h1>Set up two-factor authentication</h1>
      <p className="auth__lede">
        Your role — {session.roleName} — can issue refunds and read customer data, so a password
        alone is not enough.
      </p>
      <EnrolForm secret={challenge.secret} qrSvg={qr} />
    </div>
  );
}
