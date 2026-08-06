import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeConnections, dbAdmin, ping } from '@voltix/db';
import { dispatchNotifications, insertNotification } from './dispatch';
import { TransportRegistry, type NotificationTransport, type SendResult } from './port';
import type { RenderedNotification } from './templates';

/**
 * The outbox lifecycle against real Postgres, with a fake transport so no mail
 * actually leaves the machine. The transport is where the send *decision* lives
 * (ok / permanent-fail / transient-fail), and these tests drive each branch to
 * prove the row lands in the right terminal state — which is the part that,
 * wrong, either drops a customer's receipt or spams them with retries.
 */

const reachable = await ping().catch(() => false);
const suite = reachable ? describe : describe.skip;
if (!reachable) console.warn('\n  ⚠ Postgres unreachable — notification dispatch tests skipped.\n');

const TENANT = '01920000-0000-7000-8000-000000000001';
const rendered: RenderedNotification = {
  channel: 'email',
  subject: 'Test',
  text: 'Body text',
  html: null,
};

/** A transport whose behaviour each test dictates, recording every call. */
function fakeTransport(
  channel: NotificationTransport['channel'],
  respond: () => SendResult,
): NotificationTransport & { calls: number } {
  const t = {
    channel,
    name: 'fake',
    calls: 0,
    async send(): Promise<SendResult> {
      t.calls += 1;
      return respond();
    },
  };
  return t;
}

function registryWith(transport: NotificationTransport): TransportRegistry {
  return new TransportRegistry().register(transport);
}

async function enqueue(dedupeKey: string, overrides: Partial<Parameters<typeof insertNotification>[1]> = {}) {
  await dbAdmin().transaction((tx) =>
    insertNotification(tx, {
      tenantId: TENANT,
      channel: 'email',
      recipient: 'test@example.ae',
      locale: 'en-AE',
      template: 'order.confirmation',
      rendered,
      dedupeKey,
      ...overrides,
    }),
  );
}

async function statusOf(dedupeKey: string): Promise<{ status: string; attempts: number; provider: string | null; sent_at: Date | null } | undefined> {
  const rows = await dbAdmin().execute<{ status: string; attempts: number; provider: string | null; sent_at: Date | null }>(
    sql`SELECT status, attempts, provider, sent_at FROM notifications WHERE dedupe_key = ${dedupeKey}`,
  );
  return rows.rows[0];
}

suite('notification dispatch', () => {
  afterEach(async () => {
    await dbAdmin().execute(sql`DELETE FROM notifications WHERE dedupe_key LIKE 'test:%'`);
  });
  afterAll(async () => {
    if (reachable) await closeConnections();
  });

  it('sends a pending row and marks it sent with the provider recorded', async () => {
    await enqueue('test:ok');
    const transport = fakeTransport('email', () => ({ ok: true, provider: 'fake', providerMessageId: 'abc' }));

    const result = await dispatchNotifications(dbAdmin(), registryWith(transport), { limit: 10 });

    expect(transport.calls).toBe(1);
    expect(result.sent).toBeGreaterThanOrEqual(1);
    const row = await statusOf('test:ok');
    expect(row?.status).toBe('sent');
    expect(row?.provider).toBe('fake');
    expect(row?.sent_at).not.toBeNull();
  });

  it('is idempotent on dedupe key — a message is queued exactly once', async () => {
    await enqueue('test:dupe');
    await enqueue('test:dupe'); // second attempt is a no-op
    const count = await dbAdmin().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM notifications WHERE dedupe_key = 'test:dupe'`,
    );
    expect(Number(count.rows[0]!.n)).toBe(1);
  });

  it('does not dispatch a draft — marketing waits for approval', async () => {
    await enqueue('test:draft', { status: 'draft' });
    const transport = fakeTransport('email', () => ({ ok: true, provider: 'fake' }));

    await dispatchNotifications(dbAdmin(), registryWith(transport), { limit: 10 });

    expect(transport.calls).toBe(0);
    expect((await statusOf('test:draft'))?.status).toBe('draft');
  });

  it('marks a permanent failure failed and does not retry it', async () => {
    await enqueue('test:perm');
    const transport = fakeTransport('email', () => ({ ok: false, provider: 'fake', error: 'bad address', permanent: true }));

    await dispatchNotifications(dbAdmin(), registryWith(transport), { limit: 10 });
    const first = await statusOf('test:perm');
    expect(first?.status).toBe('failed');

    // A second pass must not touch a failed row.
    await dispatchNotifications(dbAdmin(), registryWith(transport), { limit: 10 });
    expect(transport.calls).toBe(1);
  });

  it('retries a transient failure until attempts are exhausted, then fails', async () => {
    // maxAttempts 2, always-transient transport: pass 1 → back to pending,
    // pass 2 → attempts hit the ceiling → failed. Never silently sent.
    await enqueue('test:transient', { maxAttempts: 2 });
    const transport = fakeTransport('email', () => ({ ok: false, provider: 'fake', error: 'timeout' }));

    await dispatchNotifications(dbAdmin(), registryWith(transport), { limit: 10 });
    expect((await statusOf('test:transient'))?.status).toBe('pending');

    await dispatchNotifications(dbAdmin(), registryWith(transport), { limit: 10 });
    const row = await statusOf('test:transient');
    expect(row?.status).toBe('failed');
    expect(row?.attempts).toBe(2);
    expect(transport.calls).toBe(2);
  });

  it('suppresses a row whose channel has no transport rather than looping forever', async () => {
    await enqueue('test:nochan', { channel: 'sms', recipient: '+971500000000' });
    // Registry has only email — nothing for sms.
    const transport = fakeTransport('email', () => ({ ok: true, provider: 'fake' }));

    const result = await dispatchNotifications(dbAdmin(), registryWith(transport), { limit: 10 });

    expect(result.suppressed).toBeGreaterThanOrEqual(1);
    expect((await statusOf('test:nochan'))?.status).toBe('suppressed');
  });

  it('does nothing to an empty recipient — a row is never even written', async () => {
    await enqueue('test:norecipient', { recipient: '' });
    expect(await statusOf('test:norecipient')).toBeUndefined();
  });
});
