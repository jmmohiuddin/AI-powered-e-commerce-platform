import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { CashOnDeliveryGateway } from '@voltix/payments';
import { renderInvoiceHtml } from '@voltix/invoicing';
import { addItem, getCart, getOrCreateCart } from './cart';
import { completeCheckout } from './checkout';
import { getInvoiceForOrder, issueInvoice } from './invoices';
import {
  asTenant,
  closeTestPools,
  createFixture,
  databaseAvailable,
  ownerDb,
  UAE_ADDRESS,
  type Fixture,
} from './test-support';
import type { ActorContext } from './types';

/**
 * INVOICE ISSUANCE against real Postgres.
 *
 * The properties tested here are the ones a unit test structurally cannot
 * reach: that a number is allocated exactly once per order under concurrency,
 * that the sequence has no gaps, and that a rolled-back transaction takes its
 * number back with it. Every one of those is a legal requirement rather than a
 * nicety — a duplicate invoice number is a document the customer can claim
 * twice, and a gap reads to an auditor as a suppressed sale.
 */

const available = await databaseAvailable();
const suite = available ? describe : describe.skip;

const ACTOR: ActorContext = { type: 'customer', label: 'invoice-test' };
const URLS = {
  returnUrl: 'http://localhost:3000/checkout/return',
  cancelUrl: 'http://localhost:3000/cart',
  webhookUrl: 'http://localhost:3000/api/webhooks/cod',
};

suite('invoice issuance', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture('invoices');
    // A merchant cannot issue any VAT document without their tax identity, so
    // the fixture tenant gets one. The absence case is tested separately.
    await ownerDb().execute(sql`
      UPDATE tenants SET legal_name = 'Voltix Electronics Trading L.L.C',
                         legal_address = 'Shop 12, Naif, Deira, Dubai',
                         tax_registration_number = '100234567800003',
                         trade_licence_number = 'CN-1234567'
      WHERE id = ${f.tenantId}
    `);
  });

  afterAll(async () => {
    await f.cleanup();
    await closeTestPools();
  });

  /** Places a real COD order so the invoice renders from real snapshots. */
  async function placeOrder(
    price: number,
    quantity = 1,
    extra: { recipientTrn?: string } = {},
  ): Promise<string> {
    const variantId = await f.variant({ price, onHand: 20 });
    const cartId = await asTenant(f.tenantId, async (tx) => {
      const id = await getOrCreateCart(tx, f.ctx, { sessionToken: `s-${Math.random()}` });
      await addItem(tx, f.ctx, id, { variantId, quantity });
      return id;
    });
    const result = await asTenant(f.tenantId, async (tx) => {
      const cart = await getCart(tx, f.ctx, cartId);
      return completeCheckout(
        tx,
        f.ctx,
        ACTOR,
        {
          cartId,
          idempotencyKey: `k-${cartId}`,
          expectedTotal: cart.pricing.total.amount,
          paymentProvider: 'cod',
          phone: UAE_ADDRESS.phone,
          shippingAddress: UAE_ADDRESS,
          ...extra,
        },
        new CashOnDeliveryGateway(),
        URLS,
      );
    });
    return result.orderId;
  }

  it('issues one invoice per order, however many times it is asked', async () => {
    const orderId = await placeOrder(469_900);

    const first = await asTenant(f.tenantId, (tx) => issueInvoice(tx, f.ctx, orderId));
    expect(first.created).toBe(true);

    const second = await asTenant(f.tenantId, (tx) => issueInvoice(tx, f.ctx, orderId));
    expect(second.created).toBe(false);
    expect(second.number).toBe(first.number);
    expect(second.id).toBe(first.id);

    const count = await ownerDb().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM invoices WHERE order_id = ${orderId}`,
    );
    expect(Number(count.rows[0]!.n)).toBe(1);
  });

  it('does not issue a second number when two requests race', async () => {
    const orderId = await placeOrder(469_900);

    // The order row is locked first, so the two transactions serialise: one
    // issues, the other finds the row already there. Without that lock both
    // would allocate and one would burn a number on a failed insert — a gap.
    const [a, b] = await Promise.all([
      asTenant(f.tenantId, (tx) => issueInvoice(tx, f.ctx, orderId)),
      asTenant(f.tenantId, (tx) => issueInvoice(tx, f.ctx, orderId)),
    ]);

    expect(a.number).toBe(b.number);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
  });

  it('numbers invoices sequentially with no gaps', async () => {
    const orders = [await placeOrder(10_000), await placeOrder(20_000), await placeOrder(30_000)];
    const numbers: string[] = [];
    for (const orderId of orders) {
      numbers.push((await asTenant(f.tenantId, (tx) => issueInvoice(tx, f.ctx, orderId))).number);
    }

    const sequence = numbers.map((n) => Number(n.split('-').at(-1)));
    for (let i = 1; i < sequence.length; i += 1) {
      expect(sequence[i]).toBe(sequence[i - 1]! + 1);
    }
    expect(numbers[0]).toMatch(/^INV-\d{4}-\d{6}$/);
  });

  it('gives a rolled-back transaction its number back', async () => {
    // The counter increment lives in the caller's transaction on purpose. A
    // non-transactional sequence would burn this number permanently and leave
    // an unexplainable hole.
    const doomed = await placeOrder(50_000);
    await expect(
      asTenant(f.tenantId, async (tx) => {
        await issueInvoice(tx, f.ctx, doomed);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect(await asTenant(f.tenantId, (tx) => getInvoiceForOrder(tx, f.ctx, doomed))).toBeNull();

    const next = await placeOrder(60_000);
    const after = await asTenant(f.tenantId, (tx) => issueInvoice(tx, f.ctx, next));
    const counter = await ownerDb().execute<{ value: number }>(
      sql`SELECT value FROM counters WHERE tenant_id = ${f.tenantId} AND kind = 'invoice'`,
    );
    // The issued number is the counter's current value — nothing was skipped.
    expect(Number(after.number.split('-').at(-1))).toBe(Number(counter.rows[0]!.value));
  });

  it('issues a simplified invoice for a small consumer sale', async () => {
    const orderId = await placeOrder(50_000);
    const invoice = await asTenant(f.tenantId, (tx) => issueInvoice(tx, f.ctx, orderId));

    expect(invoice.kind).toBe('simplified');
    // And it says so. The words "Tax Invoice" on their own are reserved for a
    // document that legally is one.
    const html = renderInvoiceHtml(invoice.document);
    expect(html).toContain('Simplified Tax Invoice');
    expect(html).not.toMatch(/>Tax Invoice</);
  });

  it('issues a full tax invoice above AED 10,000', async () => {
    const orderId = await placeOrder(1_200_000);
    const invoice = await asTenant(f.tenantId, (tx) => issueInvoice(tx, f.ctx, orderId));
    expect(invoice.kind).toBe('tax');
    expect(renderInvoiceHtml(invoice.document)).toContain('>Tax Invoice');
  });

  it('issues a full tax invoice for a business buyer at any value', async () => {
    const orderId = await placeOrder(50_000, 1, { recipientTrn: '100987654300003' });
    const invoice = await asTenant(f.tenantId, (tx) => issueInvoice(tx, f.ctx, orderId));

    expect(invoice.kind).toBe('tax');
    expect(invoice.document.recipient.trn).toBe('100987654300003');
    expect(renderInvoiceHtml(invoice.document)).toContain('100 987 654 300 003');
  });

  it('renders from the order snapshot, not from live catalogue data', async () => {
    const orderId = await placeOrder(469_900);
    const invoice = await asTenant(f.tenantId, (tx) => issueInvoice(tx, f.ctx, orderId));
    const originalDescription = invoice.document.lines[0]!.description;

    // Rename every product on this tenant. The issued document must not move.
    await ownerDb().execute(
      sql`UPDATE order_items SET title = 'RENAMED AFTER INVOICING' WHERE tenant_id = ${f.tenantId}`,
    );

    const reread = await asTenant(f.tenantId, (tx) => getInvoiceForOrder(tx, f.ctx, orderId));
    expect(reread!.document.lines[0]!.description).toBe(originalDescription);
    expect(reread!.document.lines[0]!.description).not.toContain('RENAMED');
  });

  it('adds up: line VAT sums to the invoice VAT and net plus VAT is the total', async () => {
    const orderId = await placeOrder(469_900, 3);
    const { document } = await asTenant(f.tenantId, (tx) => issueInvoice(tx, f.ctx, orderId));

    const lineVat = document.lines.reduce((sum, l) => sum + l.lineVat, 0);
    expect(document.vatTotal).toBe(lineVat + document.shippingVat);
    expect(document.netTotal + document.vatTotal).toBe(document.grossTotal);

    const order = await ownerDb().execute<{ total: number; tax_total: number }>(
      sql`SELECT total, tax_total FROM orders WHERE id = ${orderId}`,
    );
    // The invoice must state the same money the order does.
    expect(document.grossTotal).toBe(Number(order.rows[0]!.total));
    expect(document.vatTotal).toBe(Number(order.rows[0]!.tax_total));
  });

  it('is invisible to another tenant', async () => {
    // An invoice carries a customer's address, every line they bought and, on a
    // B2B supply, their tax registration number. The `invoices` table is new,
    // and a new tenant-owned table that nobody adds to policies.sql is readable
    // by every other merchant on the platform — silently.
    const orderId = await placeOrder(469_900);
    await asTenant(f.tenantId, (tx) => issueInvoice(tx, f.ctx, orderId));

    const stranger = await createFixture('invoices-stranger');
    try {
      const seen = await asTenant(stranger.tenantId, (tx) =>
        tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM invoices`),
      );
      expect(Number(seen.rows[0]!.n)).toBe(0);
    } finally {
      await stranger.cleanup();
    }
  });

  it('refuses to invoice for a merchant with no TRN on file', async () => {
    const bare = await createFixture('invoices-no-trn');
    try {
      const variantId = await bare.variant({ price: 100_000, onHand: 5 });
      const cartId = await asTenant(bare.tenantId, async (tx) => {
        const id = await getOrCreateCart(tx, bare.ctx, { sessionToken: `s-${Math.random()}` });
        await addItem(tx, bare.ctx, id, { variantId, quantity: 1 });
        return id;
      });
      const order = await asTenant(bare.tenantId, async (tx) => {
        const cart = await getCart(tx, bare.ctx, cartId);
        return completeCheckout(
          tx,
          bare.ctx,
          ACTOR,
          {
            cartId,
            idempotencyKey: `k-${cartId}`,
            expectedTotal: cart.pricing.total.amount,
            paymentProvider: 'cod',
            phone: UAE_ADDRESS.phone,
            shippingAddress: UAE_ADDRESS,
          },
          new CashOnDeliveryGateway(),
          URLS,
        );
      });

      // Not a degraded document — an error the merchant can act on. Serving
      // invoice-shaped paper with no TRN hands the customer something their
      // accountant has to reject.
      await expect(
        asTenant(bare.tenantId, (tx) => issueInvoice(tx, bare.ctx, order.orderId)),
      ).rejects.toThrow(/tax settings|TRN/i);
    } finally {
      await bare.cleanup();
    }
  });

  it('refuses a malformed buyer TRN at checkout rather than at invoice time', async () => {
    await expect(placeOrder(50_000, 1, { recipientTrn: '12345' })).rejects.toThrow(/15 digits/i);
  });
});
