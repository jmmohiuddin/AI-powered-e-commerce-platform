import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatPrice } from '@voltix/ui';
import { can, requirePermission } from '../../../lib/auth';
import { getOrderDetail } from '../../../lib/queries';
import { StatusPill } from '../../../components/status-pill';
import { emirateName } from '../../../lib/format';
import { OrderActions } from './order-actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ number: string }>;
}): Promise<Metadata> {
  const { number } = await params;
  return { title: `Order #${number}` };
}

/**
 * The order detail page.
 *
 * Laid out as: what state is it in → what can I do → what is in it → what has
 * happened. That ordering is the operator's actual sequence of questions, and
 * it puts the two things they came for (status and the action button) above the
 * fold on a laptop, without scrolling past a line-item table to reach them.
 */
export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ number: string }>;
}) {
  const session = await requirePermission('order:read');
  const { number } = await params;

  const order = await getOrderDetail(session.tenantId, number);
  if (!order) notFound();

  // Reading a phone number and a delivery address is a separate permission from
  // reading the order, so a support agent can reconcile payments without
  // pulling up every customer's home address.
  const showPii = await can('customer:read_pii');

  return (
    <>
      <div className="page-head">
        <div>
          <p className="crumb">
            <Link href="/orders">← Orders</Link>
          </p>
          <h1>Order #{order.number}</h1>
          <p>
            {formatDateTime(order.placedAt)} · {order.channel}
            {order.isGuest ? ' · guest checkout' : ''}
          </p>
        </div>
        <div className="page-head__status">
          <StatusPill kind="lifecycle" value={order.status} />
          <StatusPill kind="payment" value={order.paymentStatus} />
          <StatusPill kind="fulfilment" value={order.fulfilmentStatus} />
        </div>
      </div>

      {order.riskScore >= 50 && (
        <div className="insight insight--danger">
          <strong>Flagged for review — risk score {order.riskScore}</strong>
          <p>
            Confirm the customer by phone before dispatch, or take a partial advance. This is
            advisory: the score explains itself and does not block anything on its own.
          </p>
        </div>
      )}

      <OrderActions
        number={order.number}
        actions={order.actions}
        canCancel={await can('order:cancel')}
        canWrite={await can('order:write')}
        canRefund={await can('order:refund')}
        canManageReturns={await can('return:manage')}
        // Which provider took the money decides whether "record cash collected"
        // is meaningful — so it is asked of the payment intent, the same signal
        // `recordCodCollection` enforces against.
        //
        // `paymentStatus === 'unpaid'` used to stand in for it. That is not a
        // COD test: a card order whose authorisation is still settling is also
        // unpaid, and it put a "Record cash collected" button in front of staff
        // for an order the customer had already paid by card. The domain
        // refuses the call, so nothing could be miscaptured — but a button that
        // only ever errors teaches operators to distrust the ones that work.
        isCod={order.paymentProvider === 'cod'}
        refundableMinor={Math.max(order.paidTotal - order.refundedTotal, 0)}
        currency={order.currency}
      />

      <div className="detail-grid">
        <section className="card">
          <h2 className="section-title section-title--flush">Items</h2>
          <table className="data">
            <thead>
              <tr>
                <th>Product</th>
                <th className="numeric">Qty</th>
                <th className="numeric">Unit</th>
                <th className="numeric">Total</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.title}
                    <div className="kpi__note">
                      {[item.variantTitle, item.sku].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </td>
                  <td className="numeric">
                    {item.quantity}
                    {item.quantityFulfilled > 0 && item.quantityFulfilled < item.quantity && (
                      <div className="kpi__note">{item.quantityFulfilled} sent</div>
                    )}
                  </td>
                  <td className="numeric">{formatPrice(item.unitPrice, order.currency)}</td>
                  <td className="numeric">{formatPrice(item.lineTotal, order.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <dl className="totals">
            <Total label="Subtotal" value={order.subtotal} currency={order.currency} />
            {order.discountTotal > 0 && (
              <Total label="Discount" value={-order.discountTotal} currency={order.currency} />
            )}
            <Total label="Delivery" value={order.shippingTotal} currency={order.currency} />
            {/*
              "Includes VAT", not "plus VAT". UAE consumer prices are displayed
              inclusive of the 5%, so the tax is extracted from the total rather
              than added to it — showing it as a separate addition would both
              misstate the total and be non-compliant on the invoice.
            */}
            <Total
              label="Includes VAT (5%)"
              value={order.taxTotal}
              currency={order.currency}
              muted
            />
            <Total label="Total" value={order.total} currency={order.currency} strong />
            {order.paidTotal !== order.total && (
              <Total label="Paid" value={order.paidTotal} currency={order.currency} />
            )}
            {order.refundedTotal > 0 && (
              <Total label="Refunded" value={order.refundedTotal} currency={order.currency} />
            )}
          </dl>

          {/*
            Opens the tax document. The first request issues it and allocates a
            gapless number; every request after returns that same one. A plain
            link rather than a button because it is a read, and because the
            merchant frequently wants it in its own tab beside the order.
          */}
          <p className="note--after-tight">
            <a
              className="button button--secondary"
              href={`/orders/${order.number}/invoice`}
              target="_blank"
              rel="noopener"
            >
              Tax invoice
            </a>
            {order.recipientTrn && (
              <span className="kpi__note kpi__note--inline">
                Business customer · TRN {order.recipientTrn}
              </span>
            )}
          </p>
        </section>

        <aside className="stack-md">
          <section className="card">
            <h2 className="section-title section-title--flush">Delivery</h2>
            {showPii ? (
              <address className="address">
                {order.customerName && <strong>{order.customerName}</strong>}
                {formatAddress(order.shippingAddress).map((line) => (
                  <span key={line}>{line}</span>
                ))}
                {order.phone && <a href={`tel:${order.phone}`}>{order.phone}</a>}
                {order.email && <a href={`mailto:${order.email}`}>{order.email}</a>}
              </address>
            ) : (
              <p className="muted">
                {emirateName(order.emirate)} — full contact details need the customer PII
                permission.
              </p>
            )}
          </section>

          {order.transactions.length > 0 && (
            <section className="card">
              <h2 className="section-title section-title--flush">Payments</h2>
              <ul className="ledger">
                {order.transactions.map((txn, index) => (
                  <li key={`${txn.kind}-${index}`}>
                    <span>
                      {txn.kind} · {txn.gateway ?? 'manual'}
                    </span>
                    <span className={`pill pill--${txn.status === 'succeeded' ? 'success' : 'warn'}`}>
                      {txn.status}
                    </span>
                    <span className="numeric">{formatPrice(txn.amount, order.currency)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>

      <h2 className="section-title">History</h2>
      <div className="card">
        <ol className="timeline">
          {order.events.map((event, index) => (
            <li key={`${event.type}-${index}`}>
              <div className="timeline__meta">
                <span>{formatDateTime(event.createdAt)}</span>
                <span>{event.actorLabel ?? 'system'}</span>
                {/* Whether the customer saw it. Staff need to know before they
                    apologise for something the customer was never told. */}
                {event.isPublic && <span className="pill pill--neutral">customer notified</span>}
              </div>
              <p>{event.message || event.type}</p>
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}

function Total({
  label,
  value,
  currency,
  strong,
  muted,
}: {
  label: string;
  value: number;
  currency: string;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <div className={`totals__row ${strong ? 'totals__row--strong' : ''} ${muted ? 'muted' : ''}`}>
      <dt>{label}</dt>
      <dd className="numeric">{formatPrice(value, currency)}</dd>
    </div>
  );
}

/**
 * Formats a UAE address.
 *
 * No postal code, because the UAE does not have one — a template with a
 * "Postcode" line is the clearest sign a store was built for somewhere else.
 * The Makani number is the precise locator and belongs near the top, since it
 * is what the driver actually types.
 */
function formatAddress(address: Record<string, unknown> | null): string[] {
  if (!address) return ['No address recorded'];
  const get = (key: string) => (typeof address[key] === 'string' ? (address[key] as string) : '');
  return [
    [get('buildingName'), get('apartment')].filter(Boolean).join(', '),
    get('street'),
    get('area'),
    get('makani') ? `Makani ${get('makani')}` : '',
    [emirateName(get('emirate') || null), 'United Arab Emirates'].filter((v) => v && v !== '—').join(', '),
  ].filter(Boolean);
}

function formatDateTime(date: Date | null): string {
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-AE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Dubai',
  }).format(date);
}
