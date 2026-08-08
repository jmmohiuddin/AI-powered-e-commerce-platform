import type { Metadata } from 'next';
import Link from 'next/link';
import { formatPrice } from '@voltix/ui';
import { can, requirePermission } from '../../lib/auth';
import { listCustomers } from '../../lib/catalogue-queries';

export const metadata: Metadata = { title: 'Customers' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

/**
 * Customers, with contact details behind their own permission.
 *
 * `customer:read` gets you the list, the spend and the segments — everything
 * needed to answer "who is worth a call". `customer:read_pii` is what reveals
 * the email and phone. That split is the same one the order screen makes, and
 * it exists so a merchandiser reviewing repeat-purchase behaviour is not handed
 * a mailing list they had no reason to see.
 *
 * Marketing consent is shown as a column rather than buried, because it is the
 * field that decides whether contacting this person is legal. Someone looking
 * at this screen to plan a campaign should not have to click through to learn
 * they may not send.
 */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; segment?: string; page?: string }>;
}) {
  const session = await requirePermission('customer:read');
  const params = await searchParams;
  const showPii = await can('customer:read_pii');

  const page = Math.max(Number(params.page ?? '1') || 1, 1);
  const result = await listCustomers(session.tenantId, {
    search: params.q,
    segment: params.segment,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const pages = Math.max(Math.ceil(result.total / PAGE_SIZE), 1);
  const filtered = Boolean(params.q || params.segment);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Customers</h1>
          <p>
            {result.total} {result.total === 1 ? 'customer' : 'customers'}
            {filtered ? ' matching your filters' : ''}
          </p>
        </div>
      </div>

      <form className="filters card" method="get">
        <input
          type="search"
          name="q"
          defaultValue={params.q ?? ''}
          placeholder={showPii ? 'Name, email or phone' : 'Name'}
          aria-label="Search customers"
        />
        <select name="segment" defaultValue={params.segment ?? ''} aria-label="Segment">
          <option value="">Everyone</option>
          <option value="repeat">Repeat buyers</option>
          <option value="new">First-time or none</option>
          <option value="at_risk">Lapsed (90+ days)</option>
        </select>
        <button type="submit">Filter</button>
        {filtered && (
          <Link href="/customers" className="filters__clear">
            Clear
          </Link>
        )}
      </form>

      {!showPii && (
        <div className="insight" style={{ marginBottom: 'var(--space-4)' }}>
          <strong>Contact details are hidden</strong>
          <p>
            Your role can see purchase behaviour but not email or phone numbers. Ask an owner for
            the customer PII permission if you need them.
          </p>
        </div>
      )}

      {result.rows.length === 0 ? (
        <div className="card">
          <p className="muted">
            {filtered
              ? 'No customers match those filters.'
              : 'No customers yet. Guest checkouts appear under Orders; a customer record is created when someone signs up or reorders.'}
          </p>
        </div>
      ) : (
        <div className="card table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Customer</th>
                {showPii && <th>Contact</th>}
                <th className="numeric">Orders</th>
                <th className="numeric">Lifetime spend</th>
                <th>Last order</th>
                <th>Marketing</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <span className="cell-title">{c.name ?? '—'}</span>
                    <div className="kpi__note">
                      {c.loyaltyTier ? c.loyaltyTier : 'no tier'}
                      {c.riskScore >= 50 ? ` · risk ${c.riskScore}` : ''}
                    </div>
                  </td>
                  {showPii && (
                    <td>
                      {c.email ? <div>{c.email}</div> : null}
                      {c.phone ? <div className="kpi__note">{c.phone}</div> : null}
                      {!c.email && !c.phone ? '—' : null}
                    </td>
                  )}
                  <td className="numeric">{c.orderCount}</td>
                  <td className="numeric">{formatPrice(c.lifetimeSpend, c.currency)}</td>
                  <td>{formatDate(c.lastOrderAt)}</td>
                  <td>
                    {/* Consent, not preference. An opted-out customer must not
                        be added to a campaign, so the "no" case is the one
                        that has to be unmissable. */}
                    {c.acceptsEmail || c.acceptsWhatsapp ? (
                      <span className="pill pill--success">
                        {[c.acceptsEmail ? 'email' : null, c.acceptsWhatsapp ? 'whatsapp' : null]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    ) : (
                      <span className="pill pill--neutral">opted out</span>
                    )}
                  </td>
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
  const query = new URLSearchParams(
    Object.entries(params).filter(([key, value]) => key !== 'page' && value) as [string, string][],
  );
  query.set('page', String(page));
  return (
    <Link className="pager__link" href={`/customers?${query.toString()}`}>
      {label}
    </Link>
  );
}

function formatDate(date: Date | null): string {
  if (!date) return 'never';
  return new Intl.DateTimeFormat('en-AE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Dubai',
  }).format(date);
}
