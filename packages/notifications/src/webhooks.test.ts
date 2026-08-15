import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isHardBounce, parseResendEmailEvent, verifySvixSignature } from './webhooks';

/**
 * THE SIGNATURE CHECK IS THE WHOLE SECURITY BOUNDARY.
 *
 * This endpoint is unauthenticated and reachable by anyone, and what it does is
 * mark a customer's order confirmation failed. If the signature check is wrong
 * in either direction the consequences are immediate: too strict and every real
 * bounce is dropped, so the store is back to not knowing; too loose and a
 * stranger can flag any message they like.
 *
 * No Resend credentials exist in this environment, so the scheme is pinned to
 * the worked example published in Svix's own documentation
 * (docs.svix.com/receiving/verifying-payloads/how-manual). That vector is the
 * only test here that can catch an implementation which is internally
 * consistent and still not the scheme Resend actually signs with — the failure
 * mode a hand-rolled verifier is most likely to have.
 */

/** The published example, verbatim. */
const VECTOR = {
  // Svix's own published example secret. This test verifies the signature
  // implementation against the vendor's known-good vector — the same reason
  // the TOTP tests use the RFC 6238 vectors — so the value has to be theirs
  // verbatim. It is public documentation, not a credential of ours, and it is
  // allowlisted by fingerprint in .gitleaks.toml rather than by loosening the
  // rule. gitleaks:allow
  secret: 'whsec_plJ3nmyCDGBKInavdOK15jsl',
  payload: '{"event_type":"ping","data":{"success":true}}',
  messageId: 'msg_loFOjxBNrRLzqYUf',
  timestamp: '1731705121',
  signature: 'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=',
};

const SECRET = 'whsec_integration_test_secret_value';

function sign(
  body: string,
  options: { messageId?: string; timestamp?: number; secret?: string } = {},
): Record<string, string> {
  const messageId = options.messageId ?? 'msg_test_1';
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const secret = options.secret ?? SECRET;
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const signature = createHmac('sha256', key)
    .update(`${messageId}.${timestamp}.${body}`)
    .digest('base64');
  return {
    'svix-id': messageId,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${signature}`,
  };
}

describe('verifySvixSignature', () => {
  /**
   * The one assertion that proves this is Svix's scheme rather than a
   * self-consistent invention. Everything below tests behaviour; this tests
   * that the behaviour is the right behaviour.
   */
  it('accepts the signature from Svix’s published example', () => {
    const result = verifySvixSignature(
      VECTOR.payload,
      {
        'svix-id': VECTOR.messageId,
        'svix-timestamp': VECTOR.timestamp,
        'svix-signature': VECTOR.signature,
      },
      VECTOR.secret,
      // The example is from 2024, so the freshness window has to be stood down
      // to test the cryptography rather than the clock.
      { now: new Date(Number(VECTOR.timestamp) * 1000) },
    );

    expect(result).toEqual({ valid: true, messageId: VECTOR.messageId });
  });

  it('accepts a genuinely signed event', () => {
    const body = JSON.stringify({ type: 'email.bounced' });
    expect(verifySvixSignature(body, sign(body), SECRET)).toMatchObject({ valid: true });
  });

  /**
   * A byte changed anywhere in the body must invalidate it — this is what stops
   * an attacker taking a real bounce for their own address and swapping in
   * somebody else's message id.
   */
  it('rejects a tampered body', () => {
    const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 'a' } });
    const headers = sign(body);
    const tampered = JSON.stringify({ type: 'email.bounced', data: { email_id: 'b' } });

    expect(verifySvixSignature(tampered, headers, SECRET)).toMatchObject({
      valid: false,
      reason: 'no matching signature',
    });
  });

  /**
   * The body is signed together with the id and the timestamp, so re-signing
   * under a different id must not verify either — otherwise the idempotency key
   * would be attacker-chosen and a replay could be made to look new.
   */
  it('rejects a body signed under a different message id', () => {
    const body = JSON.stringify({ type: 'email.complained' });
    const headers = { ...sign(body, { messageId: 'msg_a' }), 'svix-id': 'msg_b' };
    expect(verifySvixSignature(body, headers, SECRET)).toMatchObject({ valid: false });
  });

  it('rejects a signature made with a different secret', () => {
    const body = '{}';
    const headers = sign(body, { secret: 'whsec_c29tZW90aGVyc2VjcmV0' });
    expect(verifySvixSignature(body, headers, SECRET)).toMatchObject({ valid: false });
  });

  /**
   * Without a freshness window a captured signature is a permanent forgery
   * token: one intercepted bounce could be replayed at the store forever.
   */
  it('rejects a replay from outside the tolerance window', () => {
    const body = '{}';
    const stale = Math.floor(Date.now() / 1000) - 6 * 60;
    expect(verifySvixSignature(body, sign(body, { timestamp: stale }), SECRET)).toMatchObject({
      valid: false,
      reason: 'timestamp outside tolerance',
    });
  });

  it('rejects a timestamp far in the future', () => {
    const body = '{}';
    const ahead = Math.floor(Date.now() / 1000) + 6 * 60;
    expect(verifySvixSignature(body, sign(body, { timestamp: ahead }), SECRET)).toMatchObject({
      valid: false,
    });
  });

  /**
   * Svix sends one signature per active signing key so a secret can be rotated
   * without dropping events mid-flight. A receiver that only reads the first
   * entry drops every event during the overlap.
   */
  it('accepts one valid signature among several', () => {
    const body = '{"type":"email.bounced"}';
    const headers = sign(body);
    const mine = headers['svix-signature']!;
    expect(
      verifySvixSignature(
        body,
        { ...headers, 'svix-signature': `v1,bm90aXQ= ${mine}` },
        SECRET,
      ),
    ).toMatchObject({ valid: true });
  });

  it('ignores signature versions it does not understand', () => {
    const body = '{}';
    const headers = { ...sign(body), 'svix-signature': 'v2,YW55dGhpbmc=' };
    expect(verifySvixSignature(body, headers, SECRET)).toMatchObject({ valid: false });
  });

  /** The vendor-neutral Standard Webhooks spelling of the same three headers. */
  it('reads the webhook-* header spelling', () => {
    const body = '{"type":"email.bounced"}';
    const svix = sign(body);
    expect(
      verifySvixSignature(
        body,
        {
          'webhook-id': svix['svix-id']!,
          'webhook-timestamp': svix['svix-timestamp']!,
          'webhook-signature': svix['svix-signature']!,
        },
        SECRET,
      ),
    ).toMatchObject({ valid: true });
  });

  it('refuses when there is no secret to verify against', () => {
    const body = '{}';
    expect(verifySvixSignature(body, sign(body), '')).toMatchObject({
      valid: false,
      reason: 'no webhook secret configured',
    });
  });

  it('refuses an unsigned request rather than treating it as unverifiable-but-fine', () => {
    expect(verifySvixSignature('{}', {}, SECRET)).toMatchObject({
      valid: false,
      reason: 'missing signature headers',
    });
  });
});

describe('parseResendEmailEvent', () => {
  const bounce = {
    type: 'email.bounced',
    created_at: '2026-11-22T23:41:12.126Z',
    data: {
      email_id: '56761188-7520-42d8-8898-ff6fc54ce618',
      to: ['someone@example.com'],
      subject: 'Your order',
      bounce: {
        type: 'Permanent',
        subType: 'Suppressed',
        message: "The recipient's email address is on the suppression list.",
      },
    },
  };

  it('reads the message id and the bounce classification', () => {
    expect(parseResendEmailEvent(JSON.stringify(bounce))).toEqual({
      type: 'email.bounced',
      providerMessageId: '56761188-7520-42d8-8898-ff6fc54ce618',
      bounceType: 'Permanent',
      bounceSubType: 'Suppressed',
      bounceMessage: "The recipient's email address is on the suppression list.",
    });
  });

  /**
   * The recipient is in the payload and must not survive the parse. It is
   * already on the notification row; a second copy would ride into the `jobs`
   * table, which today holds no personal data and is the thing most likely to
   * be dumped wholesale during an incident.
   */
  it('drops the recipient address rather than carrying it into the queue', () => {
    const parsed = JSON.stringify(parseResendEmailEvent(JSON.stringify(bounce)));
    expect(parsed).not.toContain('someone@example.com');
    expect(parsed).not.toContain('@');
  });

  it('reads a complaint, which carries no bounce block', () => {
    const complaint = {
      type: 'email.complained',
      data: { email_id: 'abc', to: ['x@example.com'] },
    };
    expect(parseResendEmailEvent(JSON.stringify(complaint))).toEqual({
      type: 'email.complained',
      providerMessageId: 'abc',
    });
  });

  it('ignores event types the store does not act on', () => {
    // Including email.delivered, which is deliberately not subscribed — see
    // the note on EmailEventType.
    expect(parseResendEmailEvent('{"type":"email.delivered","data":{"email_id":"a"}}')).toBeNull();
    expect(parseResendEmailEvent('{"type":"contact.created","data":{}}')).toBeNull();
  });

  /**
   * Without a message id there is no row to write back to. Guessing from the
   * subject or the recipient would eventually mark the wrong customer's
   * message failed, which is worse than ignoring the event.
   */
  it('ignores an event with no message id', () => {
    expect(parseResendEmailEvent('{"type":"email.bounced","data":{}}')).toBeNull();
  });

  it('survives a body that is not the JSON it claims to be', () => {
    expect(parseResendEmailEvent('not json')).toBeNull();
    expect(parseResendEmailEvent('null')).toBeNull();
    expect(parseResendEmailEvent('[]')).toBeNull();
    expect(parseResendEmailEvent('{"type":"email.bounced","data":"nope"}')).toBeNull();
  });
});

describe('isHardBounce', () => {
  it('treats a permanent rejection as final', () => {
    expect(isHardBounce('Permanent')).toBe(true);
  });

  it('leaves a deferral alone, because the provider may still deliver it', () => {
    expect(isHardBounce('Transient')).toBe(false);
  });

  /**
   * The asymmetry is deliberate: a message wrongly marked failed costs an
   * operator a glance, while one wrongly left 'sent' costs a customer their
   * confirmation and tells nobody.
   */
  it('treats an unclassifiable bounce as final rather than assuming delivery', () => {
    expect(isHardBounce('Undetermined')).toBe(true);
    expect(isHardBounce(undefined)).toBe(true);
  });
});
