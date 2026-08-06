import type { Database } from '@voltix/db';

/**
 * The transaction handle every service function takes.
 *
 * Services never open their own transaction. The caller owns the boundary,
 * which is what lets "reserve stock, create the order, write the ledger entry,
 * enqueue the confirmation email" be one atomic unit rather than four
 * independently-failing steps. A service that opens its own transaction cannot
 * be composed with another one, and in commerce almost everything composes.
 */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface TenantContext {
  readonly tenantId: string;
  readonly storeId?: string;
  readonly currency: string;
  readonly locale: string;
  readonly vatRateBps: number;
  readonly pricesIncludeVat: boolean;
}

export interface ActorContext {
  readonly type: 'customer' | 'staff' | 'system' | 'guest';
  readonly id?: string;
  readonly label?: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly requestId?: string;
}
