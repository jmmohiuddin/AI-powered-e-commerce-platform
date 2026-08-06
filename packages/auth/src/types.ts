import type { Database } from '@voltix/db';

/** Same transaction handle the commerce services take — the caller owns the boundary. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
