import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  checkoutReturnState,
  settlePayment,
  type ActorContext,
  type CheckoutReturn,
} from '@voltix/commerce';
import { outcomeFromStatus, type PaymentProviderId } from '@voltix/payments';
import { whatsappHref } from '@/lib/contact';
import { cartSessionToken, inTenant, paymentRegistry, tenantContext } from '@/lib/session';
import { resolveLocale, translator, type Translate } from '@/lib/locale';

/**
 * WHERE A REDIRECT PAYMENT COMES BACK TO.
 *
 * The shopper has been on the gateway's hosted page — 3-D Secure, a wallet PIN,
 * a Tabby instalment plan — and the gateway has sent them here. This page has
 * to answer one question: did the money move?
 *
 * NOT FROM THE URL, EVER. Gateways append their own parameters on the way back
 * (`?ref=`, `?payment_id=`, `?redirect_status=succeeded`) and every one of them
 * is something the shopper can type into their own address bar. A page that
 * reads `redirect_status` and shows a confirmation is a page that hands out
 * free phones. So the order is resolved from the httpOnly cart cookie, and the
 * gateway is *asked* what happened — the same posture the N-Genius adapter
 * takes, where the return is a hint and `fetchStatus` is the truth.
 *
 * This page races the webhook and is expected to. Both end in `settlePayment`,
 * which is idempotent, so whichever arrives first settles the order and the
 * other finds the work already done.
 */

export const metadata: Metadata = {
  title: 'Confirming your payment',
  robots: { index: false, follow: false },
};
export const dynamic = 'force-dynamic';

const RETURN_ACTOR: ActorContext = { type: 'system', label: 'checkout-return' };

export default async function PaymentReturnPage() {
  const locale = await resolveLocale();
  const t = translator(locale);
  const ctx = tenantContext();
  const sessionToken = await cartSessionToken();

  let state = await inTenant((tx) => checkoutReturnState(tx, ctx, sessionToken)).catch(() => null);

  // Still open? Then the webhook has not landed yet, and the shopper is
  // standing here waiting. Ask the gateway directly rather than making them
  // refresh until a callback arrives.
  if (state && outcomeOf(state) === 'pending') {
    await reconcile(state);
    state = await inTenant((tx) => checkoutReturnState(tx, ctx, sessionToken)).catch(() => state);
  }

  const status = state ? outcomeOf(state) : 'unknown';

  // `redirect` throws internally, so it is called after everything else has
  // finished — inside a try, or before an await that can fail, it would be
  // caught and the shopper would sit on a spinner after a successful payment.
  if (state && status === 'succeeded') {
    redirect(
      `/checkout/confirmation/${state.orderNumber}?phone=${encodeURIComponent(state.phone)}`,
    );
  }

  if (status === 'failed' && state) return <Failed t={t} orderNumber={state.orderNumber} />;
  if (status === 'pending' && state) return <Pending t={t} orderNumber={state.orderNumber} />;
  return <Unknown t={t} />;
}

/* ─────────────────────────────── States ─────────────────────────────── */

function Pending({ t, orderNumber }: { t: Translate; orderNumber: string }) {
  return (
    <div className="container container--focused section">
      {/*
        A plain meta refresh rather than a client component that polls. The
        answer arrives from the job queue within seconds, the page has no other
        interactivity, and shipping JavaScript to re-ask a question the server
        can answer on the next render buys nothing.
      */}
      <meta httpEquiv="refresh" content="5" />
      <div className="confirmation">
        <p className="confirmation__badge">{t('return.pendingBadge')}</p>
        <h1 className="page__title">
          {t('return.pendingTitle')}
        </h1>
        <p className="page__intro">
          {t('return.orderLabel')} <strong>#{orderNumber}</strong>
        </p>
        <p>{t('return.pendingBody')}</p>

        <div className="hero__cta">
          <Link className="button button--secondary" href={`/orders?number=${orderNumber}`}>
            {t('nav.trackOrder')}
          </Link>
          <Support t={t} orderNumber={orderNumber} />
        </div>
      </div>
    </div>
  );
}

function Failed({ t, orderNumber }: { t: Translate; orderNumber: string }) {
  return (
    <div className="container container--focused section">
      <div className="confirmation">
        <p className="confirmation__badge">{t('return.failedBadge')}</p>
        <h1 className="page__title">
          {t('return.failedTitle')}
        </h1>
        <p className="page__intro">
          {t('return.orderLabel')} <strong>#{orderNumber}</strong>
        </p>
        {/*
          The basket was put back when the failure was recorded (see
          settlePayment), so this link lands on a full checkout rather than an
          empty one. Nothing was charged.
        */}
        <p>{t('return.failedBody')}</p>

        <div className="hero__cta">
          <Link className="button button--primary" href="/checkout">
            {t('return.retry')}
          </Link>
          <Support t={t} orderNumber={orderNumber} />
        </div>
      </div>
    </div>
  );
}

/**
 * No cart cookie, or no order behind it.
 *
 * Usually a shopper who cleared cookies mid-payment or opened the return link
 * in a different browser. There is no way to identify their order from here and
 * guessing would be worse than saying so, but the money may well have moved —
 * so this points at order tracking and a human rather than at a dead end.
 */
function Unknown({ t }: { t: Translate }) {
  return (
    <div className="container container--focused section">
      <div className="confirmation">
        <h1 className="page__title">
          {t('return.unknownTitle')}
        </h1>
        <p>{t('return.unknownBody')}</p>

        <div className="hero__cta">
          <Link className="button button--secondary" href="/orders">
            {t('nav.trackOrder')}
          </Link>
          <Support t={t} />
        </div>
      </div>
    </div>
  );
}

/**
 * WhatsApp when the store has published a number, the contact page otherwise.
 *
 * `whatsappHref` returns null when no number is configured, which is what keeps
 * a placeholder chat link off a page a shopper reaches when their money may be
 * in limbo — the one moment they are most likely to actually press it.
 *
 * The order number is pre-filled into the message. Someone chasing a stuck
 * payment should not have to find and retype it.
 */
function Support({ t, orderNumber }: { t: Translate; orderNumber?: string }) {
  const href = orderNumber
    ? whatsappHref(t('return.whatsappMessage', { n: orderNumber }))
    : whatsappHref();

  if (!href) {
    return (
      <Link className="button button--secondary" href="/contact">
        {t('return.help')}
      </Link>
    );
  }
  return (
    <a className="button button--whatsapp" href={href}>
      {t('return.help')}
    </a>
  );
}

/* ────────────────────────────── Internals ───────────────────────────── */

/**
 * Where the order stands, read from the ledger rather than the request.
 *
 * `authorised` counts as done for the shopper: the funds are held, the order is
 * confirmed and the warehouse is picking it. Capture happens when it ships.
 */
function outcomeOf(state: CheckoutReturn): 'succeeded' | 'failed' | 'pending' {
  if (state.paymentStatus === 'paid' || state.paymentStatus === 'authorised') return 'succeeded';
  if (state.paymentStatus === 'failed' || state.intentStatus === 'failed') return 'failed';
  return 'pending';
}

/**
 * Asks the gateway what really happened, and settles on the answer.
 *
 * Failure here is not an error the shopper needs to see: the webhook and the
 * reconciliation job both still cover this order, so a gateway that is slow or
 * briefly down leaves them on the "we're confirming" page rather than on an
 * error. Run through the registry so the call shares the circuit breaker that
 * protects checkout from the same gateway.
 */
async function reconcile(state: CheckoutReturn): Promise<void> {
  const { orderId, intentId, provider, providerReference } = state;
  if (!provider || !providerReference || !intentId) return;

  const ctx = tenantContext();
  const registry = paymentRegistry();
  if (!registry.has(provider as PaymentProviderId)) return;

  try {
    const truth = await registry.execute(provider as PaymentProviderId, (gateway) =>
      gateway.fetchStatus(providerReference),
    );
    const outcome = outcomeFromStatus(truth.status, truth.reference, truth.raw);
    if (!outcome || outcome.kind === 'pending') return;

    await inTenant((tx) =>
      settlePayment(tx, ctx, RETURN_ACTOR, { orderId, intentId }, outcome),
    );
  } catch (error) {
    console.error('[checkout/return] could not reconcile with the gateway:', error);
  }
}
