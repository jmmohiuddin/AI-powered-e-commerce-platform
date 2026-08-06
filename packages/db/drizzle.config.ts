import '@voltix/config/load-env';
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  casing: 'snake_case',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://voltix:voltix_dev_password@localhost:5433/voltix',
  },
  // Generated SQL is committed and reviewed like any other code. Never run
  // `drizzle-kit push` against a database that holds real orders.
  verbose: true,
  strict: true,
} satisfies Config;
