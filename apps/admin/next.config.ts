import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/**
 * Load the monorepo-root `.env`.
 *
 * Next resolves `.env` relative to the *app* directory, not the workspace root,
 * so a root `.env` is silently ignored. The failure mode is nasty: with no
 * DATABASE_URL the storefront falls back to its demo catalogue and serves a
 * perfectly convincing store built on placeholder data. Nothing errors, so
 * nothing tells you.
 *
 * One `.env` at the root keeps the two apps, the migrations, the seed and the
 * worker on a single source of configuration. `override: false` means anything
 * already exported in the shell still wins.
 */
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), override: false });

const config: NextConfig = {
  reactStrictMode: true,
  // Every workspace package reachable from this app, including the ones
  // pulled in transitively (commerce → notifications). They ship TypeScript
  // source rather than build output, so Next has to compile them.
  transpilePackages: [
    '@voltix/core',
    '@voltix/ui',
    '@voltix/ai',
    '@voltix/auth',
    '@voltix/commerce',
    '@voltix/db',
    '@voltix/media',
    '@voltix/payments',
    '@voltix/notifications',
  ],

  // `sharp` is a native addon. Bundling it into the server build breaks the
  // .node binary resolution, so it stays external and is required at runtime.
  serverExternalPackages: ['sharp'],

  experimental: {
    serverActions: {
      /**
       * Product image uploads go through a Server Action, and the default body
       * limit is 1 MB — smaller than essentially every photograph taken on a
       * phone. Left at the default, uploading stock photos fails with a 413
       * that surfaces as a generic error, which is a miserable thing to debug.
       *
       * Sized for one file at a time: the pipeline accepts 12 MB per image and
       * the media form uploads sequentially, so this is a single image plus
       * multipart overhead rather than a whole selection at once. Keeping it
       * per-file is what stops a twelve-photo upload from asking the server to
       * hold 144 MB in memory.
       */
      bodySizeLimit: '16mb',
    },
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          // The admin sends no referrer at all. A dashboard URL can carry an
          // order id or a customer id in the path; leaking that to any external
          // link a staff member clicks is an avoidable data disclosure.
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(), geolocation=(), payment=()',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ];
  },
};

export default config;
