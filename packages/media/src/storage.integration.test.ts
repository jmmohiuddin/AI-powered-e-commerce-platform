import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { prepareImage } from './image';
import { diskStorage, s3Storage, type MediaStorage } from './storage';

/**
 * OBJECT STORAGE — against real MinIO.
 *
 * A hand-rolled SigV4 signer either works against a real S3 implementation or
 * it does not; there is no partial credit and no unit test that can tell you
 * which. So this suite performs the actual round trip a merchant's upload
 * performs — sign, PUT, fetch back anonymously the way `next/image` will,
 * delete — and asserts the bytes survived it.
 *
 * It runs the *same* assertions against the disk driver, because the point of
 * the interface is that a deployment gets one or the other and both have to
 * behave identically. A dev driver that nobody tests is a dev driver that is
 * broken the first time someone clones the repo without Docker.
 */

const ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:9000';
const BUCKET = process.env.S3_BUCKET ?? 'voltix-media';

async function minioAvailable(): Promise<boolean> {
  try {
    // MinIO answers this unauthenticated; a connection refusal means no server.
    const response = await fetch(`${ENDPOINT}/minio/health/live`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** A real photograph's worth of bytes, carrying the metadata we must destroy. */
async function photograph(): Promise<Uint8Array> {
  const buffer = await sharp({
    create: { width: 1600, height: 1200, channels: 3, background: '#2f6f4f' },
  })
    .withExif({
      IFD0: { Make: 'ProofPhone', Model: 'Stock Cupboard' },
      // IFD3 is the GPS directory in sharp's EXIF mapping.
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '25/1 12/1 0/1', GPSLongitudeRef: 'E' },
    })
    .jpeg()
    .toBuffer();
  return new Uint8Array(buffer);
}

const available = await minioAvailable();
if (!available) {
  console.warn('\n  ⚠ MinIO unreachable — S3 storage tests skipped. Run `npm run infra:up`.\n');
}
const s3Suite = available ? describe : describe.skip;

s3Suite('s3Storage against MinIO', () => {
  const storage = s3Storage({
    endpoint: ENDPOINT,
    region: process.env.S3_REGION ?? 'auto',
    bucket: BUCKET,
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'voltix',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'voltix_dev_password',
    publicBaseUrl: `${ENDPOINT}/${BUCKET}`,
  });
  const written: string[] = [];

  afterAll(async () => {
    await Promise.all(written.map((key) => storage.remove(key).catch(() => {})));
  });

  it('stores an object the storefront can then fetch anonymously', async () => {
    const prepared = await prepareImage(await photograph());
    const key = `products/test-${Date.now()}/main.${prepared.extension}`;
    written.push(key);

    const stored = await storage.put(key, prepared.body, prepared.contentType);
    expect(stored.url).toBe(`${ENDPOINT}/${BUCKET}/${key}`);

    // No credentials on this request — exactly what the image optimiser does.
    const fetched = await fetch(stored.url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe(prepared.contentType);

    const bytes = new Uint8Array(await fetched.arrayBuffer());
    expect(bytes.byteLength).toBe(prepared.body.byteLength);
    // The privacy property has to hold on the bytes actually being served, not
    // just on the ones we handed to `put`.
    expect((await sharp(bytes).metadata()).exif).toBeUndefined();
  });

  it('deletes an object, and reports the key back from its own URL', async () => {
    const prepared = await prepareImage(await photograph());
    const key = `products/test-${Date.now()}/delete-me.${prepared.extension}`;

    const stored = await storage.put(key, prepared.body, prepared.contentType);
    expect(storage.keyFor(stored.url)).toBe(key);
    expect((await fetch(stored.url)).status).toBe(200);

    await storage.remove(key);
    expect((await fetch(stored.url)).status).toBe(404);
  });

  it('reports a bad key rather than pretending the upload succeeded', async () => {
    const wrong = s3Storage({
      endpoint: ENDPOINT,
      region: 'auto',
      bucket: BUCKET,
      accessKeyId: 'voltix',
      secretAccessKey: 'not-the-password',
    });

    await expect(wrong.put('products/nope.jpg', new Uint8Array([1, 2, 3]), 'image/jpeg')).rejects.toThrow(
      /S3 PUT/,
    );
  });
});

describe('diskStorage', () => {
  let directory: string;

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function storage(): Promise<MediaStorage> {
    directory ??= await mkdtemp(join(tmpdir(), 'voltix-media-'));
    return diskStorage({ directory, publicBaseUrl: '/uploads' });
  }

  it('satisfies the same contract as S3, on the filesystem', async () => {
    const disk = await storage();
    const prepared = await prepareImage(await photograph());
    const key = 'products/abc/main.jpg';

    const stored = await disk.put(key, prepared.body, prepared.contentType);
    expect(stored.url).toBe('/uploads/products/abc/main.jpg');
    expect(disk.keyFor(stored.url)).toBe(key);

    const onDisk = await readFile(join(directory, key));
    expect(new Uint8Array(onDisk).byteLength).toBe(prepared.body.byteLength);

    await disk.remove(key);
    await expect(readFile(join(directory, key))).rejects.toThrow();
    // Removing what is already gone must not throw — the media row is the
    // record of truth and a failed unlink must never strand it.
    await expect(disk.remove(key)).resolves.toBeUndefined();
  });

  it('refuses a key that would escape the storage root', async () => {
    const disk = await storage();
    await expect(disk.put('../../etc/passwd', new Uint8Array([1]), 'image/jpeg')).rejects.toThrow(
      /escapes storage root/,
    );
  });
});
