/**
 * Typed client for the noon Partner API.
 *
 * Field names below are noon's, in snake_case, deliberately unmapped. This is
 * the boundary layer: the translation from Voltix's domain (minor units,
 * variant IDs, warehouse UUIDs) into noon's (major-unit doubles, partner SKUs,
 * warehouse codes) happens one level up in sync/, where the mapping table
 * lives. Keeping the wire types honest means a doc change is a diff here and
 * nowhere else.
 *
 * SERVICE PREFIXES
 * ----------------
 * The gateway mounts each service under its own prefix. Four are confirmed
 * against noon's own quickstart examples; the rest are inferred from the
 * pattern and marked, because an inferred prefix fails as a 404 and that is
 * worth being able to find quickly.
 */

import { NoonSession, type RequestOptions } from './auth.js';
import type { NoonConfig } from './config.js';
import {
  partitionResults,
  toItemResult,
  type NoonBatchResult,
  type NoonStatus,
} from './errors.js';

const SERVICE = {
  /** Confirmed: noon's auth quickstart posts to /identity/public/v1/api/login. */
  identity: '/identity',
  /** Confirmed: .../stock/v1/stock-update in the Stock quickstart. */
  stock: '/stock',
  /** Confirmed: .../pricing/v1/pricing/upsert in the Pricing quickstart. */
  pricing: '/pricing',
  /** Confirmed: .../content/v1/categories/list in the Content quickstart. */
  content: '/content',
  /** Confirmed: .../fbpi/v1/fbpi-order/{nr}/get in the FBPI webhook guide. */
  fbpi: '/fbpi',
  /** Inferred from the pattern — not seen in a worked example. */
  warehouse: '/warehouse-platform',
  /** Inferred from the pattern — not seen in a worked example. */
  offer: '/offer',
} as const;

/**
 * noon does not publish a batch ceiling for stock or pricing. 500 is chosen
 * rather than discovered: large enough that a 5,000-SKU catalogue is ten
 * calls, small enough to stay well inside any reasonable request-size limit,
 * and small enough that one rejected batch is a bounded amount of re-work.
 */
export const MAX_BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface StockUpdateItem {
  warehouse_code: string;
  partner_sku: string;
  /** Absolute quantity. This becomes the new available figure, not a delta. */
  qty: number;
  processing_time?: string | null;
}

export interface PricingUpsertItem {
  partner_sku: string;
  /** ISO-3166 alpha-2, lowercase in noon's examples: ae, sa, eg. */
  country_code: string;
  /** Major units as a double — 1299.5 means AED 1,299.50. */
  price?: number | null;
  /** Struck-through reference price. */
  msrp?: number | null;
  is_active?: boolean | null;
}

export interface ProductUpsertRequest {
  skus: Array<{ partner_sku: string; size?: string | null }>;
  brand: string;
  category: string;
  images: Array<{ url: string; sort: number }>;
  attributes: Record<string, unknown>;
}

export interface ProductUpsertResponse {
  sku_parent: string;
  variants: Array<{
    sku: string;
    partner_sku: string;
    psku_code: string;
    size?: string | null;
  }>;
  status?: NoonStatus;
}

export interface CategoryAttribute {
  attribute_code: string;
  is_mandatory: boolean;
  is_facet: boolean;
  attribute_type: string;
  is_localizable: boolean;
  is_multivalued: boolean;
  max_values?: number | null;
  min_characters?: number | null;
  max_characters?: number | null;
  number_min?: number | null;
  number_max?: number | null;
  attribute_options: string[];
  attribute_metric_units: string[];
  additional_validation_regex?: string | null;
}

export interface FbpiOrderItem {
  mp_item_nr: string;
  partner_sku: string;
  mp_status: 'MP_ITEM_STATUS_UNSPECIFIED' | 'MP_ITEM_STATUS_CONFIRMED' | 'MP_ITEM_STATUS_CANCELLED';
  integration_status:
    | 'INTEGRATION_ITEM_STATUS_UNSPECIFIED'
    | 'INTEGRATION_ITEM_STATUS_ACKNOWLEDGED'
    | 'INTEGRATION_ITEM_STATUS_OUT_OF_STOCK'
    | 'INTEGRATION_ITEM_STATUS_SHIPPED';
  delivered_invoice_price: number;
  cancellation_reason_code?: string | null;
}

export interface FbpiOrder {
  fbpi_order_nr: string;
  /** 'noon' or 'namshi'. */
  mp_code: string;
  mp_order_nr: string;
  mp_country_code: string;
  customer_country_code: string;
  merchant_code: string;
  currency_code: string;
  warehouse_code: string;
  items: FbpiOrderItem[];
  order_created_at: string;
}

export interface NoonWarehouse {
  warehouse_code: string;
  display_name: string;
  fulfillment_system_code: string;
  is_active: boolean;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class NoonClient {
  private readonly session: NoonSession;

  constructor(config: NoonConfig, session?: NoonSession) {
    this.session = session ?? new NoonSession(config);
  }

  // -- Stock ----------------------------------------------------------------

  /**
   * Sets absolute available quantity for up to `MAX_BATCH_SIZE` SKUs.
   *
   * Returns a partitioned result rather than throwing on rejection, because a
   * batch is routinely part-accepted and the caller must record which SKUs
   * actually landed. A transport failure still throws.
   */
  async updateStock(items: StockUpdateItem[]): Promise<NoonBatchResult> {
    assertBatchSize(items.length, 'updateStock');

    const response = await this.session.post<{
      items?: Array<{ warehouse_code: string; partner_sku: string; status?: NoonStatus }>;
    }>(`${SERVICE.stock}/v1/stock-update`, { items });

    return partitionResults(
      (response.items ?? []).map((item) =>
        toItemResult(`${item.warehouse_code}/${item.partner_sku}`, item.status),
      ),
    );
  }

  /** Reads noon's current stock figures — the input to the drift reconcile. */
  async getStock(
    warehouseCode: string,
    partnerSkus: string[],
  ): Promise<Array<{ partner_sku: string; warehouse_code: string; qty: number }>> {
    const response = await this.session.post<{
      items?: Array<{ partner_sku: string; warehouse_code: string; qty: number }>;
    }>(`${SERVICE.stock}/v1/stock-list`, {
      warehouse_code: warehouseCode,
      partner_skus: partnerSkus,
    });
    return response.items ?? [];
  }

  // -- Pricing --------------------------------------------------------------

  async upsertPricing(items: PricingUpsertItem[]): Promise<NoonBatchResult> {
    assertBatchSize(items.length, 'upsertPricing');

    const response = await this.session.post<{
      items?: Array<{ partner_sku: string; country_code: string; status?: NoonStatus }>;
    }>(`${SERVICE.pricing}/v1/pricing/upsert`, { items });

    return partitionResults(
      (response.items ?? []).map((item) =>
        toItemResult(`${item.country_code}/${item.partner_sku}`, item.status),
      ),
    );
  }

  // -- Catalogue content ----------------------------------------------------

  /**
   * Creates or updates a product listing.
   *
   * One call carries every variant of a product (`skus[]`), because noon
   * groups them under a generated parent SKU. Splitting variants across calls
   * produces separate parents and a customer-facing listing that shows one
   * colour per tile.
   */
  upsertProduct(request: ProductUpsertRequest): Promise<ProductUpsertResponse> {
    return this.session.post<ProductUpsertResponse>(
      `${SERVICE.content}/v1/product/upsert`,
      request,
    );
  }

  async listCategories(): Promise<Array<{ category_code: string; name?: string }>> {
    const response = await this.session.post<{
      categories?: Array<{ category_code: string; name?: string }>;
    }>(`${SERVICE.content}/v1/categories/list`, {});
    return response.categories ?? [];
  }

  /**
   * The attribute schema for a category.
   *
   * Fetched rather than hard-coded: noon's per-category mandatory attributes
   * change without notice, and a product rejected for a missing attribute is
   * a listing that silently never goes live. `validateAttributes` in
   * sync/product.ts checks a payload against this before spending the call.
   */
  async listCategoryAttributes(categoryCode: string): Promise<CategoryAttribute[]> {
    const response = await this.session.post<{ attributes?: CategoryAttribute[] }>(
      `${SERVICE.content}/v1/categories/attributes/list`,
      { category_code: categoryCode },
    );
    return response.attributes ?? [];
  }

  // -- Orders (FBPI) --------------------------------------------------------

  /**
   * One page of orders for a warehouse — at most 50.
   *
   * noon requires that filters stay byte-identical across a paginated run, so
   * the caller passes the same `filters` object back with each `nextToken`.
   * `listAllOrders` below does that correctly; prefer it.
   */
  async listOrders(
    filters: { warehouse_code: string; created_after?: string; created_before?: string },
    nextToken?: string,
  ): Promise<{ orders: FbpiOrder[]; next_token: string }> {
    const options: RequestOptions = nextToken ? { query: { next_token: nextToken } } : {};
    const response = await this.session.post<{ orders?: FbpiOrder[]; next_token?: string }>(
      `${SERVICE.fbpi}/v1/fbpi-orders/list`,
      filters,
      options,
    );
    return { orders: response.orders ?? [], next_token: response.next_token ?? '' };
  }

  /**
   * Every order matching the filters, following pagination to exhaustion.
   *
   * `maxPages` is a circuit breaker, not a limit anyone should hit: a
   * malformed `next_token` that echoes itself back would otherwise spin this
   * loop forever inside a job that holds a database transaction.
   */
  async listAllOrders(
    filters: { warehouse_code: string; created_after?: string; created_before?: string },
    maxPages = 200,
  ): Promise<FbpiOrder[]> {
    const collected: FbpiOrder[] = [];
    let token: string | undefined;
    const seenTokens = new Set<string>();

    for (let page = 0; page < maxPages; page += 1) {
      const { orders, next_token } = await this.listOrders(filters, token);
      collected.push(...orders);

      if (!next_token || seenTokens.has(next_token)) break;
      seenTokens.add(next_token);
      token = next_token;
    }

    return collected;
  }

  getOrder(fbpiOrderNr: string): Promise<FbpiOrder> {
    return this.session.get<FbpiOrder>(
      `${SERVICE.fbpi}/v1/fbpi-order/${encodeURIComponent(fbpiOrderNr)}/get`,
    );
  }

  /**
   * Marks items shipped.
   *
   * `integration_shipment_nr` must be unique and is ours to choose — the sync
   * derives it from the Voltix shipment ID so that a retried job creates the
   * same shipment rather than a duplicate.
   */
  createShipment(request: {
    warehouse_code: string;
    integration_shipment_nr: string;
    fbpi_order_nr: string;
    awbs: Array<{ courier: string; awb_nr: string }>;
    items: Array<{ mp_item_nr: string }>;
  }): Promise<unknown> {
    return this.session.post(`${SERVICE.fbpi}/v1/shipment/create`, request);
  }

  // -- Warehouses -----------------------------------------------------------

  /** The codes that `warehouse_code` must be one of. Used to seed the map. */
  async listWarehouses(): Promise<NoonWarehouse[]> {
    const collected: NoonWarehouse[] = [];
    let token = '';

    for (let page = 0; page < 50; page += 1) {
      const response = await this.session.post<{
        warehouses?: NoonWarehouse[];
        next_token?: string;
      }>(`${SERVICE.warehouse}/v1/warehouses/list`, token ? { next_token: token } : {});

      collected.push(...(response.warehouses ?? []));
      if (!response.next_token) break;
      token = response.next_token;
    }

    return collected;
  }
}

function assertBatchSize(size: number, method: string): void {
  if (size > MAX_BATCH_SIZE) {
    throw new RangeError(
      `[@voltix/noon] ${method} was given ${size} items; the cap is ${MAX_BATCH_SIZE}. ` +
        `Use chunk() from sync/batch.ts — it splits and reports per-chunk results.`,
    );
  }
}
