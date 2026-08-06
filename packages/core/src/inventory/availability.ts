/**
 * INVENTORY AVAILABILITY & ALLOCATION
 *
 * Pure decision logic, deliberately separated from the database transaction
 * that performs the write. The rule "which warehouse should ship this?" is
 * business policy and changes often; the rule "take a row lock before
 * decrementing" is infrastructure and must never change. Mixing them produces
 * a function nobody can safely edit.
 *
 * The caller wraps `allocate()` in a transaction that:
 *   1. SELECT … FOR UPDATE on the relevant stock_levels rows (ordered by id, to
 *      avoid deadlock between two concurrent carts touching the same SKUs),
 *   2. calls these pure functions,
 *   3. writes reservations + movements,
 *   4. commits.
 */

export interface StockPosition {
  readonly warehouseId: string;
  readonly onHand: number;
  readonly reserved: number;
  readonly incoming: number;
  readonly allowBackorder: boolean;
  /** Lower wins. Set per warehouse; ties break on larger available quantity. */
  readonly priority: number;
  readonly leadTimeDays?: number | null;
}

export interface AvailabilityView {
  readonly available: number;
  readonly incoming: number;
  readonly inStock: boolean;
  readonly backorderable: boolean;
  /** What the product page says. Never a raw number below the display floor. */
  readonly label: AvailabilityLabel;
  readonly estimatedRestockDays?: number;
}

export type AvailabilityLabel =
  | 'in_stock'
  | 'low_stock'
  | 'out_of_stock'
  | 'backorder'
  | 'preorder';

export interface AvailabilityOptions {
  /** Below this, show "only N left". Urgency that is true converts; lying does not. */
  readonly lowStockThreshold?: number;
  /**
   * Never publish an exact count above this. Exact counts above ~10 tell a
   * competitor your stock position and add nothing for the shopper.
   */
  readonly exactCountCeiling?: number;
}

export function availableIn(position: StockPosition): number {
  return Math.max(0, position.onHand - position.reserved);
}

export function summarise(
  positions: readonly StockPosition[],
  options: AvailabilityOptions = {},
): AvailabilityView {
  const { lowStockThreshold = 5 } = options;

  const available = positions.reduce((n, p) => n + availableIn(p), 0);
  const incoming = positions.reduce((n, p) => n + p.incoming, 0);
  const backorderable = positions.some((p) => p.allowBackorder);

  let label: AvailabilityLabel;
  if (available > 0) label = available <= lowStockThreshold ? 'low_stock' : 'in_stock';
  else if (backorderable) label = 'backorder';
  else if (incoming > 0) label = 'preorder';
  else label = 'out_of_stock';

  const leadTimes = positions
    .map((p) => p.leadTimeDays)
    .filter((d): d is number => typeof d === 'number');

  return {
    available,
    incoming,
    inStock: available > 0,
    backorderable,
    label,
    ...(available === 0 && leadTimes.length > 0
      ? { estimatedRestockDays: Math.min(...leadTimes) }
      : {}),
  };
}

/**
 * What the storefront is allowed to say about quantity.
 *
 * "Only 2 left!" is one of the highest-lift conversion elements in commerce and
 * also one of the most abused. It is shown here only when it is literally true,
 * and exact counts are capped so the page never doubles as a competitor's
 * inventory feed.
 */
export function displayQuantity(
  available: number,
  options: AvailabilityOptions = {},
): { text: string; exact: boolean } {
  const { lowStockThreshold = 5, exactCountCeiling = 10 } = options;
  if (available <= 0) return { text: 'Out of stock', exact: true };
  if (available <= lowStockThreshold) return { text: `Only ${available} left`, exact: true };
  if (available <= exactCountCeiling) return { text: 'In stock', exact: false };
  return { text: 'In stock', exact: false };
}

export interface AllocationRequest {
  readonly quantity: number;
  /** Prefer this location (click-and-collect, nearest branch). */
  readonly preferredWarehouseId?: string;
}

export interface Allocation {
  readonly warehouseId: string;
  readonly quantity: number;
  readonly isBackorder: boolean;
}

export interface AllocationResult {
  readonly fulfilled: boolean;
  readonly allocations: readonly Allocation[];
  readonly shortfall: number;
}

/**
 * Decide which warehouses ship how many units.
 *
 * Policy, in order:
 *   1. The customer's preferred location first — a shopper who chose "collect
 *      from Dhanmondi" gets Dhanmondi or an explicit failure, never a silent
 *      substitution.
 *   2. Then by warehouse priority, then by most stock — consolidating into
 *      fewer parcels, because a split shipment costs a second delivery fee and
 *      doubles the chance of a delivery problem.
 *   3. Backorder only from a location that permits it, and only after every
 *      in-stock option is exhausted.
 */
export function allocateStock(
  positions: readonly StockPosition[],
  request: AllocationRequest,
): AllocationResult {
  if (request.quantity <= 0) {
    return { fulfilled: true, allocations: [], shortfall: 0 };
  }

  const ranked = [...positions].sort((a, b) => {
    if (request.preferredWarehouseId) {
      if (a.warehouseId === request.preferredWarehouseId) return -1;
      if (b.warehouseId === request.preferredWarehouseId) return 1;
    }
    if (a.priority !== b.priority) return a.priority - b.priority;
    return availableIn(b) - availableIn(a);
  });

  const allocations: Allocation[] = [];
  let remaining = request.quantity;

  // Pass 1: satisfy from physical stock, preferring a single source.
  const singleSource = ranked.find((p) => availableIn(p) >= remaining);
  if (singleSource) {
    return {
      fulfilled: true,
      allocations: [
        { warehouseId: singleSource.warehouseId, quantity: remaining, isBackorder: false },
      ],
      shortfall: 0,
    };
  }

  for (const position of ranked) {
    if (remaining <= 0) break;
    const take = Math.min(availableIn(position), remaining);
    if (take <= 0) continue;
    allocations.push({ warehouseId: position.warehouseId, quantity: take, isBackorder: false });
    remaining -= take;
  }

  // Pass 2: backorder the remainder where permitted.
  if (remaining > 0) {
    const backorderSource = ranked.find((p) => p.allowBackorder);
    if (backorderSource) {
      allocations.push({
        warehouseId: backorderSource.warehouseId,
        quantity: remaining,
        isBackorder: true,
      });
      remaining = 0;
    }
  }

  return { fulfilled: remaining === 0, allocations, shortfall: remaining };
}

/**
 * Reservation lifetime.
 *
 * Long enough that a shopper can find their card or complete an OTP without
 * losing the item; short enough that an abandoned checkout does not hold stock
 * hostage through a flash sale. Cash-on-delivery gets longer because the flow
 * involves no gateway round-trip but often a phone confirmation.
 */
export function reservationTtlMs(paymentProvider?: string): number {
  const MINUTE = 60_000;
  switch (paymentProvider) {
    case 'cod':
      return 60 * MINUTE;
    case 'bank_transfer':
      return 24 * 60 * MINUTE;
    default:
      return 20 * MINUTE;
  }
}
