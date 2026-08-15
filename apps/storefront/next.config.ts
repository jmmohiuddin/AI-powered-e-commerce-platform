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

/**
 * Allowlist entries for the configured media origins.
 *
 * Both `CDN_BASE_URL` and `S3_ENDPOINT` are read: the first is where images are
 * served from once a CDN is in front of the bucket, the second is the bucket
 * itself, which is what a local MinIO setup uses directly. Scoped to the path
 * the URL already carries so a shared bucket host does not become a wildcard.
 */
function mediaPatterns(): NonNullable<NonNullable<NextConfig['images']>['remotePatterns']> {
  const origins = [process.env.CDN_BASE_URL, process.env.S3_ENDPOINT].filter(
    (value): value is string => Boolean(value),
  );

  return origins.flatMap((origin) => {
    try {
      const url = new URL(origin);
      return [
        {
          protocol: url.protocol.replace(':', '') as 'http' | 'https',
          hostname: url.hostname,
          port: url.port,
          pathname: `${url.pathname.replace(/\/$/, '')}/**`,
          search: '',
        },
      ];
    } catch {
      // A malformed URL here must not take the build down — it just means this
      // origin is not allowlisted, and the image 400s visibly rather than the
      // whole app failing to start.
      return [];
    }
  });
}

const config: NextConfig = {
  reactStrictMode: true,

  // Workspace packages ship TypeScript source rather than build output, so Next
  // compiles them as part of the app. Removes a build step and keeps
  // go-to-definition landing on real source instead of a .d.ts.
  transpilePackages: [
    '@voltix/core',
    '@voltix/ui',
    '@voltix/ai',
    '@voltix/commerce',
    '@voltix/db',
    '@voltix/payments',
    '@voltix/notifications',
  ],

  images: {
    formats: ['image/avif', 'image/webp'],
    // Explicit device sizes so the srcset matches the breakpoints the layout
    // actually uses; the defaults generate variants nothing ever requests.
    deviceSizes: [360, 420, 640, 828, 1080, 1280, 1920],
    imageSizes: [96, 160, 220, 320],
    /**
     * Where product photographs are allowed to come from.
     *
     * Derived from the configured media host rather than hardcoded, because the
     * same build runs against MinIO locally and R2 in production. Without a
     * matching entry `next/image` answers 400 for every remote image, which
     * looks like a broken CDN and is not one.
     *
     * `remotePatterns` is an allowlist for a reason: the optimiser fetches
     * whatever it is pointed at, so leaving it open turns this deployment into
     * an image proxy for the entire internet, on our bandwidth.
     */
    remotePatterns: mediaPatterns(),

    /**
     * IN DEVELOPMENT ONLY, and never inherited by a production build.
     *
     * Next 16 refuses to optimise an image whose hostname resolves to a private
     * address, because an open image optimiser is an SSRF primitive: it will
     * fetch whatever URL it is handed, from inside the network the server sits
     * in. That default is correct and stays on in production.
     *
     * Local development serves media from MinIO on `localhost:9000`, which is
     * exactly the case the check blocks — so without this every product image
     * 400s with "url parameter is not allowed", which reads like a
     * `remotePatterns` mistake and is not one.
     *
     * The exposure this opens is bounded by `remotePatterns` above, which is an
     * allowlist of the configured media origins rather than a wildcard, and it
     * is off the moment NODE_ENV is anything but development.
     */
    ...(process.env.NODE_ENV === 'development' ? { dangerouslyAllowLocalIP: true } : {}),
  },

  /**
   * Security headers.
   *
   * These belong at the edge in production (CDN or reverse proxy) so they apply
   * to static assets too, but defining them here means a self-hosted deployment
   * is not silently missing them. See docs/07-security.md.
   *
   * CSP is deliberately absent from this list: a correct policy needs a
   * per-request nonce, and a wrong CSP either breaks the app or provides false
   * assurance. It is set in src/proxy.ts — `proxy` being what Next 16 renamed
   * the middleware convention to — and is enforced unless CSP_ENFORCE=false.
   * The reasoning is written out in that file.
   *
   * `img-src` in that policy is derived from the same CDN_BASE_URL and
   * S3_ENDPOINT that `remotePatterns` above uses. Change one and change the
   * other, or next/image will happily fetch an origin the browser then refuses
   * to paint — a blank image with nothing in the network tab to explain it.
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
