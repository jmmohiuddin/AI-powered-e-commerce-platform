import { bigint, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Column conventions shared by every table.
 *
 * MONEY
 * -----
 * Money is stored as an integer number of *minor units* (fils, cents, fils)
 * in a bigint column, never as float or numeric. Floats lose pennies; numeric
 * is correct but forces string round-tripping in JS and invites accidental
 * `Number()` casts. Integers in a bigint are exact, cheap to sum, and safe to
 * `JSON.stringify`. The currency lives beside the amount on the owning row —
 * see `Money` in @voltix/core, which is the only type allowed to do arithmetic.
 *
 * A signed bigint holds ~9.2e18 minor units. Even at AED fils granularity
 * that is ~92 quadrillion dirhams — comfortably beyond any merchant's lifetime
 * gross volume. `mode: 'number'` keeps values as JS numbers, which is exact up
 * to 2^53 (~90 trillion dirhams). Aggregations that could exceed that run in SQL.
 *
 * IDENTIFIERS
 * -----------
 * UUIDv7 primary keys, generated in the application (see ../id.ts). Random
 * UUIDv4 destroys B-tree locality on write-heavy tables like order_events;
 * v7 is time-ordered so inserts append to the right-hand edge of the index the
 * way a bigserial would, while staying globally unique and non-enumerable.
 * Non-enumerable matters: sequential order IDs leak your daily volume to any
 * competitor who places two orders.
 */

export const money = (name: string) => bigint(name, { mode: 'number' });

/** ISO-4217 code. Stored per-row so a tenant can sell in AED and USD at once. */
export const currency = (name = 'currency') => varchar(name, { length: 3 });

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * Soft delete. Commerce data is evidentiary — an order line referencing a
 * product deleted last March still has to render on the customer's invoice, and
 * tax authorities do not accept "we hard-deleted it". Every read path filters
 * on `deleted_at IS NULL`; the helper in ../filters.ts makes that hard to forget.
 */
export const deletedAt = () => timestamp('deleted_at', { withTimezone: true, mode: 'date' });

export const timestamps = () => ({
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const softDeleteTimestamps = () => ({
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: deletedAt(),
});

/**
 * Tenant scoping column. Present on every tenant-owned table and always the
 * leading column of the table's primary index, so that a tenant's working set
 * is physically clustered and cross-tenant reads are cheap to spot in EXPLAIN.
 * Postgres row-level security enforces isolation at the database layer as well
 * (migration 0002) — application filters are defence in depth, not the fence.
 */
export const tenantId = () => uuid('tenant_id').notNull();
