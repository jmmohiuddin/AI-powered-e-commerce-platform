import { getInvoiceForOrder, issueInvoice, lookupOrder } from '@voltix/commerce';
import { normaliseUaePhone } from '@voltix/core';
import { renderInvoiceHtml } from '@voltix/invoicing';
import { inTenant, tenantContext } from '@/lib/session';

/**
 * THE CUSTOMER'S TAX INVOICE
 *
 * Served as print-ready HTML rather than a PDF binary. The reason is in
 * `packages/invoicing/src/render-html.ts`: the document is bilingual, and
 * Arabic needs contextual glyph shaping and bidirectional reordering that no
 * dependency-light PDF writer performs. A browser already does both correctly
 * and prints to PDF, so the document is HTML and the reader's own print dialog
 * produces the file.
 *
 * THE GATE IS THE ONE THE CONFIRMATION PAGE ALREADY USES
 * Order number plus the phone the order was placed with — reused deliberately
 * rather than reimplemented. An invoice carries the delivery address, the full
 * line detail and, on a B2B supply, the buyer's tax registration number; a
 * weaker gate here would be a way around the stronger one next door. Order
 * numbers are sequential and therefore guessable, which is exactly why the
 * second factor exists.
 */

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ number: string }> },
): Promise<Response> {
  const { number } = await params;
  const phone = new URL(request.url).searchParams.get('phone');

  const normalised = phone ? normaliseUaePhone(phone) : null;
  if (!normalised) return notFound();

  const ctx = tenantContext();
  const order = await inTenant((tx) => lookupOrder(tx, ctx, number, normalised)).catch(() => null);
  if (!order) return notFound();

  /**
   * Read first, issue only if there is nothing to read.
   *
   * A GET that always allocated would consume the merchant's invoice sequence
   * every time a link was followed, and a sequence with holes in it is the
   * thing gapless numbering exists to prevent. `issueInvoice` is idempotent on
   * its own — this is about not opening a write transaction for the common
   * case, which is a customer opening their invoice a second time.
   */
  let invoice = await inTenant((tx) => getInvoiceForOrder(tx, ctx, order.id));
  if (!invoice) {
    try {
      invoice = await inTenant((tx) => issueInvoice(tx, ctx, order.id));
    } catch (error) {
      // A merchant with incomplete tax settings cannot issue anything. Say so
      // plainly instead of serving a document that is missing a legal field.
      const message =
        error instanceof Error && 'publicMessage' in error
          ? String((error as { publicMessage?: string }).publicMessage)
          : 'This invoice is not available yet.';
      return new Response(message, { status: 409, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  }

  const html = renderInvoiceHtml(invoice.document, { storeUrl: process.env.STOREFRONT_URL ?? null });

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Inline, so the customer sees it and can print to PDF from the browser.
      'content-disposition': `inline; filename="${invoice.number}.html"`,
      // A tax document is never cached by a shared cache and never indexed.
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
    },
  });
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}
