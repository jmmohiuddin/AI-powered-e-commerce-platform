import { describe, expect, it } from 'vitest';
import {
  availableActions,
  canCancel,
  canRefund,
  derivePaymentStatus,
  deriveFulfilmentStatus,
  IllegalTransitionError,
  transition,
  type OrderState,
} from './state-machine';

const fresh: OrderState = {
  status: 'pending',
  paymentStatus: 'unpaid',
  fulfilmentStatus: 'unfulfilled',
};

describe('transitions', () => {
  it('allows the happy path', () => {
    let s = transition(fresh, { status: 'confirmed', paymentStatus: 'paid' });
    s = transition(s, { status: 'processing', fulfilmentStatus: 'fulfilled' });
    s = transition(s, { status: 'completed' });
    expect(s.status).toBe('completed');
  });

  it('refuses to reopen a completed order', () => {
    const completed: OrderState = { ...fresh, status: 'completed' };
    expect(() => transition(completed, { status: 'processing' })).toThrow(IllegalTransitionError);
  });

  it('refuses to un-refund', () => {
    const refunded: OrderState = { ...fresh, paymentStatus: 'refunded' };
    expect(() => transition(refunded, { paymentStatus: 'paid' })).toThrow(IllegalTransitionError);
  });

  it('lets a failed payment be retried', () => {
    const failed: OrderState = { ...fresh, paymentStatus: 'failed' };
    expect(transition(failed, { paymentStatus: 'paid' }).paymentStatus).toBe('paid');
  });

  it('treats a no-op transition as legal', () => {
    expect(transition(fresh, { status: 'pending' }).status).toBe('pending');
  });
});

describe('derivePaymentStatus', () => {
  it.each([
    [1000, 0, 0, false, 'unpaid'],
    [1000, 0, 0, true, 'authorised'],
    [1000, 400, 0, false, 'partially_paid'],
    [1000, 1000, 0, false, 'paid'],
    [1000, 1000, 300, false, 'partially_refunded'],
    [1000, 1000, 1000, false, 'refunded'],
  ] as const)('total=%i paid=%i refunded=%i → %s', (total, paid, refunded, auth, expected) => {
    expect(derivePaymentStatus(total, paid, refunded, auth)).toBe(expected);
  });

  it('treats overpayment as paid rather than an impossible state', () => {
    expect(derivePaymentStatus(1000, 1200, 0)).toBe('paid');
  });
});

describe('deriveFulfilmentStatus', () => {
  it('reports partial fulfilment across mixed lines', () => {
    expect(
      deriveFulfilmentStatus([
        { quantity: 2, quantityFulfilled: 2, quantityReturned: 0 },
        { quantity: 3, quantityFulfilled: 1, quantityReturned: 0 },
      ]),
    ).toBe('partially_fulfilled');
  });

  it('reports a full return', () => {
    expect(
      deriveFulfilmentStatus([{ quantity: 1, quantityFulfilled: 1, quantityReturned: 1 }]),
    ).toBe('returned');
  });

  it('handles an empty order', () => {
    expect(deriveFulfilmentStatus([])).toBe('unfulfilled');
  });
});

describe('business guards', () => {
  it('blocks cancellation once anything has shipped', () => {
    const shipped: OrderState = { ...fresh, fulfilmentStatus: 'partially_fulfilled' };
    const check = canCancel(shipped);
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/already shipped/);
  });

  it('blocks refunding an unpaid order', () => {
    expect(canRefund(fresh).allowed).toBe(false);
  });

  it('offers only legal actions', () => {
    const paidUnshipped: OrderState = {
      status: 'confirmed',
      paymentStatus: 'paid',
      fulfilmentStatus: 'unfulfilled',
    };
    const actions = availableActions(paidUnshipped);
    expect(actions).toContain('cancel');
    expect(actions).toContain('refund');
    expect(actions).toContain('create_shipment');
    expect(actions).not.toContain('create_return');
  });
});
