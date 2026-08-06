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

  // Workspace packages ship TypeScript source rather than build output, so Next
  // compiles them as part of the app. Removes a build step and keeps
  // go-to-definition landing on real source instead of a .d.ts.
  transpilePackages: ['@voltix/core', '@voltix/ui', '@voltix/ai', '@voltix/commerce', '@voltix/db', '@voltix/payments'],

  images: {
    formats: ['image/avif', 'image/webp'],
    // Explicit device sizes so the srcset matches the breakpoints the layout
    // actually uses; the defaults generate variants nothing ever requests.
    deviceSizes: [360, 420, 640, 828, 1080, 1280, 1920],
    imageSizes: [96, 160, 220, 320],
  },

  /**
   * Security headers.
   *
   * These belong at the edge in production (CDN or reverse proxy) so they apply
   * to static assets too, but defining them here means a self-hosted deployment
   * is not silently missing them. See docs/07-security.md.
   *
   * CSP is deliberately absent from this list: a correct policy needs the
   * per-request nonce that the middleware generates, and a wrong CSP either
   * breaks the app or provides false assurance. It is added in middleware.ts.
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(self), payment=(self)',
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
