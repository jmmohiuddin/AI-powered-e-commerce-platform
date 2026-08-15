import 'server-only';
import { cache } from 'react';
import { eq } from 'drizzle-orm';
import { withTenantRead, schema } from '@voltix/db';
import { formatTrn } from '@voltix/core';
import { DEMO_TENANT_ID } from './catalog';

/**
 * WHO IS SELLING TO YOU.
 *
 * UAE consumer-protection law (Federal Law 15/2020 as amended, Cabinet
 * Decision 66/2023 — requirement L-05) obliges a seller to disclose the
 * licensing entity. That means a legal name, a trade licence number, and — for
 * a VAT-registered seller — a TRN, shown to the shopper rather than kept in a
 * settings screen.
 *
 * ONE SOURCE, READ FROM THE DATABASE. These four values were previously typed
 * as literal text into the footer of `app/layout.tsx`. Which was survivable for
 * exactly as long as nobody trusted them: the same TRN is printed on every tax
 * invoice from `tenants.tax_registration_number` (packages/commerce/src/invoices.ts
 * reads it in `loadOrderFacts`), so a footer with its own copy is a second
 * version of a legally significant number that nothing keeps in agreement with
 * the first. A privacy page naming a *different* controller than the invoice
 * names as supplier is worse still.
 *
 * UNSET RENDERS NOTHING. Every field is nullable in the schema and null here,
 * and each caller is expected to omit its line rather than print a placeholder.
 * This follows lib/contact.ts, and the reason is the same but sharper: an
 * invented trade licence number on a live storefront is a false statement to a
 * regulator, and a privacy page carrying a fake registered address is worse
 * than no privacy page at all — it tells a data subject where to send a request
 * that will never arrive.
 */

export interface MerchantIdentity {
  /** Registered legal name, e.g. "Voltix Electronics Trading L.L.C." */
  readonly legalName: string | null;
  /** Registered address as it appears on a tax invoice. Free text; may be multi-line. */
  readonly legalAddress: string | null;
  /** 15-digit FTA Tax Registration Number, grouped for reading. */
  readonly taxRegistrationNumber: string | null;
  /** Trade licence number issued by the licensing authority. */
  readonly tradeLicenceNumber: string | null;
}

const NONE: MerchantIdentity = {
  legalName: null,
  legalAddress: null,
  taxRegistrationNumber: null,
  tradeLicenceNumber: null,
};

const USE_DATABASE = Boolean(process.env.DATABASE_URL);

/**
 * The merchant's legal identity for this request.
 *
 * Wrapped in React's `cache` so the footer (on every page) and a legal page
 * that also needs it share one query per request rather than issuing two.
 *
 * A database failure yields `NONE` rather than throwing. A footer is not worth
 * a 500, and the failure mode is visible — the legal line simply disappears,
 * which is noticed. This deliberately differs from `lib/catalog.ts`, which
 * rethrows in production: serving a *wrong* product is a real harm, whereas
 * omitting a trust line is only a missing one, and there is no fallback here
 * that could be wrong in the first place.
 */
export const merchantIdentity = cache(async (): Promise<MerchantIdentity> => {
  if (!USE_DATABASE) return NONE;
  try {
    const rows = await withTenantRead(DEMO_TENANT_ID, (tx) =>
      tx
        .select({
          legalName: schema.tenants.legalName,
          legalAddress: schema.tenants.legalAddress,
          taxRegistrationNumber: schema.tenants.taxRegistrationNumber,
          tradeLicenceNumber: schema.tenants.tradeLicenceNumber,
        })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, DEMO_TENANT_ID))
        .limit(1),
    );

    const row = rows[0];
    if (!row) return NONE;

    return {
      legalName: clean(row.legalName),
      legalAddress: clean(row.legalAddress),
      // Grouped in threes by the same helper the invoice uses, so the number
      // does not read as a fifteen-digit wall in either place.
      taxRegistrationNumber: row.taxRegistrationNumber
        ? formatTrn(row.taxRegistrationNumber)
        : null,
      tradeLicenceNumber: clean(row.tradeLicenceNumber),
    };
  } catch (error) {
    console.warn('[merchant] legal identity unavailable:', (error as Error).message);
    return NONE;
  }
});

/** Whitespace-only is unset. A column containing " " must not print as a blank line. */
function clean(value: string | null): string | null {
  return value?.trim() || null;
}
