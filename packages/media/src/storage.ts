import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError } from '@voltix/core';
import { signRequest } from './sigv4';

/**
 * PLUGGABLE OBJECT STORAGE
 *
 * Two drivers behind one interface, chosen by configuration rather than by an
 * import. The provider is never named at a call site: an upload route asks
 * `resolveStorage()` for whatever this deployment has, and the same code path
 * runs against MinIO in development, R2 in production, and the local disk on a
 * laptop with no Docker.
 *
 * Why an interface at all for two implementations: the alternative is an
 * `if (process.env.S3_ENDPOINT)` inside the upload handler, which is how the
 * dev path quietly stops being exercised and breaks. Both drivers satisfy the
 * same contract, so whichever one a deployment gets has already been run.
 *
 * Keys are opaque to callers and stable: `products/<productId>/<id>.<ext>`.
 * The public URL is derived from the key rather than stored separately, so
 * moving a bucket behind a CDN is a `CDN_BASE_URL` change and not a migration.
 */

export interface StoredObject {
  readonly key: string;
  /** Publicly fetchable URL. What goes in `media.url`. */
  readonly url: string;
}

export interface MediaStorage {
  /** Named so an operator can tell from a log line where the bytes went. */
  readonly driver: 's3' | 'disk';
  put(key: string, body: Uint8Array, contentType: string): Promise<StoredObject>;
  remove(key: string): Promise<void>;
  urlFor(key: string): string;
  /** Inverse of `urlFor`, for deleting an object we only have the URL of. */
  keyFor(url: string): string | undefined;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

/* ────────────────────────────── S3-compatible ─────────────────────────── */

export interface S3StorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Where the objects are served from publicly. Defaults to the endpoint. */
  readonly publicBaseUrl?: string | undefined;
}

/**
 * S3-compatible driver. Works against AWS S3, Cloudflare R2 and MinIO.
 *
 * Path-style addressing (`<endpoint>/<bucket>/<key>`) rather than virtual-host
 * style: MinIO and R2 custom endpoints both serve it, and virtual-host style
 * needs DNS per bucket, which a local container does not have.
 */
export function s3Storage(config: S3StorageConfig): MediaStorage {
  const endpoint = config.endpoint.replace(/\/+$/, '');
  const publicBase = (config.publicBaseUrl || `${endpoint}/${config.bucket}`).replace(/\/+$/, '');

  const urlFor = (key: string) => `${publicBase}/${trimSlashes(key)}`;

  async function send(method: 'PUT' | 'DELETE', key: string, body?: Uint8Array, contentType?: string) {
    const url = `${endpoint}/${config.bucket}/${trimSlashes(key)}`;
    const headers = signRequest(
      {
        method,
        url,
        headers: contentType ? { 'content-type': contentType } : {},
        body,
      },
      {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        region: config.region,
        service: 's3',
      },
    );

    const response = await fetch(url, { method, headers, body: body as BodyInit | undefined });
    if (!response.ok) {
      // The body carries S3's real reason (NoSuchBucket, SignatureDoesNotMatch);
      // a bare status turns a five-second fix into an afternoon.
      const detail = await response.text().catch(() => '');
      // A 4xx here is our configuration being wrong — bad key, missing bucket —
      // and retrying it forever just hides that. Only 5xx is worth another go.
      throw new DomainError(
        response.status >= 500 ? 'GATEWAY_UNAVAILABLE' : 'INTERNAL',
        `S3 ${method} ${key} failed: ${response.status} ${detail}`,
        { publicMessage: 'The image store rejected the upload. Try again in a moment.' },
      );
    }
  }

  return {
    driver: 's3',
    urlFor,
    keyFor: (url) => (url.startsWith(`${publicBase}/`) ? url.slice(publicBase.length + 1) : undefined),
    async put(key, body, contentType) {
      await send('PUT', key, body, contentType);
      return { key, url: urlFor(key) };
    },
    async remove(key) {
      await send('DELETE', key);
    },
  };
}

/* ──────────────────────────────── Local disk ──────────────────────────── */

export interface DiskStorageConfig {
  /** Absolute directory the files are written into. */
  readonly directory: string;
  /** URL prefix the same directory is served from. */
  readonly publicBaseUrl: string;
}

/**
 * LOCAL DISK — DEVELOPMENT ONLY.
 *
 * Writes into the storefront's `public/` tree so Next serves the files with no
 * object store running at all: `npm run dev` on a fresh clone can upload an
 * image and see it render. It is not a production driver and does not pretend
 * to be — files land on one machine's filesystem, so a second instance serves
 * 404s for everything the first one accepted, and a container restart loses
 * the lot. `resolveStorage()` refuses it outright in production.
 */
export function diskStorage(config: DiskStorageConfig): MediaStorage {
  const root = resolve(config.directory);
  const publicBase = config.publicBaseUrl.replace(/\/+$/, '');

  const urlFor = (key: string) => `${publicBase}/${trimSlashes(key)}`;

  /**
   * Refuses a key that escapes the root. The keys are generated internally, but
   * a path-traversal check on anything that becomes a filesystem path is worth
   * more than the argument about whether this particular caller is trusted.
   */
  const pathFor = (key: string) => {
    const target = resolve(join(root, trimSlashes(key)));
    if (target !== root && !target.startsWith(`${root}/`)) {
      throw new DomainError('VALIDATION_FAILED', `Media key escapes storage root: ${key}`);
    }
    return target;
  };

  return {
    driver: 'disk',
    urlFor,
    keyFor: (url) => (url.startsWith(`${publicBase}/`) ? url.slice(publicBase.length + 1) : undefined),
    async put(key, body) {
      const target = pathFor(key);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body);
      return { key, url: urlFor(key) };
    },
    async remove(key) {
      // `force` so deleting an already-missing file is a no-op: the media row
      // is the record that matters, and a failed unlink must not strand it.
      await rm(pathFor(key), { force: true });
    },
  };
}

/* ──────────────────────────────── Resolution ──────────────────────────── */

let cached: MediaStorage | undefined;

/**
 * The storefront's `public/uploads`, located from this file rather than from
 * `process.cwd()`.
 *
 * A cwd-relative default is right only when the process happens to start in
 * `apps/admin`. Run from the repo root — a script, a test, a worker — the same
 * expression resolves to a sibling of the repository and silently writes a
 * merchant's uploads outside the project, where nothing serves them. Anchoring
 * to this module's own location makes the answer the same wherever it is
 * called from.
 *
 * The path is assembled with `resolve()` rather than `new URL(literal,
 * import.meta.url)`, which Turbopack treats as a static asset reference and
 * tries to resolve at build time — it fails the whole compile with "Module not
 * found" for a directory that is only ever written to at runtime.
 */
function defaultUploadDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../apps/storefront/public/uploads');
}

/**
 * Picks a driver from the environment.
 *
 * S3 when it is fully configured — endpoint, bucket and both credentials.
 * Partial configuration falls through to disk rather than failing at the first
 * upload, except in production, where silently writing a merchant's product
 * photos to an ephemeral container filesystem is the worse outcome.
 */
export function resolveStorage(env: NodeJS.ProcessEnv = process.env): MediaStorage {
  if (cached) return cached;

  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
  if (S3_ENDPOINT && S3_BUCKET && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY) {
    cached = s3Storage({
      endpoint: S3_ENDPOINT,
      region: env.S3_REGION || 'auto',
      bucket: S3_BUCKET,
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
      publicBaseUrl: env.CDN_BASE_URL,
    });
    return cached;
  }

  if (env.NODE_ENV === 'production') {
    throw new DomainError('INTERNAL', 'No object storage configured', {
      publicMessage: 'Image storage is not configured. Set S3_ENDPOINT, S3_BUCKET and credentials.',
    });
  }

  cached = diskStorage({
    directory: env.MEDIA_LOCAL_DIR || defaultUploadDirectory(),
    publicBaseUrl: env.MEDIA_LOCAL_BASE_URL || '/uploads',
  });
  return cached;
}

/** Test seam. Drops the memoised driver so a changed env is picked up. */
export function resetStorage(): void {
  cached = undefined;
}
