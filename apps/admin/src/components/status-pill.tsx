import type { FulfilmentStatus, OrderStatus, PaymentStatus } from '@voltix/core';

/**
 * Status badges with one rule: colour follows *whether a human must act*, not
 * the alphabetical position of the enum value.
 *
 * So `refunded` is neutral grey — a completed, correct outcome — while `failed`
 * and `unpaid` are the two that pull the eye, because those are the ones
 * costing money right now. A dashboard that paints every non-happy state red
 * trains people to ignore red.
 */
type Tone = 'neutral' | 'success' | 'warn' | 'danger' | 'info';

const PAYMENT: Record<PaymentStatus, Tone> = {
  unpaid: 'warn',
  authorised: 'info',
  partially_paid: 'warn',
  paid: 'success',
  partially_refunded: 'neutral',
  refunded: 'neutral',
  failed: 'danger',
};

const FULFILMENT: Record<FulfilmentStatus, Tone> = {
  unfulfilled: 'warn',
  partially_fulfilled: 'info',
  fulfilled: 'success',
  partially_returned: 'neutral',
  returned: 'neutral',
};

const LIFECYCLE: Record<OrderStatus, Tone> = {
  pending: 'warn',
  confirmed: 'info',
  processing: 'info',
  completed: 'success',
  cancelled: 'neutral',
};

export function StatusPill({
  kind,
  value,
}: {
  kind: 'payment' | 'fulfilment' | 'lifecycle';
  value: string;
}) {
  const map = kind === 'payment' ? PAYMENT : kind === 'fulfilment' ? FULFILMENT : LIFECYCLE;
  // Falls back to neutral rather than crashing if the database ever holds a
  // value this build does not know about — which happens for exactly as long as
  // a rolling deploy takes, and should not white-screen the order list.
  const tone = (map as Record<string, Tone>)[value] ?? 'neutral';
  return <span className={`pill pill--${tone}`}>{value.replace(/_/g, ' ')}</span>;
}
