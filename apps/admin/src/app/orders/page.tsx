import type { Metadata } from 'next';
import Link from 'next/link';
import { formatPrice } from '@voltix/ui';
import { requirePermission } from '../../lib/auth';
import { listOrders } from '../../lib/queries';
import { StatusPill } from '../../components/status-pill';
import { emirateName } from '../../lib/format';

export const metadata: Metadata = { title: 'Orders' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

/**
 * The order list is a work queue, not a report.
 *
 * It defaults to newest first and puts the two questions an operator actually
 * arrives with — "has this been paid" and "has this shipped" — in adjacent
 * columns, because the job is to find the rows where those two disagree.
 */
export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; payment?: string; fulfilment?: string; page?: string }>;
}) {
  const session = await requirePermission('order:read');
  const params = await searchParams;

  const page = Math.max(Number(params.page ?? '1') || 1, 1);
  const result = await listOrders(session.tenantId, {
    search: params.q,
    status: params.status,
    paymentStatus: params.payment,
    fulfilmentStatus: params.fulfilment,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const pages = Math.max(Math.ceil(result.total / PAGE_SIZE), 1);
  const filtered = Boolean(params.q || params.status || params.payment || params.fulfilment);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Orders</h1>
          <p>
            {result.total} {result.total === 1 ? 'order' : 'orders'}
            {filtered ? ' matching your filters' : ''}
          </p>
        </div>
      </div>

      {/*
        A plain GET form. No JavaScript, no client state, and the filtered view
        gets a real URL that an operator can bookmark or paste into a message —
        "look at this one" is most of what a support conversation is.
      */}
      <form className="filters card" method="get">
        <input
          type="search"
          name="q"
          defaultValue={params.q ?? ''}
          placeholder="Order number, phone, email or name"
          aria-label="Search orders"
        />
        <select name="payment" defaultValue={params.payment ?? ''} aria-label="Payment status">
          <option value="">Any payment</option>
          {['unpaid', 'authorised', 'partially_paid', 'paid', 'partially_refunded', 'refunded', 'failed'].map(
            (value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, ' ')}
              </option>
            ),
          )}
        </select>
        <select name="fulfilment" defaultValue={params.fulfilment ?? ''} aria-label="Fulfilment status">
          <option value="">Any fulfilment</option>
          {['unfulfilled', 'partially_fulfilled', 'fulfilled', 'partially_returned', 'returned'].map(
            (value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, ' ')}
              </option>
            ),
          )}
        </select>
        <button type="submit">Filter</button>
        {filtered && (
          <Link href="/orders" className="filters__clear">
            Clear
          </Link>
        )}
      </form>

      {result.rows.length === 0 ? (
        <div className="card">
          <p className="muted">
            {filtered
              ? 'No orders match those filters.'
              : 'No orders yet. The first order placed on the storefront appears here.'}
          </p>
        </div>
      ) : (
        <div className="card table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Order</th>
                <th>Placed</th>
                <th>Customer</th>
                <th>Payment</th>
                <th>Fulfilment</th>
                <th className="numeric">Items</th>
                <th className="numeric">Total</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((order) => (
                <tr key={order.id}>
                  <td>
                    <Link href={`/orders/${order.number}`}>#{order.number}</Link>
                    {order.isGuest && <div className="kpi__note">guest</div>}
                  </td>
                  <td>{formatDate(order.placedAt)}</td>
                  <td>
                    {order.customerName ?? '—'}
                    <div className="kpi__note">{emirateName(order.emirate)}</div>
                  </td>
                  <td>
                    <StatusPill kind="payment" value={order.paymentStatus} />
                  </td>
                  <td>
                    <StatusPill kind="fulfilment" value={order.fulfilmentStatus} />
                  </td>
                  <td className="numeric">{order.itemCount}</td>
                  <td className="numeric">{formatPrice(order.total, order.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <nav className="pager" aria-label="Pagination">
          <PagerLink page={page - 1} disabled={page <= 1} params={params} label="← Previous" />
          <span>
            Page {page} of {pages}
          </span>
          <PagerLink page={page + 1} disabled={page >= pages} params={params} label="Next →" />
        </nav>
      )}
    </>
  );
}

function PagerLink({
  page,
  disabled,
  params,
  label,
}: {
  page: number;
  disabled: boolean;
  params: Record<string, string | undefined>;
  label: string;
}) {
  if (disabled) {
    return (
      <span className="pager__link pager__link--disabled" aria-disabled="true">
        {label}
      </span>
    );
  }
  // Carry the active filters through, so paging does not silently reset the
  // search an operator just typed.
  const query = new URLSearchParams(
    Object.entries(params).filter(([key, value]) => key !== 'page' && value) as [string, string][],
  );
  query.set('page', String(page));
  return (
    <Link className="pager__link" href={`/orders?${query.toString()}`}>
      {label}
    </Link>
  );
}

function formatDate(date: Date | null): string {
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-AE', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Dubai',
  }).format(date);
}
