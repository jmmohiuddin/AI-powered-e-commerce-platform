import type { Metadata } from 'next';
import { sql } from 'drizzle-orm';
import { withTenant } from '@voltix/db';
import { requirePermission } from '../../lib/auth';
import { can } from '../../lib/auth';
import { MessageRowActions } from './row-actions';

export const metadata: Metadata = { title: 'Messages' };
export const dynamic = 'force-dynamic';

interface MessageRow {
  readonly id: string;
  readonly channel: string;
  readonly recipient: string;
  readonly template: string;
  readonly subject: string | null;
  readonly bodyText: string;
  readonly status: string;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly sentAt: string | null;
}

/**
 * The message outbox: drafts awaiting approval first, then failures, then the
 * recent sent history.
 *
 * This screen is the second half of a promise the dashboard makes — "nothing is
 * sent to a customer without a human approving it first". The first half is the
 * outbox writing marketing messages as drafts; this is where the human actually
 * approves them. Without this page that promise was structurally true but
 * practically empty, because no one could act on a draft at all.
 */
export default async function MessagesPage() {
  const session = await requirePermission('campaign:read');
  const canSend = await can('campaign:send');

  const rows = await withTenant(session.tenantId, (tx) =>
    tx.execute<{
      id: string;
      channel: string;
      recipient: string;
      template: string;
      subject: string | null;
      body_text: string;
      status: string;
      last_error: string | null;
      created_at: Date | string;
      sent_at: Date | string | null;
    }>(sql`
      SELECT id, channel, recipient, template, subject, body_text, status, last_error,
             created_at, sent_at
      FROM notifications
      WHERE tenant_id = ${session.tenantId}
      ORDER BY
        -- Work first, history second: drafts need a decision, failures need a
        -- look, and everything else is reference material.
        CASE status WHEN 'draft' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,
        created_at DESC
      LIMIT 100
    `),
  );

  const messages: MessageRow[] = rows.rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    recipient: r.recipient,
    template: r.template,
    subject: r.subject,
    bodyText: r.body_text,
    status: r.status,
    lastError: r.last_error,
    createdAt: formatDate(r.created_at),
    sentAt: r.sent_at ? formatDate(r.sent_at) : null,
  }));

  const drafts = messages.filter((m) => m.status === 'draft');
  const failed = messages.filter((m) => m.status === 'failed');
  const rest = messages.filter((m) => m.status !== 'draft' && m.status !== 'failed');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Messages</h1>
          <p>
            Everything the store has sent or wants to send — order confirmations, recovery
            messages, alerts.
          </p>
        </div>
      </div>

      {drafts.length > 0 && (
        <>
          <h2 className="section-title">Awaiting your approval</h2>
          <div className="stack-md">
            {drafts.map((m) => (
              <div key={m.id} className="card message">
                <div className="message__meta">
                  <span className="pill pill--warn">draft</span>
                  <span className="pill pill--neutral">{m.channel}</span>
                  <span>{m.recipient}</span>
                  <span className="muted">{m.createdAt}</span>
                </div>
                {m.subject && <strong>{m.subject}</strong>}
                {/* The full rendered copy, not a summary. Approving a message
                    you have not read is not approval. */}
                <pre className="message__body">{m.bodyText}</pre>
                {canSend ? (
                  <MessageRowActions id={m.id} kind="draft" />
                ) : (
                  <p className="muted">Approving needs the campaign send permission.</p>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {failed.length > 0 && (
        <>
          <h2 className="section-title">Failed</h2>
          <div className="stack-md">
            {failed.map((m) => (
              <div key={m.id} className="card message">
                <div className="message__meta">
                  <span className="pill pill--danger">failed</span>
                  <span className="pill pill--neutral">{m.channel}</span>
                  <span>{m.recipient}</span>
                  <span className="muted">{m.createdAt}</span>
                </div>
                {m.subject && <strong>{m.subject}</strong>}
                {m.lastError && <p className="message__error">{m.lastError}</p>}
                {canSend && <MessageRowActions id={m.id} kind="failed" />}
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="section-title">Recent</h2>
      {rest.length === 0 ? (
        <div className="card">
          <p className="muted">
            Nothing sent yet. Confirmations are queued automatically when an order is placed and
            sent by the background worker — <code>npm run worker</code> must be running.
          </p>
        </div>
      ) : (
        <div className="card table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Status</th>
                <th>Channel</th>
                <th>To</th>
                <th>Template</th>
                <th>Subject</th>
                <th>Sent</th>
              </tr>
            </thead>
            <tbody>
              {rest.map((m) => (
                <tr key={m.id}>
                  <td>
                    <span
                      className={`pill ${
                        m.status === 'sent'
                          ? 'pill--success'
                          : m.status === 'suppressed'
                            ? 'pill--neutral'
                            : 'pill--info'
                      }`}
                    >
                      {m.status}
                    </span>
                  </td>
                  <td>{m.channel}</td>
                  <td>{m.recipient}</td>
                  <td>{m.template}</td>
                  <td>{m.subject ?? '—'}</td>
                  <td>{m.sentAt ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function formatDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-AE', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Dubai',
  }).format(date);
}
