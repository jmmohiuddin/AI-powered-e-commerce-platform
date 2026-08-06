import { describe, expect, it } from 'vitest';
import {
  allocateStock,
  availableIn,
  displayQuantity,
  reservationTtlMs,
  summarise,
  type StockPosition,
} from './availability';

const wh = (over: Partial<StockPosition> & { warehouseId: string }): StockPosition => ({
  onHand: 0,
  reserved: 0,
  incoming: 0,
  allowBackorder: false,
  priority: 100,
  ...over,
});

describe('availableIn', () => {
  it('subtracts reservations and never goes negative', () => {
    expect(availableIn(wh({ warehouseId: 'a', onHand: 5, reserved: 2 }))).toBe(3);
    expect(availableIn(wh({ warehouseId: 'a', onHand: 1, reserved: 4 }))).toBe(0);
  });
});

describe('summarise', () => {
  it('labels low stock below the threshold', () => {
    const view = summarise([wh({ warehouseId: 'a', onHand: 3 })]);
    expect(view.label).toBe('low_stock');
    expect(view.inStock).toBe(true);
  });

  it('labels backorder when a location permits it', () => {
    const view = summarise([wh({ warehouseId: 'a', onHand: 0, allowBackorder: true })]);
    expect(view.label).toBe('backorder');
  });

  it('labels preorder when stock is incoming but none permits backorder', () => {
    const view = summarise([wh({ warehouseId: 'a', onHand: 0, incoming: 20, leadTimeDays: 7 })]);
    expect(view.label).toBe('preorder');
    expect(view.estimatedRestockDays).toBe(7);
  });

  it('aggregates across warehouses', () => {
    const view = summarise([
      wh({ warehouseId: 'a', onHand: 10, reserved: 4 }),
      wh({ warehouseId: 'b', onHand: 7 }),
    ]);
    expect(view.available).toBe(13);
    expect(view.label).toBe('in_stock');
  });
});

describe('displayQuantity', () => {
  it('shows exact counts only when scarcity is real', () => {
    expect(displayQuantity(2)).toEqual({ text: 'Only 2 left', exact: true });
  });

  it('never publishes a large exact count', () => {
    expect(displayQuantity(400).exact).toBe(false);
    expect(displayQuantity(400).text).toBe('In stock');
  });
});

describe('allocate', () => {
  it('prefers a single source to avoid split shipments', () => {
    const result = allocateStock(
      [wh({ warehouseId: 'a', onHand: 2 }), wh({ warehouseId: 'b', onHand: 10 })],
      { quantity: 2 },
    );
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]?.warehouseId).toBe('b');
  });

  it('honours the customer’s preferred location', () => {
    const result = allocateStock(
      [wh({ warehouseId: 'far', onHand: 50 }), wh({ warehouseId: 'near', onHand: 5 })],
      { quantity: 3, preferredWarehouseId: 'near' },
    );
    expect(result.allocations[0]?.warehouseId).toBe('near');
  });

  it('splits across locations when no single one can cover it', () => {
    const result = allocateStock(
      [wh({ warehouseId: 'a', onHand: 3, priority: 1 }), wh({ warehouseId: 'b', onHand: 4, priority: 2 })],
      { quantity: 6 },
    );
    expect(result.fulfilled).toBe(true);
    expect(result.allocations.map((a) => a.quantity).reduce((x, y) => x + y)).toBe(6);
  });

  it('reports a shortfall rather than silently under-allocating', () => {
    const result = allocateStock([wh({ warehouseId: 'a', onHand: 1 })], { quantity: 5 });
    expect(result.fulfilled).toBe(false);
    expect(result.shortfall).toBe(4);
  });

  it('backorders only where permitted and only after physical stock', () => {
    const result = allocateStock(
      [
        wh({ warehouseId: 'a', onHand: 2, priority: 1 }),
        wh({ warehouseId: 'b', onHand: 0, allowBackorder: true, priority: 2 }),
      ],
      { quantity: 5 },
    );
    expect(result.fulfilled).toBe(true);
    expect(result.allocations).toEqual([
      { warehouseId: 'a', quantity: 2, isBackorder: false },
      { warehouseId: 'b', quantity: 3, isBackorder: true },
    ]);
  });

  it('is a no-op for zero quantity', () => {
    expect(allocateStock([], { quantity: 0 })).toEqual({
      fulfilled: true,
      allocations: [],
      shortfall: 0,
    });
  });
});

describe('reservationTtlMs', () => {
  it('gives cash-on-delivery a longer hold than card payment', () => {
    expect(reservationTtlMs('cod')).toBeGreaterThan(reservationTtlMs('stripe'));
  });
});
