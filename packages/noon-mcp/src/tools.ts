/**
 * MCP tools over the noon Partner API.
 *
 * Every tool here maps to an endpoint that exists. The previous version of
 * this package exposed a plausible-looking catalogue of tools — item search,
 * return approval, order cancellation — built against an API that was never
 * checked against noon's documentation. None of those endpoints exist, so the
 * tools could only ever have returned 404s dressed as errors. They are gone
 * rather than stubbed, because a tool an assistant can call and that cannot
 * work is worse than one that is absent.
 *
 * The write tools are deliberately narrow. An assistant driving this server
 * can set a quantity, set a price and confirm a shipment; it cannot create or
 * delete a listing. Catalogue changes go through the sync engine, which
 * validates against the category schema and keeps `noon_listings` in step —
 * a listing created out-of-band would be invisible to the sync and would
 * never receive another stock update.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NoonApiError, type NoonClient } from '@voltix/noon';

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown) {
  const text =
    error instanceof NoonApiError
      ? `noon API error (HTTP ${error.status}) on ${error.path ?? 'unknown path'}: ` +
        `${error.message}\n${JSON.stringify(error.body, null, 2)}`
      : error instanceof Error
        ? error.message
        : String(error);

  return { content: [{ type: 'text' as const, text }], isError: true };
}

async function run<T>(work: () => Promise<T>) {
  try {
    return ok(await work());
  } catch (error) {
    return fail(error);
  }
}

export function registerTools(server: McpServer, client: NoonClient): void {
  // -- Stock ----------------------------------------------------------------

  server.tool(
    'noon_get_stock',
    'Read the quantities noon currently holds for specific partner SKUs in one warehouse.',
    {
      warehouseCode: z.string().min(1).describe('noon integration warehouse code, e.g. WH-DXB-01'),
      partnerSkus: z.array(z.string().min(1)).min(1).max(500).describe('Your SKUs'),
    },
    ({ warehouseCode, partnerSkus }) => run(() => client.getStock(warehouseCode, partnerSkus)),
  );

  server.tool(
    'noon_update_stock',
    'Set absolute available quantity for partner SKUs in one warehouse. The quantity replaces ' +
      "noon's current figure — it is not a delta. Returns a per-item result: a 200 response can " +
      'still reject individual SKUs, so check the rejected list.',
    {
      warehouseCode: z.string().min(1),
      items: z
        .array(
          z.object({
            partnerSku: z.string().min(1),
            qty: z.number().int().min(0).describe('Absolute quantity, not a delta'),
          }),
        )
        .min(1)
        .max(500),
    },
    ({ warehouseCode, items }) =>
      run(() =>
        client.updateStock(
          items.map((item) => ({
            warehouse_code: warehouseCode,
            partner_sku: item.partnerSku,
            qty: item.qty,
          })),
        ),
      ),
  );

  // -- Pricing --------------------------------------------------------------

  server.tool(
    'noon_update_price',
    'Set price and optional MSRP for partner SKUs in one marketplace country. Prices are in ' +
      'MAJOR units (1299.50 means AED 1,299.50), not fils. MSRP must be above price or noon ' +
      'rejects the item.',
    {
      countryCode: z.enum(['ae', 'sa', 'eg']).describe('Marketplace country'),
      items: z
        .array(
          z.object({
            partnerSku: z.string().min(1),
            price: z.number().positive().describe('Major units, e.g. 1299.50'),
            msrp: z.number().positive().optional().describe('Struck-through price, must exceed price'),
            isActive: z.boolean().default(true),
          }),
        )
        .min(1)
        .max(500),
    },
    ({ countryCode, items }) =>
      run(() =>
        client.upsertPricing(
          items.map((item) => ({
            partner_sku: item.partnerSku,
            country_code: countryCode,
            price: item.price,
            msrp: item.msrp ?? null,
            is_active: item.isActive,
          })),
        ),
      ),
  );

  // -- Orders ---------------------------------------------------------------

  server.tool(
    'noon_list_orders',
    'List FBPI orders for one warehouse, optionally within a UTC date range. Follows pagination.',
    {
      warehouseCode: z.string().min(1),
      createdAfter: z.string().optional().describe('UTC ISO-8601, e.g. 2026-08-01T00:00:00Z'),
      createdBefore: z.string().optional().describe('UTC ISO-8601'),
    },
    ({ warehouseCode, createdAfter, createdBefore }) =>
      run(() =>
        client.listAllOrders({
          warehouse_code: warehouseCode,
          ...(createdAfter ? { created_after: createdAfter } : {}),
          ...(createdBefore ? { created_before: createdBefore } : {}),
        }),
      ),
  );

  server.tool(
    'noon_get_order',
    'Get one FBPI order by its noon order number.',
    { fbpiOrderNr: z.string().min(1) },
    ({ fbpiOrderNr }) => run(() => client.getOrder(fbpiOrderNr)),
  );

  server.tool(
    'noon_create_shipment',
    'Confirm items shipped against an FBPI order. The shipment number must be unique — reusing ' +
      'one is how a retry avoids creating a duplicate shipment.',
    {
      warehouseCode: z.string().min(1),
      integrationShipmentNr: z.string().min(1).describe('Your unique shipment identifier'),
      fbpiOrderNr: z.string().min(1),
      awbs: z
        .array(
          z.object({
            courier: z.string().min(1).describe("'noon' or your own logistics provider"),
            awbNr: z.string().min(1),
          }),
        )
        .min(1),
      mpItemNrs: z.array(z.string().min(1)).min(1).describe('Marketplace item numbers to ship'),
    },
    ({ warehouseCode, integrationShipmentNr, fbpiOrderNr, awbs, mpItemNrs }) =>
      run(() =>
        client.createShipment({
          warehouse_code: warehouseCode,
          integration_shipment_nr: integrationShipmentNr,
          fbpi_order_nr: fbpiOrderNr,
          awbs: awbs.map((awb) => ({ courier: awb.courier, awb_nr: awb.awbNr })),
          items: mpItemNrs.map((nr) => ({ mp_item_nr: nr })),
        }),
      ),
  );

  // -- Catalogue reference --------------------------------------------------

  server.tool(
    'noon_list_categories',
    'List the noon catalogue categories available to this seller.',
    {},
    () => run(() => client.listCategories()),
  );

  server.tool(
    'noon_list_category_attributes',
    'List the attribute schema for a category — which attributes are mandatory, their types and ' +
      'allowed values. Use before creating a listing: a product missing a mandatory attribute is ' +
      'accepted into review and then silently never goes live.',
    { categoryCode: z.string().min(1) },
    ({ categoryCode }) => run(() => client.listCategoryAttributes(categoryCode)),
  );

  server.tool(
    'noon_list_warehouses',
    'List this partner\'s noon warehouses and their integration codes. These codes are what every ' +
      'stock and order call is scoped to.',
    {},
    () => run(() => client.listWarehouses()),
  );
}
