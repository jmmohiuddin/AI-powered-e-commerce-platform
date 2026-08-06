import type { Metadata } from 'next';
import { LoginForm } from './login-form';

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
};

/**
 * A login page must never be statically rendered or cached: the response varies
 * per request (the `next` parameter) and a cached auth surface is how one
 * user's redirect target ends up on another user's screen.
 */
export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <div className="auth">
      <div className="auth__brand">
        volt<span>ix</span>
      </div>
      <h1>Sign in to your store</h1>
      <p className="auth__lede">Staff access only. Every action here is recorded.</p>

      <LoginForm next={next ?? '/'} />

      <p className="auth__foot">
        Locked out? Ask an owner to reset your access — there is no self-service
        reset, because an email-based reset on an account that can issue refunds
        moves the whole security question into your inbox.
      </p>
    </div>
  );
}
