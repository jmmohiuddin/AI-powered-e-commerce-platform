import '@voltix/config/load-env';

/**
 * Vitest setup: populate process.env from the repo-root .env.
 *
 * Integration tests skip themselves when Postgres is unreachable, which is the
 * right behaviour on a laptop with no Docker — but it becomes a silent lie if
 * the only reason it is unreachable is that nobody told the test process where
 * the database lives.
 */
export {};
