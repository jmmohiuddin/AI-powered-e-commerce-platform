import { sql } from 'drizzle-orm';
import { withTenant } from '@voltix/db';
import { getInvoiceForOrder, issueInvoice } from '@voltix/commerce';
import { DomainError } from '@voltix/core';
import { renderInvoiceHtml } from '@voltix/invoicing';
import { requirePermission, tenantContextFor } from '../../../../lib/auth';

/**
 * THE MERCHANT'S COPY OF A TAX INVOICE
 *
 * Same document, same renderer, same numbering as the customer's copy — issuing
 * from either side converges on the one row, because `issueInvoice` is
 * idempotent on the order. Two copies of one invoice with different numbers
 * would be the single worst outcome available here.
 *
 * Behind `order:read` like the rest of the order screens. This is a GET that
 * can allocate a number on first use, so it is deliberately not reachable
 * without a session: the invoice sequence is a legal artefact and nothing
 * anonymous should be able to advance it.
 */

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ number: string }> },
): Promise<Response> {
  const session = await requirePermission('order:read');
  const { number } = await params;
  const ctx = tenantContextFor(session);

  const orderId = await withTenant(session.tenantId, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      SELECT id FROM orders
      WHERE tenant_id = ${session.tenantId} AND number = ${number.replace(/^#/, '')}
      LIMIT 1
    `);
    return rows.rows[0]?.id ?? null;
  });
  if (!orderId) return new Response('Not found', { status: 404 });

  try {
    const invoice =
      (await withTenant(session.tenantId, (tx) => getInvoiceForOrder(tx, ctx, orderId))) ??
      (await withTenant(session.tenantId, (tx) => issueInvoice(tx, ctx, orderId)));

    return new Response(renderInvoiceHtml(invoice.document, { storeUrl: process.env.STOREFRONT_URL ?? null }), {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': `inline; filename="${invoice.number}.html"`,
        'cache-control': 'private, no-store',
        'x-robots-tag': 'noindex, nofollow',
      },
    });
  } catch (error) {
    // The common case is a merchant who has not filled in their legal name,
    // address or TRN — actionable, and their own to fix.
    const message =
      error instanceof DomainError
        ? (error.publicMessage ?? error.message)
        : 'Could not produce this invoice.';
    return new Response(message, { status: 409, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}
