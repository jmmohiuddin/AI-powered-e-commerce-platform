import Link from 'next/link';
import { formatPrice } from '@voltix/ui';
import { requireSession, tenantContextFor } from '../lib/auth';
import { dashboardMetrics, listOrders } from '../lib/queries';
import { StatusPill } from '../components/status-pill';
import { emirateName } from '../lib/format';

/**
 * The dashboard answers one question: what needs attention today?
 *
 * Every element earns its place against that question. There is no chart of
 * revenue over time here, because a line going up tells a merchant nothing they
 * can act on before lunch. What they can act on: an order flagged for fraud, an
 * order paid three days ago that nobody has picked, money that has not landed.
 *
 * All of it is read from the database. This page used to render a hardcoded
 * sample day, which looked identical and told the merchant nothing true — the
 * worst possible property for a screen whose entire job is to be believed.
 */
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  // The authorisation boundary. The proxy redirect is optimistic; this is the
  // check that actually holds, and it must be the first thing every page does.
  const session = await requireSession();
  const ctx = tenantContextFor(session);

  const [metrics, recent] = await Promise.all([
    dashboardMetrics(session.tenantId, ctx.currency),
    listOrders(session.tenantId, { limit: 12 }),
  ]);

  const flagged = recent.rows.filter((o) => o.riskScore >= 50);
  const today = new Intl.DateTimeFormat('en-AE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Dubai',
  }).format(new Date());

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Today</h1>
          {/* Asia/Dubai explicitly. A server in Frankfurt renders "yesterday"
              for four hours every evening, and the merchant is left arguing
              with a dashboard about what day it is. */}
          <p>{today} · {session.name}</p>
        </div>
        <Link className="pill pill--info" href="/orders">
          All orders
        </Link>
      </div>

      <div className="kpi-grid">
        <Kpi
          label="Revenue"
          value={formatPrice(metrics.revenue, metrics.currency)}
          deltaPct={metrics.revenueDeltaPct}
          note="vs. same day last week"
        />
        <Kpi
          label="Orders"
          value={String(metrics.orders)}
          deltaPct={metrics.ordersDeltaPct}
          note="vs. same day last week"
        />
        <Kpi
          label="Average order"
          value={formatPrice(metrics.averageOrderValue, metrics.currency)}
          deltaPct={metrics.aovDeltaPct}
          note="vs. same day last week"
        />
        <Kpi
          label="Awaiting fulfilment"
          value={String(metrics.awaitingFulfilment)}
          deltaPct={null}
          note={`${metrics.unpaid} still unpaid`}
        />
      </div>

      {flagged.length > 0 && (
        <>
          <h2 className="section-title">Needs attention</h2>
          <div className="stack-md">
            {flagged.map((order) => (
              <div key={order.id} className="insight insight--danger">
                <strong>
                  Order #{order.number} flagged for review — risk {order.riskScore}
                </strong>
                <p>
                  {formatPrice(order.total, order.currency)} to {emirateName(order.emirate)},{' '}
                  {order.paymentStatus === 'paid' ? 'paid' : 'unpaid'}
                  {order.isGuest ? ', from a guest checkout' : ''}. High-value first orders on cash on
                  delivery are the largest single source of refused-delivery losses.
                </p>
                <Link className="insight__action" href={`/orders/${order.number}`}>
                  Review the order →
                </Link>
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="section-title">Recent orders</h2>
      {recent.rows.length === 0 ? (
        <div className="card">
          {/* An empty state that explains itself. "No data" on a fresh install
              reads as a broken query, and the first thing anyone does is
              restart the server looking for a bug that is not there. */}
          <p className="muted">
            No orders yet. Once the storefront takes its first order it appears here — try placing
            one at <a href="http://localhost:3000">the storefront</a>.
          </p>
        </div>
      ) : (
        <div className="card table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th>Channel</th>
                <th>Payment</th>
                <th>Fulfilment</th>
                <th className="numeric">Risk</th>
                <th className="numeric">Total</th>
              </tr>
            </thead>
            <tbody>
              {recent.rows.map((order) => (
                <tr key={order.id}>
                  <td>
                    <Link href={`/orders/${order.number}`}>#{order.number}</Link>
                    <div className="kpi__note">{relativeTime(order.placedAt)}</div>
                  </td>
                  <td>
                    {order.customerName ?? '—'}
                    <div className="kpi__note">{emirateName(order.emirate)}</div>
                  </td>
                  <td>
                    <span className="pill pill--neutral">{order.channel}</span>
                  </td>
                  <td>
                    <StatusPill kind="payment" value={order.paymentStatus} />
                  </td>
                  <td>
                    <StatusPill kind="fulfilment" value={order.fulfilmentStatus} />
                  </td>
                  <td className="numeric">
                    <span
                      className={`pill ${
                        order.riskScore >= 50
                          ? 'pill--danger'
                          : order.riskScore >= 30
                            ? 'pill--warn'
                            : 'pill--neutral'
                      }`}
                    >
                      {order.riskScore}
                    </span>
                  </td>
                  <td className="numeric">{formatPrice(order.total, order.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * Relative time, computed on the server.
 *
 * Deliberately coarse — "3h ago", not "3h 14m ago". Precision here would force
 * this to be a client component that ticks, and nobody operating a store needs
 * the minute. Coarse buckets also mean the server-rendered string does not go
 * stale in a way the user notices.
 */
function relativeTime(date: Date | null): string {
  if (!date) return '—';
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function Kpi({
  label,
  value,
  deltaPct,
  note,
}: {
  label: string;
  value: string;
  deltaPct: number | null;
  note: string;
}) {
  return (
    <div className="card">
      <p className="kpi__label">{label}</p>
      <p className="kpi__value">{value}</p>
      {deltaPct === null ? (
        // No comparable prior period. An em dash rather than "0.0%", because a
        // fabricated zero is indistinguishable from a real one and quietly
        // trains the merchant to trust a number that was never measured.
        <p className="kpi__delta kpi__delta--none">—</p>
      ) : (
        <p className={`kpi__delta ${deltaPct >= 0 ? 'kpi__delta--up' : 'kpi__delta--down'}`}>
          {deltaPct >= 0 ? '▲' : '▼'} {Math.abs(deltaPct).toFixed(1)}%
        </p>
      )}
      <p className="kpi__note">{note}</p>
    </div>
  );
}
