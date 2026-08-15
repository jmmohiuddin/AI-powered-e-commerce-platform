import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    // Loads the repo-root .env before any test imports a database client.
    // Without it the integration suites find no DATABASE_URL, skip themselves,
    // and the run reports green while testing nothing against Postgres — the
    // most expensive kind of passing test.
    setupFiles: [r('./test/setup-env.ts')],
    // The integration suites run against whatever DATABASE_URL points at. With
    // a cloud database (Neon in ap-southeast-1) each round trip costs real
    // network latency, and tests that make dozens of sequential queries — the
    // checkout flow, the 8-way oversell race — legitimately need more than the
    // 5s default. This is a ceiling, not a target: against local Docker they
    // still finish in milliseconds.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**', '**/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Domain logic is where correctness actually matters; UI is covered by
      // Playwright instead, so we scope thresholds to the packages.
      include: [
        'packages/core/src/**',
        'packages/payments/src/**',
        'packages/ai/src/**',
        'packages/commerce/src/**',
      ],
      thresholds: { lines: 70, functions: 70, branches: 60, statements: 70 },
    },
  },
  // The apps set `jsx: "preserve"` in tsconfig, because Next runs its own JSX
  // transform. The bundler honours that and hands Vite un-transformed JSX, so
  // any test importing a component fails to parse. Compiling it here lets a
  // test render a real component rather than assert against its source text.
  // `oxc` and not `esbuild`: Vitest 4 transforms with oxc and ignores the
  // esbuild options entirely, with a warning that is easy to read past.
  oxc: { jsx: { runtime: 'automatic' } },

  resolve: {
    alias: {
      '@voltix/config/load-env': r('./packages/config/src/load-env.ts'),
      '@voltix/config': r('./packages/config/src/index.ts'),
      '@voltix/core': r('./packages/core/src/index.ts'),
      '@voltix/db/schema': r('./packages/db/src/schema/index.ts'),
      '@voltix/db': r('./packages/db/src/index.ts'),
      '@voltix/commerce': r('./packages/commerce/src/index.ts'),
      '@voltix/payments': r('./packages/payments/src/index.ts'),
      '@voltix/ai': r('./packages/ai/src/index.ts'),
      '@voltix/invoicing': r('./packages/invoicing/src/index.ts'),
      '@voltix/notifications': r('./packages/notifications/src/index.ts'),
      '@voltix/auth': r('./packages/auth/src/index.ts'),
      '@voltix/ui': r('./packages/ui/src/index.ts'),
      '@voltix/media': r('./packages/media/src/index.ts'),
      // The admin's read model imports 'server-only', which throws when loaded
      // outside a React Server Component. Stubbing it lets the SQL be exercised
      // directly; the real guard still applies in the build, where it matters.
      'server-only': r('./test/server-only-stub.ts'),
    },
  },
});
