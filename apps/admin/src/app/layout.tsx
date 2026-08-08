import type { Metadata } from 'next';
import Link from 'next/link';
import { sessionCan } from '@voltix/auth';
import type { Permission } from '@voltix/core';
import { getSession } from '../lib/auth';
import { signOut } from './login/actions';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Voltix Admin', template: '%s · Voltix Admin' },
  description: 'Operate the store: catalogue, orders, stock, marketing and reporting.',
  // The admin must never be indexed, and never be framed.
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Navigation is grouped by *job*, not by database table.
 *
 * "Sell / Fulfil / Stock / Grow" maps to how a shop owner's day actually
 * divides. The alternative — a flat list of entities (Products, Variants,
 * Orders, Shipments, Discounts…) — is how the schema is organised, not how the
 * work is, and it makes a merchant hunt for the screen they need.
 *
 * Two flags on each item, and both exist because of the same principle: a link
 * that does not work is worse than no link.
 *
 *  • `permission` hides what this role cannot use. A warehouse account sees
 *    Fulfil and Stock and nothing else — showing a link that 403s teaches staff
 *    to distrust the interface.
 *  • `ready` marks what is genuinely built. The unbuilt sections render as
 *    dimmed, non-clickable labels rather than links to a 404, which is what
 *    they were until now. A roadmap in the sidebar is honest; a broken link is
 *    a bug report waiting to be filed.
 */
const NAV = [
  {
    group: 'Sell',
    items: [
      // The dashboard has no permission gate: anyone with a seat needs a
      // landing page, and its contents are themselves permission-filtered.
      { href: '/', label: 'Dashboard', permission: null, ready: true },
      { href: '/products', label: 'Products', permission: 'product:read', ready: true },
      { href: '/customers', label: 'Customers', permission: 'customer:read', ready: true },
    ],
  },
  {
    group: 'Fulfil',
    items: [
      { href: '/orders', label: 'Orders', permission: 'order:read', ready: true },
      { href: '/shipments', label: 'Shipments', permission: 'order:write', ready: false },
      { href: '/returns', label: 'Returns', permission: 'return:manage', ready: false },
    ],
  },
  {
    group: 'Stock',
    items: [
      { href: '/inventory', label: 'Inventory', permission: 'inventory:read', ready: true },
      { href: '/purchasing', label: 'Purchase orders', permission: 'purchase:read', ready: false },
      { href: '/suppliers', label: 'Suppliers', permission: 'supplier:write', ready: false },
    ],
  },
  {
    group: 'Grow',
    items: [
      { href: '/messages', label: 'Messages', permission: 'campaign:read', ready: true },
      { href: '/marketing', label: 'Campaigns', permission: 'campaign:read', ready: false },
      { href: '/discounts', label: 'Discounts', permission: 'discount:write', ready: false },
      { href: '/reports', label: 'Reports', permission: 'finance:read', ready: false },
    ],
  },
] as const satisfies readonly {
  group: string;
  items: readonly { href: string; label: string; permission: Permission | null; ready: boolean }[];
}[];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  // The login page and the MFA challenge render without the shell. Deciding
  // that here rather than with a route group keeps a single root layout, so
  // there is exactly one place that can forget to check for a session.
  if (!session?.mfaSatisfied) {
    return (
      <html lang="en">
        <body>
          <main className="auth-shell">{children}</main>
        </body>
      </html>
    );
  }

  const groups = NAV.map((section) => ({
    group: section.group,
    items: section.items.filter(
      (item) => item.permission === null || sessionCan(session, item.permission),
    ),
  })).filter((section) => section.items.length > 0);

  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside className="sidebar">
            <Link href="/" className="sidebar__logo">
              volt<span>ix</span>
            </Link>

            {groups.map((section) => (
              <nav key={section.group} aria-label={section.group}>
                <p className="sidebar__group-title">{section.group}</p>
                <ul>
                  {section.items.map((item) => (
                    <li key={item.href}>
                      {item.ready ? (
                        <Link href={item.href}>{item.label}</Link>
                      ) : (
                        <span className="sidebar__soon" aria-disabled="true">
                          {item.label}
                          <em>soon</em>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </nav>
            ))}

            <div className="sidebar__account">
              <p className="sidebar__account-name">{session.name}</p>
              <p className="sidebar__account-role">{session.roleName}</p>
              <form action={signOut}>
                <button type="submit" className="sidebar__signout">
                  Sign out
                </button>
              </form>
            </div>
          </aside>
          <div className="content">{children}</div>
        </div>
      </body>
    </html>
  );
}
