import { describe, expect, it } from 'vitest';
import { createResendTransport } from './resend';
import type { NotificationMessage } from '../port';

/**
 * The Resend transport against a stubbed endpoint.
 *
 * There is no sandbox key in this repo, so what is testable is the part that is
 * ours: the request we build and — the one that decides whether a customer ever
 * gets their receipt — which HTTP status is worth retrying. A 429 discarded as
 * permanent throws away a confirmation over a busy minute; an invalid address
 * retried forever burns the attempt budget and hides the real problem.
 *
 * The wire contract itself (endpoint, field names, the `id` in the response) is
 * unverified here and can only be confirmed against a real key.
 */

const message: NotificationMessage = {
  channel: 'email',
  recipient: 'shopper@example.ae',
  locale: 'ar-AE',
  subject: 'تم تأكيد طلبك',
  text: 'plain text body',
  html: '<p>rich body</p>',
};

/** Captures the outgoing request and replies with whatever the test dictates. */
function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function transport() {
  return createResendTransport({ apiKey: 'test-key', from: 'Voltix <orders@voltix.ae>' });
}

describe('resend transport', () => {
  it('sends both body parts and returns the provider message id', async () => {
    const stub = stubFetch(200, { id: 'msg_123' });
    try {
      const result = await transport().send(message);

      expect(result).toMatchObject({ ok: true, provider: 'resend', providerMessageId: 'msg_123' });
      const body = JSON.parse(String(stub.calls[0]!.init.body));
      expect(body.to).toEqual(['shopper@example.ae']);
      // The frozen text part goes with it rather than letting Resend synthesise
      // one — a generated plain-text version of an RTL receipt is not the copy
      // the outbox recorded as having been sent.
      expect(body.text).toBe('plain text body');
      expect(body.html).toBe('<p>rich body</p>');
    } finally {
      stub.restore();
    }
  });

  it('treats a rejected address as permanent and a rate limit as transient', async () => {
    const rejected = stubFetch(422, { message: 'Invalid `to` field' });
    try {
      const result = await transport().send(message);
      expect(result.ok).toBe(false);
      expect(result.permanent).toBe(true);
      expect(result.error).toContain('Invalid');
    } finally {
      rejected.restore();
    }

    for (const status of [429, 500, 503]) {
      const throttled = stubFetch(status, { message: 'later' });
      try {
        expect((await transport().send(message)).permanent).toBe(false);
      } finally {
        throttled.restore();
      }
    }
  });

  it('treats a network failure as transient rather than losing the message', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('ECONNRESET'); }) as typeof globalThis.fetch;
    try {
      const result = await transport().send(message);
      expect(result).toMatchObject({ ok: false, provider: 'resend' });
      expect(result.permanent).toBeFalsy();
    } finally {
      globalThis.fetch = original;
    }
  });
});
