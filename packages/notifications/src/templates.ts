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

/**
 * Money, always in Western digits.
 *
 * Project decision: Arabic copy uses `0-9`, never Arabic-Indic `٠-٩`. It is UAE
 * commercial practice, and it keeps an amount unambiguous to a courier, a bank
 * statement and a customer comparing the email to the checkout page.
 *
 * `ar-AE` already resolves to the `latn` numbering system, so this changes
 * nothing for the two locales the store ships — but `ar-EG` and `ar-SA` resolve
 * to `arab`, and a customer record carrying either would silently produce
 * "٤٬٦٩٩ د.إ." in a receipt. Pinning the extension makes the decision explicit
 * instead of dependent on which Arabic locale happens to arrive.
 */
function formatMoney(minorUnits: number, currency: string, locale: string): string {
  return formatPrice(minorUnits, currency, isArabic(locale) ? `${locale}-u-nu-latn` : locale);
}

/**
 * Isolates a left-to-right value inside right-to-left copy.
 *
 * Without this, the Unicode bidirectional algorithm resolves the neutral
 * characters *around* a Latin run to the surrounding Arabic direction, and an
 * order number renders as "10042#" — the '#' visually detached and moved to the
 * wrong end. The same happens to a trailing '.' after a URL and to a currency
 * amount butted against Arabic text. U+2066/U+2069 (isolate / pop) fence the
 * run off so it displays exactly as written.
 *
 * Applied to the text body, not just the HTML, because the plain-text part is
 * what a stripped-down client and a WhatsApp message actually show. Clients
 * that ignore the characters are no worse off — they are invisible formatting
 * marks, so the fallback is the current rendering.
 */
const ltr = (value: string, ar: boolean): string => (ar ? `⁦${value}⁩` : value);

/**
 * Arabic counted-noun agreement for a small number of days.
 *
 * Arabic does not pluralise like English: 1 is singular, 2 is dual, 3-10 takes
 * the plural, and 11+ returns to the singular. "2 أيام" is the mistake a
 * machine translation makes and a native reader notices immediately.
 */
function arabicWorkingDays(days: number): string {
  if (days === 1) return 'يوم عمل واحد';
  if (days === 2) return 'يومي عمل';
  if (days <= 10) return `${ltr(String(days), true)} أيام عمل`;
  return `${ltr(String(days), true)} يوم عمل`;
}

/* ─────────────────────────── Order confirmation ─────────────────────────── */

/**
 * What the customer owes, and to whom.
 *
 * Three states, not a boolean, because "not cash on delivery" is not the same
 * as "paid". A card order whose authorisation is still settling is neither, and
 * an `isCod` flag derived from `payment_status = 'unpaid'` told that customer
 * to hand cash to the driver for an order they had already put on a card.
 */
export type PaymentState = 'paid' | 'cod' | 'awaiting';

export interface OrderConfirmationData {
  readonly orderNumber: string;
  readonly customerName: string | null;
  readonly total: number;
  readonly currency: string;
  readonly emirate: string | null;
  /** Whole days until delivery, resolved by the caller from the emirate's zone. */
  readonly deliveryDays: number | null;
  readonly payment: PaymentState;
  readonly itemCount: number;
  readonly trackUrl: string;
  readonly storeName: string;
}

export function renderOrderConfirmation(
  data: OrderConfirmationData,
  locale: string,
  channel: NotificationChannel = 'email',
): RenderedNotification {
  const ar = isArabic(locale);
  const money = ltr(formatMoney(data.total, data.currency, locale), ar);
  const orderNumber = ltr(`#${data.orderNumber}`, ar);
  const trackUrl = ltr(data.trackUrl, ar);

  const delivery = data.deliveryDays
    ? ar
      ? `التوصيل خلال ${arabicWorkingDays(data.deliveryDays)}${data.emirate ? ` إلى ${data.emirate}` : ''}.`
      : `Delivery in about ${data.deliveryDays} working day${data.deliveryDays === 1 ? '' : 's'}${
          data.emirate ? ` to ${data.emirate}` : ''
        }.`
    : '';

  // The payment line is where honesty matters most: a COD order is confirmed
  // but unpaid, and the customer pays the driver. Saying so here prevents the
  // "but your email said it was paid" conversation at the door — and the
  // 'awaiting' line exists so the only way to say "paid" is to actually be paid.
  const payment =
    data.payment === 'cod'
      ? ar
        ? `الدفع عند الاستلام: ${money} نقدًا للمندوب. يرجى تجهيز المبلغ بالضبط.`
        : `Cash on delivery: ${money} to the driver. Please have the exact amount ready.`
      : data.payment === 'paid'
        ? ar
          ? `تم استلام دفعتك بقيمة ${money}. شكرًا لك.`
          : `We've received your payment of ${money}. Thank you.`
        : ar
          ? `المبلغ المستحق: ${money}. لم نستلم الدفعة بعد، وسنؤكدها لك فور اكتمالها.`
          : `Amount due: ${money}. We haven't received payment yet — we'll confirm as soon as it clears.`;

  const subject = ar
    ? `تم تأكيد طلبك رقم ${orderNumber}`
    : `Order ${orderNumber} confirmed`;

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
        `شكرًا لطلبك من ${data.storeName}. تم تأكيد طلبك رقم ${orderNumber} (${ltr(String(data.itemCount), true)} من المنتجات).`,
        payment,
        delivery,
        `تتبّع طلبك: ${trackUrl}`,
        `فريق ${data.storeName}`,
      ]
        .filter(Boolean)
        .join('\n\n')
    : [
        greeting,
        `Thanks for shopping with ${data.storeName}. Your order ${orderNumber} (${data.itemCount} item${
          data.itemCount === 1 ? '' : 's'
        }) is confirmed.`,
        payment,
        delivery,
        `Track your order: ${trackUrl}`,
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
  const money = ltr(formatMoney(data.total, data.currency, locale), ar);
  const orderNumber = ltr(`#${data.orderNumber}`, ar);
  const subject = ar ? `تم إلغاء الطلب ${orderNumber}` : `Order ${orderNumber} cancelled`;

  const refundLine = data.refunded
    ? ar
      ? `تمت إعادة مبلغ ${money} إلى طريقة الدفع الأصلية خلال ${ltr('5–10', true)} أيام عمل.`
      : `Your ${money} refund is on its way back to the original payment method within 5–10 working days.`
    : '';

  const text = ar
    ? [`مرحبًا${data.customerName ? ` ${data.customerName}` : ''}،`, `تم إلغاء طلبك رقم ${orderNumber}.`, refundLine, `فريق ${data.storeName}`]
        .filter(Boolean)
        .join('\n\n')
    : [
        `Hi${data.customerName ? ` ${data.customerName}` : ''},`,
        `Your order ${orderNumber} has been cancelled.`,
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
        `لا يزال لديك ${ltr(String(data.itemCount), true)} من المنتجات في سلتك لدى ${data.storeName}.`,
        `أكمل طلبك: ${ltr(data.cartUrl, true)}`,
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
