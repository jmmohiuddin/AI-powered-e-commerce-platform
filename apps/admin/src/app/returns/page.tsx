import type { Metadata } from 'next';
import Link from 'next/link';
import { formatPrice } from '@voltix/ui';
import { requirePermission } from '../../lib/auth';
import { listReturns } from '../../lib/returns-queries';
import { ReturnActions } from './return-actions';

export const metadata: Metadata = { title: 'Returns' };
export const dynamic = 'force-dynamic';

/**
 * The returns desk.
 *
 * Ordered oldest-first, unlike every other list in this admin. A return that
 * has waited four days is the one costing goodwill, and newest-first is exactly
 * how the oldest never gets looked at. The age column is the point of the
 * screen, not decoration.
 *
 * Each row carries its own next action rather than linking to a detail page:
 * processing a return is a sequence of small confirmations — approve, mark
 * received, inspect, complete — and making someone open a page for each one is
 * how a queue of twenty becomes an afternoon.
 */
export default async function ReturnsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; all?: string }>;
}) {
  const session = await requirePermission('return:manage');
  const params = await searchParams;
  const showAll = params.all === '1';

  const result = await listReturns(session.tenantId, {
    status: params.status,
    open: !showAll && !params.status,
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Returns</h1>
          <p>
            {result.total} {result.total === 1 ? 'return' : 'returns'}
            {!showAll && !params.status ? ' needing attention' : ''}
          </p>
        </div>
        <Link className="pill pill--info" href={showAll ? '/returns' : '/returns?all=1'}>
          {showAll ? 'Show open only' : 'Show all'}
        </Link>
      </div>

      {result.rows.length === 0 ? (
        <div className="card">
          <p className="muted">
            {showAll || params.status
              ? 'No returns match that filter.'
              : 'Nothing waiting. Returns opened against an order appear here.'}
          </p>
        </div>
      ) : (
        <div className="stack-md">
          {result.rows.map((r) => (
            <div key={r.id} className="card">
              <div className="page-head" style={{ marginBottom: 'var(--space-3)' }}>
                <div>
                  <span className="cell-title">{r.number}</span>
                  <div className="kpi__note">
                    Order <Link href={`/orders/${r.orderNumber}`}>#{r.orderNumber}</Link>
                    {r.customerName ? ` · ${r.customerName}` : ''} · {r.itemCount}{' '}
                    {r.itemCount === 1 ? 'item' : 'items'}
                  </div>
                </div>
                <div className="page-head__status">
                  <span className={`pill ${statusTone(r.status)}`}>
                    {r.status.replace(/_/g, ' ')}
                  </span>
                  <span className="pill pill--neutral">{r.reason.replace(/_/g, ' ')}</span>
                  <span className="pill pill--neutral">{r.resolution.replace(/_/g, ' ')}</span>
                  {/* Ageing is the whole reason this list is sorted the way it
                      is, so it gets a colour rather than a quiet note. */}
                  {isOpen(r.status) && (
                    <span
                      className={`pill ${
                        r.ageDays >= 5 ? 'pill--danger' : r.ageDays >= 2 ? 'pill--warn' : 'pill--neutral'
                      }`}
                    >
                      {r.ageDays === 0 ? 'today' : `${r.ageDays}d old`}
                    </span>
                  )}
                </div>
              </div>

              <p className="muted" style={{ marginBottom: 'var(--space-3)' }}>
                {r.resolution === 'refund'
                  ? `Refund of ${formatPrice(r.refundAmount, r.currency)} when completed.`
                  : `${r.resolution.replace(/_/g, ' ')} — no money moves.`}
                {r.restockable === true && ' Inspected as resellable.'}
                {r.restockable === false && ' Inspected as not resellable — will not be restocked.'}
              </p>

              <ReturnActions id={r.id} status={r.status} resolution={r.resolution} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function isOpen(status: string): boolean {
  return !['completed', 'rejected', 'cancelled'].includes(status);
}

/** Colour follows whether a human still has to act, not the enum order. */
function statusTone(status: string): string {
  switch (status) {
    case 'requested':
      return 'pill--warn';
    case 'approved':
    case 'in_transit':
    case 'received':
    case 'inspected':
      return 'pill--info';
    case 'completed':
      return 'pill--success';
    default:
      return 'pill--neutral';
  }
}
