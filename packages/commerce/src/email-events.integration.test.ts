import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@voltix/db';
import { parseResendEmailEvent, verifySvixSignature } from '@voltix/notifications';
import { recordEmailProviderEvent } from './email-events';
import { runOnce, type JobHandler, type JobKind } from './jobs';
import {
  asTenant,
  closeTestPools,
  createFixture,
  databaseAvailable,
  ownerDb,
  type Fixture,
} from './test-support';

/**
 * WHAT HAPPENS AFTER "SENT".
 *
 * The outbox marks a row 'sent' the moment the provider's API accepts the
 * message, and until this path existed nothing ever revised that. A customer
 * whose mail server rejected their order confirmation looked, on every admin
 * screen, exactly like one who read it — which is the same silent-success
 * failure the Resend transport was written to fix, one step further down.
 *
 * These tests drive the whole sequence the route drives, in order: a genuinely
 * signed Svix event, verified by the real verifier, parsed by the real parser,
 * recorded through the real ingress, applied by the real job handler against
 * real Postgres. No Resend credentials exist here, which is exactly why the
 * signature is computed rather than mocked — the same approach the payment
 * webhook suite takes.
 */

const available = await databaseAvailable();
const suite = available ? describe : describe.skip;

if (!available) {
  console.warn(
    '\n  ⚠ Postgres unreachable — email webhook integration tests skipped.\n' +
      '    Run `npm run infra:up && npm run db:migrate` to enable them.\n',
  );
}

const SECRET = 'whsec_ZW1haWx3ZWJob29rdGVzdHNlY3JldA==';

/** A real Svix-signed delivery, signed the way Resend signs one. */
function signedEvent(event: unknown, messageId: string) {
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(SECRET.slice('whsec_'.length), 'base64');
  const signature = createHmac('sha256', key)
    .update(`${messageId}.${timestamp}.${body}`)
    .digest('base64');
  return {
    body,
    headers: {
      'svix-id': messageId,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
    },
  };
}

suite('email delivery webhook', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture('emailhook');
  });

  afterAll(async () => {
    await ownerDb().execute(sql`DELETE FROM notifications WHERE tenant_id = ${f.tenantId}`);
    await ownerDb().execute(sql`DELETE FROM jobs WHERE tenant_id = ${f.tenantId}`);
    await f.cleanup();
    await closeTestPools();
  });

  /**
   * A message the outbox has already handed to Resend: status 'sent', with the
   * provider's id recorded — which is the only handle a webhook arriving
   * minutes later has on it.
   */
  async function sentMessage(
    recipient: string,
    providerMessageId: string,
  ): Promise<string> {
    const id = uuidv7();
    await ownerDb().execute(sql`
      INSERT INTO notifications
        (id, tenant_id, channel, recipient, locale, template, subject, body_text,
         status, attempts, max_attempts, provider, provider_message_id, sent_at,
         created_at, updated_at)
      VALUES (${id}, ${f.tenantId}, 'email', ${recipient}, 'en-AE', 'order.confirmation',
              'Your order', 'Thanks for your order.', 'sent', 1, 3, 'resend',
              ${providerMessageId}, now(), now(), now())
    `);
    return id;
  }

  /** The route's own sequence: verify, parse, record. */
  async function ingest(event: unknown, messageId: string) {
    const { body, headers } = signedEvent(event, messageId);

    const verification = verifySvixSignature(body, headers, SECRET);
    expect(verification.valid).toBe(true);
    if (!verification.valid) throw new Error('unreachable');

    const parsed = parseResendEmailEvent(body);
    if (!parsed) throw new Error('event was not parseable');

    return asTenant(f.tenantId, (tx) =>
      recordEmailProviderEvent(tx, f.ctx, 'resend', verification.messageId, parsed),
    );
  }

  /**
   * Drains the queue until this delivery has been applied.
   *
   * Asserts on the job row rather than on `runOnce`'s counters: the queue is
   * shared with every other suite in the run, so an aggregate count is a claim
   * about whatever happened to be in the batch.
   */
  async function drain(messageId: string): Promise<void> {
    const dedupeKey = `email-webhook:resend:${messageId}`;
    const done = async () => {
      const rows = await ownerDb().execute<{ status: string }>(
        sql`SELECT status FROM jobs WHERE dedupe_key = ${dedupeKey}`,
      );
      return rows.rows[0]?.status === 'succeeded';
    };

    // Nothing here should send anything; the outbox handler is stubbed out so a
    // neighbouring queued message cannot reach for the network.
    const handlers: Partial<Record<JobKind, JobHandler>> = { 'notifications.send': async () => {} };

    for (let pass = 0; pass < 10 && !(await done()); pass += 1) {
      await runOnce(ownerDb(), 'worker-email-webhook-test', { limit: 100, handlers });
    }

    if (!(await done())) {
      const rows = await ownerDb().execute<{ status: string; last_error: string | null }>(
        sql`SELECT status, last_error FROM jobs WHERE dedupe_key = ${dedupeKey}`,
      );
      throw new Error(
        `delivery ${messageId} was never applied — job ${rows.rows[0]?.status ?? 'missing'}: ${
          rows.rows[0]?.last_error ?? 'no error recorded'
        }`,
      );
    }
  }

  async function notificationRow(id: string) {
    const rows = await ownerDb().execute<{ status: string; last_error: string | null }>(
      sql`SELECT status, last_error FROM notifications WHERE id = ${id}`,
    );
    return rows.rows[0]!;
  }

  function bounceEvent(emailId: string, type: string, subType = 'General') {
    return {
      type: 'email.bounced',
      created_at: new Date().toISOString(),
      data: {
        email_id: emailId,
        to: ['bounced@example.com'],
        subject: 'Your order',
        bounce: { type, subType, message: 'mailbox unavailable' },
      },
    };
  }

  /**
   * The test the whole feature exists for. Before this, the row below stayed
   * 'sent' forever and the customer's silence was the only signal.
   */
  it('turns a hard bounce into a failed message the admin can see', async () => {
    const emailId = `rsnd_hard_${f.tenantId.slice(-8)}`;
    const messageId = `msg_hard_${f.tenantId.slice(-8)}`;
    const notificationId = await sentMessage('nobody@example.com', emailId);

    expect((await notificationRow(notificationId)).status).toBe('sent');

    const { duplicate } = await ingest(bounceEvent(emailId, 'Permanent', 'Suppressed'), messageId);
    expect(duplicate).toBe(false);

    await drain(messageId);

    const row = await notificationRow(notificationId);
    // 'failed' is what the admin Messages screen lists alongside drafts — the
    // whole point of writing it.
    expect(row.status).toBe('failed');
    // And a reason specific enough to act on, not just "it failed".
    expect(row.last_error).toContain('Hard bounce');
    expect(row.last_error).toContain('Permanent/Suppressed');
    expect(row.last_error).toContain('mailbox unavailable');
  });

  /**
   * A deferral is not a rejection — the provider may still deliver it. Marking
   * it failed would put a message on the operator's work list that has not
   * finished failing yet.
   */
  it('records a soft bounce without declaring the message failed', async () => {
    const emailId = `rsnd_soft_${f.tenantId.slice(-8)}`;
    const messageId = `msg_soft_${f.tenantId.slice(-8)}`;
    const notificationId = await sentMessage('deferred@example.com', emailId);

    await ingest(bounceEvent(emailId, 'Transient', 'MailboxFull'), messageId);
    await drain(messageId);

    const row = await notificationRow(notificationId);
    expect(row.status).toBe('sent');
    expect(row.last_error).toContain('Soft bounce');
  });

  /**
   * Providers redeliver aggressively, and a bounce applied twice must be
   * indistinguishable from one applied once. The unique index on
   * `jobs.dedupe_key` is what makes that a database guarantee rather than a
   * hope about Resend's retry behaviour.
   */
  it('answers a redelivery without queueing the work twice', async () => {
    const emailId = `rsnd_dup_${f.tenantId.slice(-8)}`;
    const messageId = `msg_dup_${f.tenantId.slice(-8)}`;
    await sentMessage('dup@example.com', emailId);

    const first = await ingest(bounceEvent(emailId, 'Permanent'), messageId);
    const second = await ingest(bounceEvent(emailId, 'Permanent'), messageId);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);

    const jobs = await ownerDb().execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM jobs
      WHERE dedupe_key = ${`email-webhook:resend:${messageId}`}
    `);
    expect(Number(jobs.rows[0]!.n)).toBe(1);
  });

  /**
   * A spam complaint withdraws consent to marketing and nothing else.
   *
   * A shop that stopped confirming orders because someone once pressed "spam"
   * would have turned a marketing complaint into a customer with no receipt —
   * worse for that customer than the thing they complained about.
   */
  it('suppresses marketing on a complaint but leaves transactional mail alone', async () => {
    const emailId = `rsnd_spam_${f.tenantId.slice(-8)}`;
    const messageId = `msg_spam_${f.tenantId.slice(-8)}`;
    const address = `complainer-${f.tenantId.slice(-8)}@example.com`;
    const customerId = uuidv7();

    await ownerDb().execute(sql`
      INSERT INTO customers (id, tenant_id, email, phone, accepts_marketing_email,
                             accepts_marketing_whatsapp, created_at, updated_at)
      VALUES (${customerId}, ${f.tenantId}, ${address}, '+971500000001', true, true, now(), now())
    `);

    const notificationId = await sentMessage(address, emailId);

    await ingest(
      { type: 'email.complained', created_at: new Date().toISOString(), data: { email_id: emailId, to: [address] } },
      messageId,
    );
    await drain(messageId);

    const customer = await ownerDb().execute<{
      accepts_marketing_email: boolean;
      accepts_marketing_whatsapp: boolean;
    }>(sql`
      SELECT accepts_marketing_email, accepts_marketing_whatsapp
      FROM customers WHERE id = ${customerId}
    `);

    expect(customer.rows[0]!.accepts_marketing_email).toBe(false);
    // The complaint was about email. It says nothing about WhatsApp, and
    // silently revoking a channel the customer never complained about would be
    // its own kind of wrong.
    expect(customer.rows[0]!.accepts_marketing_whatsapp).toBe(true);

    // The message WAS delivered — the recipient read enough of it to press a
    // button — so the outbox row is not a failure and must not be recast as one.
    expect((await notificationRow(notificationId)).status).toBe('sent');
  });

  /**
   * Events arrive for mail this store did not put in its outbox: a dashboard
   * test send, or a message whose row has been pruned. Throwing would retry it
   * five times and dead-letter it, turning somebody else's housekeeping into an
   * alert a human has to dismiss.
   */
  it('shrugs off an event for a message it has never heard of', async () => {
    const messageId = `msg_orphan_${f.tenantId.slice(-8)}`;
    await ingest(bounceEvent(`rsnd_missing_${f.tenantId.slice(-8)}`, 'Permanent'), messageId);

    // Completes rather than dead-letters — `drain` throws if it does not.
    await drain(messageId);
  });

  /**
   * A bounce for another tenant's message must not reach across and mark it
   * failed. The ingress records the delivery under the tenant that received the
   * webhook, and the worker scopes its write to that tenant.
   */
  it('cannot mark another tenant’s message failed', async () => {
    const other = await createFixture('emailhook-other');
    try {
      const emailId = `rsnd_cross_${other.tenantId.slice(-8)}`;
      const messageId = `msg_cross_${other.tenantId.slice(-8)}`;

      const foreignId = uuidv7();
      await ownerDb().execute(sql`
        INSERT INTO notifications
          (id, tenant_id, channel, recipient, locale, template, subject, body_text,
           status, attempts, max_attempts, provider, provider_message_id, sent_at,
           created_at, updated_at)
        VALUES (${foreignId}, ${other.tenantId}, 'email', 'victim@example.com', 'en-AE',
                'order.confirmation', 'Your order', 'Thanks.', 'sent', 1, 3, 'resend',
                ${emailId}, now(), now(), now())
      `);

      // Delivered to *our* tenant's endpoint, naming *their* message id.
      await ingest(bounceEvent(emailId, 'Permanent'), messageId);
      await drain(messageId);

      const rows = await ownerDb().execute<{ status: string }>(
        sql`SELECT status FROM notifications WHERE id = ${foreignId}`,
      );
      expect(rows.rows[0]!.status).toBe('sent');

      await ownerDb().execute(sql`DELETE FROM notifications WHERE tenant_id = ${other.tenantId}`);
      await ownerDb().execute(sql`DELETE FROM jobs WHERE tenant_id = ${other.tenantId}`);
    } finally {
      await other.cleanup();
    }
  });
});
