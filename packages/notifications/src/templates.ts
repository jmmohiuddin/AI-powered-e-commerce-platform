import { formatPrice } from '@voltix/ui';
import type { NotificationChannel } from './port';

/**
 * TEMPLATES
 *
 * Pure functions from data to rendered copy. They do no database work and
 * resolve nothing — the caller hands them a flat, already-resolved data object
 * (the emirate as a name, not a code; the payment method as a label, not an
 * enum) so a template is trivially testable and never surprises with a query.
 *
 * Every customer-facing template renders in English and Arabic. The choice is
 * the recipient's stored locale, not a guess from their phone number — a Dubai
 * number says nothing about which language its owner reads.
 *
 * The rendered subject and body are what gets frozen into the outbox row, so
 * this is also the record of what the customer was told. Keep the copy honest:
 * a confirmation that overstates ("Paid") a cash-on-delivery order is a promise
 * the store has to walk back at the door.
 */

export interface RenderedNotification {
  readonly channel: NotificationChannel;
  readonly subject: string | null;
  readonly text: string;
  readonly html: string | null;
}

const isArabic = (locale: string): boolean => locale.toLowerCase().startsWith('ar');

/* ─────────────────────────── Order confirmation ─────────────────────────── */

export interface OrderConfirmationData {
  readonly orderNumber: string;
  readonly customerName: string | null;
  readonly total: number;
  readonly currency: string;
  readonly emirate: string | null;
  /** Whole days until delivery, resolved by the caller from the emirate's zone. */
  readonly deliveryDays: number | null;
  readonly isCod: boolean;
  readonly itemCount: number;
  readonly trackUrl: string;
  readonly storeName: string;
}

export function renderOrderConfirmation(
  data: OrderConfirmationData,
  locale: string,
  channel: NotificationChannel = 'email',
): RenderedNotification {
  const money = formatPrice(data.total, data.currency, locale);
  const ar = isArabic(locale);

  const delivery = data.deliveryDays
    ? ar
      ? `التوصيل خلال ${data.deliveryDays} أيام عمل${data.emirate ? ` إلى ${data.emirate}` : ''}.`
      : `Delivery in about ${data.deliveryDays} working day${data.deliveryDays === 1 ? '' : 's'}${
          data.emirate ? ` to ${data.emirate}` : ''
        }.`
    : '';

  // The payment line is where honesty matters most: a COD order is confirmed
  // but unpaid, and the customer pays the driver. Saying so here prevents the
  // "but your email said it was paid" conversation at the door.
  const payment = data.isCod
    ? ar
      ? `الدفع عند الاستلام: ${money} نقدًا للمندوب. يرجى تجهيز المبلغ بالضبط.`
      : `Cash on delivery: ${money} to the driver. Please have the exact amount ready.`
    : ar
      ? `تم استلام دفعتك بقيمة ${money}. شكرًا لك.`
      : `We've received your payment of ${money}. Thank you.`;

  const subject = ar
    ? `تم تأكيد طلبك رقم #${data.orderNumber}`
    : `Order #${data.orderNumber} confirmed`;

  const greeting = data.customerName
    ? ar
      ? `مرحبًا ${data.customerName}،`
      : `Hi ${data.customerName},`
    : ar
      ? 'مرحبًا،'
      : 'Hi there,';

  const text = ar
    ? [
        greeting,
        `شكرًا لطلبك من ${data.storeName}. تم تأكيد طلبك رقم #${data.orderNumber}.`,
        payment,
        delivery,
        `تتبّع طلبك: ${data.trackUrl}`,
        `فريق ${data.storeName}`,
      ]
        .filter(Boolean)
        .join('\n\n')
    : [
        greeting,
        `Thanks for shopping with ${data.storeName}. Your order #${data.orderNumber} (${data.itemCount} item${
          data.itemCount === 1 ? '' : 's'
        }) is confirmed.`,
        payment,
        delivery,
        `Track your order: ${data.trackUrl}`,
        `— The ${data.storeName} team`,
      ]
        .filter(Boolean)
        .join('\n\n');

  // WhatsApp and SMS are text-only; only email carries the HTML body.
  const html = channel === 'email' ? wrapHtml(subject, text, data.trackUrl, ar) : null;

  return { channel, subject: channel === 'email' ? subject : null, text, html };
}

/* ──────────────────────────── Order cancelled ───────────────────────────── */

export interface OrderCancelledData {
  readonly orderNumber: string;
  readonly customerName: string | null;
  readonly refunded: boolean;
  readonly total: number;
  readonly currency: string;
  readonly storeName: string;
}

export function renderOrderCancelled(
  data: OrderCancelledData,
  locale: string,
  channel: NotificationChannel = 'email',
): RenderedNotification {
  const ar = isArabic(locale);
  const money = formatPrice(data.total, data.currency, locale);
  const subject = ar ? `تم إلغاء الطلب #${data.orderNumber}` : `Order #${data.orderNumber} cancelled`;

  const refundLine = data.refunded
    ? ar
      ? `تمت إعادة مبلغ ${money} إلى طريقة الدفع الأصلية خلال 5–10 أيام عمل.`
      : `Your ${money} refund is on its way back to the original payment method within 5–10 working days.`
    : '';

  const text = ar
    ? [`مرحبًا${data.customerName ? ` ${data.customerName}` : ''}،`, `تم إلغاء طلبك رقم #${data.orderNumber}.`, refundLine, `فريق ${data.storeName}`]
        .filter(Boolean)
        .join('\n\n')
    : [
        `Hi${data.customerName ? ` ${data.customerName}` : ''},`,
        `Your order #${data.orderNumber} has been cancelled.`,
        refundLine,
        `— The ${data.storeName} team`,
      ]
        .filter(Boolean)
        .join('\n\n');

  return {
    channel,
    subject: channel === 'email' ? subject : null,
    text,
    html: channel === 'email' ? wrapHtml(subject, text, null, ar) : null,
  };
}

/* ───────────────────────── Cart recovery (marketing) ─────────────────────── */

export interface CartRecoveryData {
  readonly customerName: string | null;
  readonly itemCount: number;
  readonly cartUrl: string;
  readonly storeName: string;
}

/**
 * Marketing, not transactional — so it is rendered here for a human to review
 * and is stored as a *draft*, never auto-sent. The dashboard's promise
 * ("Nothing is sent to a customer without a human approving it first") is kept
 * by the outbox status, not by this function; this function only writes copy a
 * person will read before it goes anywhere.
 */
export function renderCartRecovery(
  data: CartRecoveryData,
  locale: string,
  channel: NotificationChannel = 'email',
): RenderedNotification {
  const ar = isArabic(locale);
  const subject = ar ? 'نسيت شيئًا في سلتك' : 'You left something in your cart';

  const text = ar
    ? [
        `مرحبًا${data.customerName ? ` ${data.customerName}` : ''}،`,
        `لا يزال لديك ${data.itemCount} من المنتجات في سلتك لدى ${data.storeName}.`,
        `أكمل طلبك: ${data.cartUrl}`,
      ].join('\n\n')
    : [
        `Hi${data.customerName ? ` ${data.customerName}` : ''},`,
        `You still have ${data.itemCount} item${data.itemCount === 1 ? '' : 's'} waiting in your ${data.storeName} cart.`,
        `Pick up where you left off: ${data.cartUrl}`,
      ].join('\n\n');

  return {
    channel,
    subject: channel === 'email' ? subject : null,
    text,
    html: channel === 'email' ? wrapHtml(subject, text, data.cartUrl, ar) : null,
  };
}

/* ──────────────────────── Operational (internal) ────────────────────────── */

export interface OpsAlertData {
  readonly headline: string;
  readonly detail: string;
}

/** Internal-only, always English, never localised — the audience is the team. */
export function renderOpsAlert(data: OpsAlertData): RenderedNotification {
  return {
    channel: 'email',
    subject: `[Voltix ops] ${data.headline}`,
    text: `${data.headline}\n\n${data.detail}`,
    html: null,
  };
}

/* ───────────────────────────── HTML wrapper ─────────────────────────────── */

/**
 * A minimal, inline-styled HTML shell.
 *
 * Email clients strip <style> blocks and external CSS, so every rule is inline.
 * The layout is a single centred column with a system font stack — the design
 * that renders identically in Gmail, Outlook and Apple Mail, which between them
 * are most of the inboxes and each of which breaks something more ambitious.
 * `dir="rtl"` flips the whole thing for Arabic with no separate template.
 */
function wrapHtml(title: string, text: string, ctaUrl: string | null, ar: boolean): string {
  const paragraphs = text
    .split('\n\n')
    .map((line) => `<p style="margin:0 0 16px;line-height:1.6;">${escapeHtml(line)}</p>`)
    .join('');

  const cta =
    ctaUrl && !ar
      ? `<a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:#1f52e0;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">Track your order</a>`
      : ctaUrl && ar
        ? `<a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:#1f52e0;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">تتبّع الطلب</a>`
        : '';

  return `<!doctype html>
<html lang="${ar ? 'ar' : 'en'}" dir="${ar ? 'rtl' : 'ltr'}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#f6f7f9;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;">
    <div style="font-size:20px;font-weight:700;margin-bottom:24px;">volt<span style="color:#1f52e0;">ix</span></div>
    ${paragraphs}
    ${cta ? `<div style="margin-top:8px;">${cta}</div>` : ''}
  </div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
