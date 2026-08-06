import { EMIRATES } from '@voltix/core';

/**
 * Renders an emirate for a human.
 *
 * Addresses store the two-letter code ('DU'), which is right for the database
 * and wrong for the screen: an operator scanning an order list should not be
 * translating 'UQ' into Umm Al Quwain in their head. Unknown codes fall through
 * unchanged rather than becoming an em dash, because seeing the raw value is
 * how you notice bad data.
 */
export function emirateName(code: string | null | undefined): string {
  if (!code) return '\u2014';
  return EMIRATES.find((e) => e.code === code)?.name ?? code;
}
