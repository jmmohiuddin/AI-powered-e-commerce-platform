/**
 * ORDER STATE MACHINE
 *
 * Three independent axes — lifecycle, payment, fulfilment — because real orders
 * occupy combinations that a single enum cannot express: paid + partially
 * shipped + partially refunded is an ordinary Tuesday, not an edge case.
 *
 * Every transition is declared here rather than scattered across route handlers.
 * That gives three properties worth the ceremony:
 *   • Illegal transitions fail loudly at the boundary instead of corrupting data.
 *   • The permitted graph is testable in isolation, with no database.
 *   • The admin UI can render exactly the actions that are currently legal,
 *     rather than showing a "Refund" button that will throw when clicked.
 */

export type OrderStatus = 'pending' | 'confirmed' | 'processing' | 'completed' | 'cancelled';

export type PaymentStatus =
  | 'unpaid'
  | 'authorised'
  | 'partially_paid'
  | 'paid'
  | 'partially_refunded'
  | 'refunded'
  | 'failed';

export type FulfilmentStatus =
  | 'unfulfilled'
  | 'partially_fulfilled'
  | 'fulfilled'
  | 'partially_returned'
  | 'returned';

export interface OrderState {
  readonly status: OrderStatus;
  readonly paymentStatus: PaymentStatus;
  readonly fulfilmentStatus: FulfilmentStatus;
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly axis: 'status' | 'paymentStatus' | 'fulfilmentStatus',
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal ${axis} transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['completed', 'cancelled'],
  // Terminal. A completed order that goes wrong becomes a `return`, not a
  // reopened order — otherwise financial history is rewritable.
  completed: [],
  cancelled: [],
};

const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  unpaid: ['authorised', 'partially_paid', 'paid', 'failed'],
  authorised: ['paid', 'failed', 'unpaid'],
  partially_paid: ['paid', 'partially_refunded', 'refunded', 'failed'],
  paid: ['partially_refunded', 'refunded'],
  partially_refunded: ['refunded', 'partially_refunded'],
  refunded: [],
  // A failed attempt must be retryable; a customer whose card declined once
  // should not be locked out of paying.
  failed: ['unpaid', 'authorised', 'paid', 'partially_paid'],
};

const FULFILMENT_TRANSITIONS: Record<FulfilmentStatus, readonly FulfilmentStatus[]> = {
  unfulfilled: ['partially_fulfilled', 'fulfilled'],
  partially_fulfilled: ['fulfilled', 'partially_returned', 'partially_fulfilled'],
  fulfilled: ['partially_returned', 'returned'],
  partially_returned: ['returned', 'partially_returned', 'fulfilled'],
  returned: [],
};

export function canTransitionStatus(from: OrderStatus, to: OrderStatus): boolean {
  return from === to || ORDER_TRANSITIONS[from].includes(to);
}

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return from === to || PAYMENT_TRANSITIONS[from].includes(to);
}

export function canTransitionFulfilment(from: FulfilmentStatus, to: FulfilmentStatus): boolean {
  return from === to || FULFILMENT_TRANSITIONS[from].includes(to);
}

export function assertTransition(current: OrderState, next: Partial<OrderState>): void {
  if (next.status && !canTransitionStatus(current.status, next.status)) {
    throw new IllegalTransitionError('status', current.status, next.status);
  }
  if (next.paymentStatus && !canTransitionPayment(current.paymentStatus, next.paymentStatus)) {
    throw new IllegalTransitionError('paymentStatus', current.paymentStatus, next.paymentStatus);
  }
  if (
    next.fulfilmentStatus &&
    !canTransitionFulfilment(current.fulfilmentStatus, next.fulfilmentStatus)
  ) {
    throw new IllegalTransitionError(
      'fulfilmentStatus',
      current.fulfilmentStatus,
      next.fulfilmentStatus,
    );
  }
}

export function transition(current: OrderState, next: Partial<OrderState>): OrderState {
  assertTransition(current, next);
  return { ...current, ...next };
}

/* ──────────────────── Derived statuses from quantities ──────────────── */

export function derivePaymentStatus(
  total: number,
  paid: number,
  refunded: number,
  hasAuthorisation = false,
): PaymentStatus {
  if (refunded > 0 && refunded >= paid && paid > 0) return 'refunded';
  if (refunded > 0) return 'partially_refunded';
  if (paid >= total && total > 0) return 'paid';
  if (paid > 0) return 'partially_paid';
  if (hasAuthorisation) return 'authorised';
  return 'unpaid';
}

export function deriveFulfilmentStatus(
  items: readonly { quantity: number; quantityFulfilled: number; quantityReturned: number }[],
): FulfilmentStatus {
  if (items.length === 0) return 'unfulfilled';
  const ordered = items.reduce((n, i) => n + i.quantity, 0);
  const fulfilled = items.reduce((n, i) => n + i.quantityFulfilled, 0);
  const returned = items.reduce((n, i) => n + i.quantityReturned, 0);

  if (returned > 0 && returned >= fulfilled && fulfilled > 0) return 'returned';
  if (returned > 0) return 'partially_returned';
  if (fulfilled >= ordered) return 'fulfilled';
  if (fulfilled > 0) return 'partially_fulfilled';
  return 'unfulfilled';
}

/* ─────────────────────── Business rule guards ───────────────────────── */

export interface CancellationCheck {
  readonly allowed: boolean;
  readonly reason?: string;
}

/**
 * Cancellation is refused once goods have physically moved. A cancelled order
 * releases inventory; doing that after a courier has the parcel means the stock
 * count says "available" for units that are on a van, and the next customer
 * buys air.
 */
export function canCancel(state: OrderState): CancellationCheck {
  if (state.status === 'cancelled') return { allowed: false, reason: 'Order is already cancelled' };
  if (state.status === 'completed') {
    return { allowed: false, reason: 'Completed orders are reversed via a return, not a cancellation' };
  }
  if (state.fulfilmentStatus !== 'unfulfilled') {
    return { allowed: false, reason: 'Part of this order has already shipped' };
  }
  return { allowed: true };
}

export function canRefund(state: OrderState): CancellationCheck {
  if (state.paymentStatus === 'refunded') {
    return { allowed: false, reason: 'Order is already fully refunded' };
  }
  if (!['paid', 'partially_paid', 'partially_refunded'].includes(state.paymentStatus)) {
    return { allowed: false, reason: 'Nothing has been captured to refund' };
  }
  return { allowed: true };
}

/**
 * Which actions the admin UI should offer. Centralising this stops the UI and
 * the API from disagreeing about what is possible — a disagreement the user
 * always experiences as a bug.
 */
export function availableActions(state: OrderState): string[] {
  const actions: string[] = [];
  if (canTransitionStatus(state.status, 'confirmed') && state.status === 'pending') {
    actions.push('confirm');
  }
  if (canCancel(state).allowed) actions.push('cancel');
  if (canRefund(state).allowed) actions.push('refund');
  if (state.paymentStatus === 'unpaid' || state.paymentStatus === 'failed') {
    actions.push('request_payment');
  }
  if (state.fulfilmentStatus !== 'fulfilled' && state.status !== 'cancelled') {
    actions.push('create_shipment');
  }
  if (state.fulfilmentStatus === 'fulfilled' || state.fulfilmentStatus === 'partially_fulfilled') {
    actions.push('create_return');
  }
  return actions;
}
