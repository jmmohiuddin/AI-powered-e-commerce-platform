import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { DomainError } from '@voltix/core';
import { MAX_UPLOAD_BYTES, prepareImage } from './image';

/**
 * Rejections are asserted on both messages. `message` is what an engineer reads
 * in a log and `publicMessage` is what the merchant reads on the form, and the
 * whole point of the split is that they say different things — a test that only
 * looks at one of them lets the other rot.
 */
async function rejection(input: Uint8Array): Promise<DomainError> {
  try {
    await prepareImage(input);
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('Expected prepareImage to reject, but it resolved.');
}

/**
 * The EXIF case is the one that matters most and is the easiest to break
 * silently: nothing about the rendered page changes if the GPS tag survives.
 * So the fixture is built *with* location metadata and the assertion is that
 * the output has no EXIF block at all, not that some particular tag is absent.
 */
/** `IFD3` is the GPS directory in sharp's EXIF mapping. */
const GPS_TAGS = {
  GPSLatitudeRef: 'N',
  GPSLatitude: '25/1 15/1 0/1',
  GPSLongitudeRef: 'E',
  GPSLongitude: '55/1 16/1 0/1',
} as const;

async function photo({ gps }: { gps: boolean }): Promise<Uint8Array> {
  const buffer = await sharp({
    create: { width: 800, height: 600, channels: 3, background: '#3355aa' },
  })
    .withExif({
      IFD0: { Make: 'Voltix', Model: 'Test Camera' },
      ...(gps ? { IFD3: { ...GPS_TAGS } } : {}),
    })
    .jpeg()
    .toBuffer();
  return new Uint8Array(buffer);
}

const photoWithGps = () => photo({ gps: true });

async function opaque(width: number, height: number): Promise<Uint8Array> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: '#cc4422' },
  })
    .jpeg()
    .toBuffer();
  return new Uint8Array(buffer);
}

describe('prepareImage', () => {
  it('strips EXIF, including the GPS coordinates of the merchant’s home', async () => {
    const input = await photoWithGps();
    const withoutGps = await photo({ gps: false });

    const inputExif = (await sharp(input).metadata()).exif;
    const baselineExif = (await sharp(withoutGps).metadata()).exif;

    // Proves the fixture really carries location data rather than just *some*
    // EXIF — otherwise this test would pass against an image that never had
    // coordinates in it, which is the failure mode that matters.
    expect(inputExif).toBeDefined();
    expect(baselineExif).toBeDefined();
    expect(inputExif!.byteLength).toBeGreaterThan(baselineExif!.byteLength);

    const prepared = await prepareImage(input);

    expect((await sharp(prepared.body).metadata()).exif).toBeUndefined();
  });

  it('reports the dimensions of what it stored and a usable blur placeholder', async () => {
    const prepared = await prepareImage(await opaque(800, 600));

    expect(prepared.width).toBe(800);
    expect(prepared.height).toBe(600);
    expect(prepared.contentType).toBe('image/jpeg');
    expect(prepared.extension).toBe('jpg');
    expect(prepared.blurDataUrl).toMatch(/^data:image\/webp;base64,/);
    // Inlined into the HTML of every tile, so it has to stay tiny.
    expect(prepared.blurDataUrl.length).toBeLessThan(2000);
  });

  it('caps the long edge without enlarging small images', async () => {
    const large = await prepareImage(await opaque(4000, 3000));
    expect(large.width).toBe(2400);
    expect(large.height).toBe(1800);

    const small = await prepareImage(await opaque(300, 200));
    expect(small.width).toBe(300);
    expect(small.height).toBe(200);
  });

  it('keeps transparency by choosing WebP over JPEG', async () => {
    const png = await sharp({
      create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();

    const prepared = await prepareImage(new Uint8Array(png));

    expect(prepared.contentType).toBe('image/webp');
    expect(prepared.extension).toBe('webp');
    expect((await sharp(prepared.body).metadata()).hasAlpha).toBe(true);
  });

  it('refuses SVG, which is markup and could carry script', async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    );

    const error = await rejection(svg);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toBe('Rejected image format: svg');
    // The merchant is told what to do instead, not what the decoder called it.
    expect(error.publicMessage).toMatch(/SVG and GIF are not accepted/);
  });

  it('refuses a file that is not an image at all', async () => {
    const error = await rejection(new TextEncoder().encode('this is not an image'));
    expect(error.publicMessage).toMatch(/not an image we can read/);
  });

  it('refuses an empty upload and one over the size limit', async () => {
    expect((await rejection(new Uint8Array())).publicMessage).toMatch(/empty/i);

    const tooBig = await rejection(new Uint8Array(MAX_UPLOAD_BYTES + 1));
    expect(tooBig.publicMessage).toMatch(/under 12 MB/);
    // The engineer-facing message keeps the exact figures; the merchant's does not.
    expect(tooBig.message).toContain(String(MAX_UPLOAD_BYTES + 1));
  });
});
