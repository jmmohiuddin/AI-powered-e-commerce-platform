/**
 * MERCHANT CONTACT DETAILS
 *
 * One source for the number a shopper is invited to message, call or mail.
 *
 * These were previously hardcoded at five call sites as `971500000000` and
 * `+971 4 555 0000`. A placeholder that renders as a working `wa.me` link is a
 * placeholder that ships: it looks correct in review, and the first person to
 * find out it is wrong is a customer messaging a stranger's phone.
 *
 * Unset means no link at all, never a fake one. A missing "Order on WhatsApp"
 * button costs less than one that opens a chat nobody is on the other end of.
 *
 * `NEXT_PUBLIC_` because the same values render inside client islands (the buy
 * box) as well as server components, and the bundler can only inline what it
 * can see written literally — hence the three separate reads rather than a
 * lookup by key.
 */

const WHATSAPP = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER ?? '';
const PHONE = process.env.NEXT_PUBLIC_SUPPORT_PHONE ?? '';
const EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? '';

/** The number as configured, for display. `null` when unset. */
export function whatsappNumber(): string | null {
  return WHATSAPP.trim() || null;
}

/**
 * A `wa.me` link, optionally pre-filling the message.
 *
 * `wa.me` accepts digits only — a number stored as `+971 50 123 4567` produces
 * a 404 chat page if passed through verbatim.
 */
export function whatsappHref(message?: string): string | null {
  const digits = WHATSAPP.replace(/\D/g, '');
  if (!digits) return null;
  return message
    ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}`
    : `https://wa.me/${digits}`;
}

/** The support line as configured, for display. `null` when unset. */
export function supportPhone(): string | null {
  return PHONE.trim() || null;
}

/** A `tel:` link. Spaces are legal in the display form but not in the href. */
export function telHref(): string | null {
  const number = PHONE.replace(/\s/g, '');
  return number ? `tel:${number}` : null;
}

/** The support mailbox as configured. `null` when unset. */
export function supportEmail(): string | null {
  return EMAIL.trim() || null;
}
