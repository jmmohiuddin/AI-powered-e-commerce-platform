/**
 * Unit tests for the noon integration.
 *
 * Nothing here touches the network. The client is exercised against a stubbed
 * `fetch`, which is the only way to assert the behaviour that actually matters
 * and cannot be observed from a live call: that a 200 carrying per-item
 * rejections is not treated as success.
 */

import { generateKeyPairSync, createVerify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoonSession, cookieHeaderFrom, createLoginAssertion } from './auth';
import { NoonClient } from './client';
import { NoonApiError, isOkStatus, partitionResults, toItemResult } from './errors';
import { loadNoonConfig, NOON_PRODUCTION_URL } from './config';
import { chunk, toMajorUnits } from './sync/batch';
import {
  ImplausiblePriceError,
  guardPrice,
  selectChangedPrices,
  toPricingItem,
  type DesiredPrice,
} from './sync/pricing';
import { selectChanged, toStockItems, type DesiredStock } from './sync/stock';
import {
  AttributeValidationError,
  contentHash,
  validateAttributes,
} from './sync/product';
import { sinceWithLap } from './sync/orders';
import type { CategoryAttribute, ProductUpsertRequest } from './client';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const config = {
  credentials: { keyId: 'key-123', privateKey, projectCode: 'proj-abc' },
  baseUrl: 'https://gateway.test',
  userAgent: 'VoltixTest/1.0',
  timeoutMs: 5_000,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe('login assertion', () => {
  it('is an RS256 JWT that verifies against the public key', () => {
    const token = createLoginAssertion('key-123', privateKey, new Date(1_700_000_000_000));
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    const [header, payload, signature] = parts as [string, string, string];

    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });

    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(claims.sub).toBe('key-123');
    expect(claims.iat).toBe(1_700_000_000);
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);

    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature, 'base64url'));
    expect(verified).toBe(true);
  });

  it('never reuses a jti, so a captured assertion cannot be replayed', () => {
    const a = createLoginAssertion('key-123', privateKey);
    const b = createLoginAssertion('key-123', privateKey);
    expect(a).not.toBe(b);
  });
});

describe('cookieHeaderFrom', () => {
  it('keeps the name=value pair and drops browser-only attributes', () => {
    const response = new Response(null, {
      headers: [
        ['set-cookie', 'session=abc123; Path=/; HttpOnly; Secure; SameSite=Lax'],
        ['set-cookie', 'csrf=xyz789; Path=/'],
      ],
    });
    expect(cookieHeaderFrom(response)).toBe('session=abc123; csrf=xyz789');
  });
});

// ---------------------------------------------------------------------------

describe('per-item status handling', () => {
  it('treats status_code OK as success and anything else as rejection', () => {
    expect(isOkStatus({ status_code: 'OK' })).toBe(true);
    expect(isOkStatus({ status_code: 'ok' })).toBe(true);
    expect(isOkStatus({ status_code: 'SKU_NOT_FOUND' })).toBe(false);
    // A missing status object means the endpoint reported nothing wrong.
    expect(isOkStatus(undefined)).toBe(true);
    // Numeric-only reporting: 0 is the gRPC OK code.
    expect(isOkStatus({ status_id: 0 })).toBe(true);
    expect(isOkStatus({ status_id: 5 })).toBe(false);
  });

  it('partitions a mixed batch', () => {
    const results = [
      toItemResult('a', { status_code: 'OK' }),
      toItemResult('b', { status_code: 'INVALID_SKU', message: 'unknown partner_sku' }),
    ];
    const { accepted, rejected } = partitionResults(results);

    expect(accepted.map((r) => r.key)).toEqual(['a']);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.message).toBe('unknown partner_sku');
  });
});

describe('NoonApiError.isRetryable', () => {
  it.each([
    [0, true, 'network failure'],
    [429, true, 'rate limited'],
    [500, true, 'server error'],
    [503, true, 'unavailable'],
    [400, false, 'malformed payload'],
    [403, false, 'forbidden'],
    [404, false, 'unknown resource'],
  ])('HTTP %i → %s (%s)', (status, expected) => {
    expect(new NoonApiError('x', status, null).isRetryable).toBe(expected);
  });
});

// ---------------------------------------------------------------------------

describe('NoonClient against a stubbed gateway', () => {
  function stubFetch(handler: (url: string, init: RequestInit) => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(handler(url, init));
    });
    return calls;
  }

  const loginResponse = () =>
    new Response(JSON.stringify({}), {
      status: 200,
      headers: [['set-cookie', 'session=live; Path=/; HttpOnly']],
    });

  it('logs in once, then carries the cookie on subsequent calls', async () => {
    const calls = stubFetch((url) => {
      if (url.includes('/identity/')) return loginResponse();
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });

    const client = new NoonClient(config);
    await client.updateStock([{ warehouse_code: 'WH1', partner_sku: 'A', qty: 1 }]);
    await client.updateStock([{ warehouse_code: 'WH1', partner_sku: 'B', qty: 2 }]);

    const logins = calls.filter((c) => c.url.includes('/identity/'));
    expect(logins).toHaveLength(1);
    expect(logins[0]?.url).toBe(`${config.baseUrl}/identity/public/v1/api/login`);

    const stockCalls = calls.filter((c) => c.url.includes('/stock/'));
    expect(stockCalls).toHaveLength(2);
    for (const call of stockCalls) {
      expect((call.init.headers as Record<string, string>).Cookie).toBe('session=live');
    }
  });

  it('re-authenticates once on a 401 and replays the call', async () => {
    let stockAttempts = 0;
    const calls = stubFetch((url) => {
      if (url.includes('/identity/')) return loginResponse();
      stockAttempts += 1;
      // The first call finds an expired session.
      if (stockAttempts === 1) return new Response('{}', { status: 401 });
      return new Response(
        JSON.stringify({
          items: [{ warehouse_code: 'WH1', partner_sku: 'A', status: { status_code: 'OK' } }],
        }),
        { status: 200 },
      );
    });

    const client = new NoonClient(config);
    const result = await client.updateStock([{ warehouse_code: 'WH1', partner_sku: 'A', qty: 5 }]);

    expect(result.accepted).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes('/identity/'))).toHaveLength(2);
    expect(stockAttempts).toBe(2);
  });

  it('surfaces a 401 that survives re-authentication rather than looping', async () => {
    stubFetch((url) => {
      if (url.includes('/identity/')) return loginResponse();
      return new Response('{}', { status: 401 });
    });

    const client = new NoonClient(config);
    await expect(
      client.updateStock([{ warehouse_code: 'WH1', partner_sku: 'A', qty: 1 }]),
    ).rejects.toMatchObject({ name: 'NoonApiError', status: 401 });
  });

  it('does NOT treat a 200 with per-item rejections as success', async () => {
    stubFetch((url) => {
      if (url.includes('/identity/')) return loginResponse();
      return new Response(
        JSON.stringify({
          items: [
            { warehouse_code: 'WH1', partner_sku: 'GOOD', status: { status_code: 'OK' } },
            {
              warehouse_code: 'WH1',
              partner_sku: 'BAD',
              status: { status_code: 'SKU_NOT_FOUND', message: 'no such partner_sku' },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const client = new NoonClient(config);
    const result = await client.updateStock([
      { warehouse_code: 'WH1', partner_sku: 'GOOD', qty: 3 },
      { warehouse_code: 'WH1', partner_sku: 'BAD', qty: 4 },
    ]);

    expect(result.accepted.map((r) => r.key)).toEqual(['WH1/GOOD']);
    expect(result.rejected.map((r) => r.key)).toEqual(['WH1/BAD']);
    expect(result.rejected[0]?.message).toBe('no such partner_sku');
  });

  it('refuses a batch larger than the cap instead of letting noon truncate it', async () => {
    stubFetch(() => loginResponse());
    const client = new NoonClient(config);
    const oversized = Array.from({ length: 501 }, (_, i) => ({
      warehouse_code: 'WH1',
      partner_sku: `SKU-${i}`,
      qty: 1,
    }));

    await expect(client.updateStock(oversized)).rejects.toThrow(RangeError);
  });

  it('stops paginating when noon repeats a next_token', async () => {
    let pages = 0;
    stubFetch((url) => {
      if (url.includes('/identity/')) return loginResponse();
      pages += 1;
      // A gateway bug that echoes the same cursor forever.
      return new Response(JSON.stringify({ orders: [], next_token: 'same' }), { status: 200 });
    });

    const client = new NoonClient(config);
    await client.listAllOrders({ warehouse_code: 'WH1' });

    expect(pages).toBe(2);
  });

  it('fails a login that returns 200 with no cookie, rather than 401-looping', async () => {
    stubFetch(() => new Response('{}', { status: 200 }));
    const session = new NoonSession(config);
    await expect(session.post('/stock/v1/stock-update', {})).rejects.toThrow(/set no session cookie/);
  });
});

// ---------------------------------------------------------------------------

describe('unit conversion', () => {
  it('converts minor units to major for two-decimal currencies', () => {
    expect(toMajorUnits(129950, 2)).toBe(1299.5);
    expect(toMajorUnits(0, 2)).toBe(0);
    expect(toMajorUnits(1, 2)).toBe(0.01);
  });

  it('converts three-decimal GCC currencies with the right exponent', () => {
    // 1000 fils = 1 KWD. Treating it as exponent 2 would publish 10.00.
    expect(toMajorUnits(1000, 3)).toBe(1);
    expect(toMajorUnits(129950, 3)).toBe(129.95);
  });
});

describe('guardPrice', () => {
  it('accepts an ordinary electronics price', () => {
    expect(guardPrice('SKU', 1299.5, 'AED')).toBe(1299.5);
  });

  it('rejects zero, negatives and NaN', () => {
    expect(() => guardPrice('SKU', 0, 'AED')).toThrow(ImplausiblePriceError);
    expect(() => guardPrice('SKU', -5, 'AED')).toThrow(ImplausiblePriceError);
    expect(() => guardPrice('SKU', Number.NaN, 'AED')).toThrow(ImplausiblePriceError);
  });

  it('rejects the un-divided minor units of an expensive item on the absolute rule', () => {
    // A AED 1,299.50 phone sent as 129950 exceeds the 100,000 ceiling.
    expect(() => guardPrice('SKU', 129_950, 'AED')).toThrow(/outside the plausible range/);
  });

  it('rejects a 100x slip on a cheap accessory via the relative rule', () => {
    // AED 49 sent as 4,900 is plausible in isolation — only the comparison
    // against the last published price reveals it.
    expect(() => guardPrice('SKU', 4_900, 'AED', 49)).toThrow(/100× change/);
  });

  it('allows a steep but real discount', () => {
    // Half price, or even a 90% clearance, is well inside the fold limit.
    expect(guardPrice('SKU', 650, 'AED', 1_300)).toBe(650);
    expect(guardPrice('SKU', 130, 'AED', 1_300)).toBe(130);
  });

  it('applies only the absolute rule when nothing was ever published', () => {
    expect(guardPrice('SKU', 4_900, 'AED', null)).toBe(4_900);
  });
});

describe('toPricingItem', () => {
  const base: DesiredPrice = {
    listingId: 'l1',
    partnerSku: 'PHONE-1',
    countryCode: 'ae',
    price: 129950,
    msrp: 149900,
    currency: 'AED',
    pushedPrice: null,
    pushedMsrp: null,
  };

  it('sends major units and marks the offer active', () => {
    expect(toPricingItem(base)).toEqual({
      partner_sku: 'PHONE-1',
      country_code: 'ae',
      price: 1299.5,
      msrp: 1499,
      is_active: true,
    });
  });

  it('drops an MSRP that is not above the price, which noon would reject', () => {
    expect(toPricingItem({ ...base, msrp: 100000 }).msrp).toBeNull();
    expect(toPricingItem({ ...base, msrp: 129950 }).msrp).toBeNull();
    expect(toPricingItem({ ...base, msrp: null }).msrp).toBeNull();
  });
});

describe('change detection', () => {
  const stock = (available: number, pushedQty: number | null): DesiredStock => ({
    listingId: 'l1',
    partnerSku: 'A',
    warehouseCode: 'WH1',
    available,
    pushedQty,
  });

  it('sends a listing that has never been pushed', () => {
    expect(selectChanged([stock(5, null)])).toHaveLength(1);
  });

  it('skips a listing whose quantity noon already holds', () => {
    expect(selectChanged([stock(5, 5)])).toHaveLength(0);
  });

  it('sends a drop to zero — the case that must never be skipped', () => {
    expect(selectChanged([stock(0, 5)])).toHaveLength(1);
  });

  it('sends when only the MSRP changed', () => {
    const price: DesiredPrice = {
      listingId: 'l1',
      partnerSku: 'A',
      countryCode: 'ae',
      price: 1000,
      msrp: 2000,
      currency: 'AED',
      pushedPrice: 1000,
      pushedMsrp: 1500,
    };
    expect(selectChangedPrices([price])).toHaveLength(1);
  });
});

describe('toStockItems', () => {
  it('maps to noon field names', () => {
    expect(
      toStockItems([
        { listingId: 'l', partnerSku: 'A', warehouseCode: 'WH1', available: 7, pushedQty: 0 },
      ]),
    ).toEqual([{ warehouse_code: 'WH1', partner_sku: 'A', qty: 7 }]);
  });
});

describe('chunk', () => {
  it('splits to the requested size and keeps every element', () => {
    const items = Array.from({ length: 1050 }, (_, i) => i);
    const chunks = chunk(items, 500);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 50]);
    expect(chunks.flat()).toEqual(items);
  });

  it('returns nothing for an empty list', () => {
    expect(chunk([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('validateAttributes', () => {
  const attribute = (over: Partial<CategoryAttribute>): CategoryAttribute => ({
    attribute_code: 'colour',
    is_mandatory: false,
    is_facet: false,
    attribute_type: 'ATTRIBUTE_TYPE_TEXT',
    is_localizable: false,
    is_multivalued: false,
    attribute_options: [],
    attribute_metric_units: [],
    ...over,
  });

  it('names the missing mandatory attribute', () => {
    expect(() =>
      validateAttributes('elec_phones', {}, [
        attribute({ attribute_code: 'battery_capacity', is_mandatory: true }),
      ]),
    ).toThrow(/missing mandatory attribute "battery_capacity"/);
  });

  it('rejects a SELECT value outside the allowed options', () => {
    expect(() =>
      validateAttributes('elec_phones', { colour: 'Puce' }, [
        attribute({
          attribute_type: 'ATTRIBUTE_TYPE_SELECT',
          attribute_options: ['Black', 'White'],
        }),
      ]),
    ).toThrow(/is not one of Black, White/);
  });

  it('enforces numeric bounds', () => {
    const schema = [
      attribute({
        attribute_code: 'weight',
        attribute_type: 'ATTRIBUTE_TYPE_NUMERIC',
        number_min: 1,
        number_max: 100,
      }),
    ];
    expect(() => validateAttributes('c', { weight: 0 }, schema)).toThrow(/below the minimum/);
    expect(() => validateAttributes('c', { weight: 500 }, schema)).toThrow(/above the maximum/);
    expect(() => validateAttributes('c', { weight: 50 }, schema)).not.toThrow();
  });

  it('enforces text length limits rather than silently truncating', () => {
    expect(() =>
      validateAttributes('c', { colour: 'x'.repeat(300) }, [attribute({ max_characters: 255 })]),
    ).toThrow(/300 characters; the maximum is 255/);
  });

  it('reports every problem at once, not just the first', () => {
    try {
      validateAttributes('c', {}, [
        attribute({ attribute_code: 'a', is_mandatory: true }),
        attribute({ attribute_code: 'b', is_mandatory: true }),
      ]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AttributeValidationError);
      expect((error as AttributeValidationError).problems).toHaveLength(2);
    }
  });

  it('passes a payload that satisfies the schema', () => {
    expect(() =>
      validateAttributes('c', { colour: 'Black' }, [
        attribute({
          is_mandatory: true,
          attribute_type: 'ATTRIBUTE_TYPE_SELECT',
          attribute_options: ['Black'],
        }),
      ]),
    ).not.toThrow();
  });
});

describe('contentHash', () => {
  const request: ProductUpsertRequest = {
    skus: [{ partner_sku: 'A', size: null }],
    brand: 'Acme',
    category: 'elec_phones',
    images: [{ url: 'https://cdn.test/1.jpg', sort: 1 }],
    attributes: { colour: 'Black', storage: '256GB' },
  };

  it('is stable across key order, so a reordered read is not a false change', () => {
    const reordered: ProductUpsertRequest = {
      category: 'elec_phones',
      brand: 'Acme',
      attributes: { storage: '256GB', colour: 'Black' },
      images: [{ sort: 1, url: 'https://cdn.test/1.jpg' }],
      skus: [{ size: null, partner_sku: 'A' }],
    } as ProductUpsertRequest;

    expect(contentHash(reordered)).toBe(contentHash(request));
  });

  it('changes when the content genuinely changes', () => {
    expect(contentHash({ ...request, brand: 'Other' })).not.toBe(contentHash(request));
    expect(
      contentHash({ ...request, attributes: { colour: 'White', storage: '256GB' } }),
    ).not.toBe(contentHash(request));
  });
});

// ---------------------------------------------------------------------------

describe('sinceWithLap', () => {
  const now = new Date('2026-08-15T12:00:00Z');

  it('overlaps the previous window so an in-flight order cannot fall through', () => {
    const last = new Date('2026-08-15T11:55:00Z');
    expect(sinceWithLap(last, now).toISOString()).toBe('2026-08-15T11:45:00.000Z');
  });

  it('falls back to 24 hours on the very first run', () => {
    expect(sinceWithLap(null, now).toISOString()).toBe('2026-08-14T12:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------

describe('loadNoonConfig', () => {
  const env = {
    NOON_KEY_ID: 'k',
    NOON_PRIVATE_KEY: privateKey,
    NOON_PROJECT_CODE: 'p',
  } as NodeJS.ProcessEnv;

  it('defaults to the production gateway', () => {
    expect(loadNoonConfig(env).baseUrl).toBe(NOON_PRODUCTION_URL);
  });

  it('restores literal \\n in a PEM mangled by a secret manager', () => {
    const escaped = privateKey.replace(/\n/g, '\\n');
    const config = loadNoonConfig({ ...env, NOON_PRIVATE_KEY: escaped });
    expect(config.credentials.privateKey).toBe(privateKey.trim());
  });

  it('names the missing variables instead of authenticating with empty strings', () => {
    expect(() => loadNoonConfig({ NOON_KEY_ID: 'k' } as NodeJS.ProcessEnv)).toThrow(
      /NOON_PRIVATE_KEY, NOON_PROJECT_CODE/,
    );
  });

  it('rejects a private key that is not a PEM', () => {
    expect(() => loadNoonConfig({ ...env, NOON_PRIVATE_KEY: 'not-a-key' })).toThrow(
      /does not look like a PEM/,
    );
  });

  it('strips a trailing slash so paths do not double up', () => {
    expect(loadNoonConfig({ ...env, NOON_API_BASE_URL: 'https://x.test/' }).baseUrl).toBe(
      'https://x.test',
    );
  });
});
