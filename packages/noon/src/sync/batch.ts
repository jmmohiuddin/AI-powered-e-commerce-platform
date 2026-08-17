import { MAX_BATCH_SIZE } from '../client.js';

/** Splits a list into chunks no larger than `size`. */
export function chunk<T>(items: readonly T[], size: number = MAX_BATCH_SIZE): T[][] {
  if (size < 1) throw new RangeError('chunk size must be at least 1');

  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Converts minor units to the major-unit double noon's pricing API expects.
 *
 * Voltix stores 129950 fils; noon wants 1299.5. The exponent is looked up per
 * currency rather than assumed to be 2 — the GCC three-decimal currencies
 * (KWD, BHD, OMR) are exactly why, and a 1,000-fils dinar sent as 100.0 is a
 * 10× underpricing that noon will happily accept and sell at.
 *
 * The rounding guards against float error, not against fractional fils: at 3
 * decimal places, 129950 / 1000 is already exact in binary floating point for
 * every value in range, but chained arithmetic upstream is not, and a price of
 * 1299.5000000000002 is a rejection.
 */
export function toMajorUnits(minorUnits: number, exponent: number): number {
  const divisor = 10 ** exponent;
  return Math.round(minorUnits) / divisor;
}
