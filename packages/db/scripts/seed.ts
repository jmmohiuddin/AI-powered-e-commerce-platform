/**
 * Seed — a realistic UAE electronics store.
 *
 * Two rules this file follows:
 *
 *  1. **Idempotent.** Re-running it must not duplicate anything. A seed you are
 *     afraid to run twice is a seed nobody runs.
 *  2. **Realistic magnitudes.** Prices are UAE retail in fils, VAT-inclusive.
 *     A layout validated on "$99" breaks on "AED 4,699", and a rounding bug
 *     hides at AED 10 and appears at AED 4,699.
 *
 * All prices below are VAT-inclusive, because UAE consumer prices legally must
 * be. The 5% VAT component is extracted at invoice time, never added at
 * checkout — see packages/core/src/regions/uae.ts.
 */
// Must be first: populates process.env from the repo-root .env before
// any module below reads a connection string at import time.
import '@voltix/config/load-env';
import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { closeConnections, dbAdmin } from '../src/client';
import { uuidv7 } from '../src/id';
import * as s from '../src/schema';

const TENANT_ID = '01920000-0000-7000-8000-000000000001';
const STORE_ID = '01920000-0000-7000-8000-000000000002';

async function main() {
  // Runs as the owner: the seed writes across tenant boundaries by design.
  const d = dbAdmin();
  console.log('→ Seeding UAE demo store');

  /* ── Tenant & store ──────────────────────────────────────────────── */

  await d
    .insert(s.tenants)
    .values({
      id: TENANT_ID,
      slug: 'voltix-demo',
      name: 'Voltix Electronics LLC',
      plan: 'growth',
      status: 'active',
      countryCode: 'AE',
      defaultCurrency: 'AED',
      defaultLocale: 'en-AE',
      supportedLocales: ['en-AE', 'ar-AE'],
      timezone: 'Asia/Dubai',
      legalName: 'Voltix Electronics Trading L.L.C.',
      /**
       * Required to issue a tax invoice, and it was missing.
       *
       * `legal_address` arrived with migration 0006 and nothing populated it,
       * so `buildInvoice` refused every document with SUPPLIER_INCOMPLETE —
       * while the storefront went on offering a download link and the footer
       * displayed a TRN. The store both showed its tax identity and claimed to
       * have none. Article 59 of the VAT Executive Regulations requires the
       * supplier's address on a full tax invoice, so refusing was right; the
       * missing datum was the bug.
       */
      legalAddress: 'Shop 12, Naif Road, Deira, Dubai, United Arab Emirates',
      // Format-valid placeholder. A real TRN comes from the FTA at registration.
      taxRegistrationNumber: '100123456700003',
      tradeLicenceNumber: 'CN-1234567',
      vatRateBps: 500,
      pricesIncludeVat: true,
      settings: { aiDailyBudgetUsd: 25, codEnabled: true },
    })
    .onConflictDoNothing();

  await d
    .insert(s.stores)
    .values({
      id: STORE_ID,
      tenantId: TENANT_ID,
      name: 'Voltix',
      domain: 'localhost:3000',
      currency: 'AED',
      locale: 'en-AE',
      isDefault: true,
      theme: { whatsappNumber: '971500000000', supportPhone: '+97145550000' },
    })
    .onConflictDoNothing();

  /* ── Roles ───────────────────────────────────────────────────────── */

  for (const role of SYSTEM_ROLE_SEED) {
    await d
      .insert(s.roles)
      .values({
        id: uuidv7(),
        tenantId: TENANT_ID,
        key: role.key,
        name: role.name,
        description: role.description,
        permissions: role.permissions,
        isSystem: true,
      })
      .onConflictDoNothing();
  }

  /* ── Warehouses ──────────────────────────────────────────────────── */

  const warehouses = [
    {
      code: 'DXB-1',
      name: 'Dubai — Al Quoz',
      priority: 10,
      address: { emirate: 'DU', area: 'Al Quoz Industrial 3', countryCode: 'AE' },
      latitude: '25.1279',
      longitude: '55.2270',
    },
    {
      code: 'AUH-1',
      name: 'Abu Dhabi — Mussafah',
      priority: 20,
      address: { emirate: 'AZ', area: 'Mussafah M-17', countryCode: 'AE' },
      latitude: '24.3512',
      longitude: '54.5109',
    },
  ];

  const warehouseIds = new Map<string, string>();
  for (const w of warehouses) {
    const id = uuidv7();
    const [row] = await d
      .insert(s.warehouses)
      .values({ id, tenantId: TENANT_ID, kind: 'warehouse', isActive: true, ...w })
      .onConflictDoNothing()
      .returning({ id: s.warehouses.id });
    warehouseIds.set(
      w.code,
      row?.id ??
        (
          await d
            .select({ id: s.warehouses.id })
            .from(s.warehouses)
            .where(sql`${s.warehouses.code} = ${w.code} and ${s.warehouses.tenantId} = ${TENANT_ID}`)
        )[0]!.id,
    );
  }
  const dubai = warehouseIds.get('DXB-1')!;
  const abuDhabi = warehouseIds.get('AUH-1')!;

  /* ── Brands & categories ─────────────────────────────────────────── */

  const brandIds = new Map<string, string>();
  for (const b of [
    { slug: 'samsung', name: 'Samsung', warranty: 12 },
    { slug: 'apple', name: 'Apple', warranty: 12 },
    { slug: 'xiaomi', name: 'Xiaomi', warranty: 12 },
    { slug: 'anker', name: 'Anker', warranty: 18 },
    { slug: 'logitech', name: 'Logitech', warranty: 24 },
    { slug: 'soundcore', name: 'Soundcore', warranty: 18 },
  ]) {
    const id = uuidv7();
    await d
      .insert(s.brands)
      .values({
        id,
        tenantId: TENANT_ID,
        slug: b.slug,
        name: b.name,
        defaultWarrantyMonths: b.warranty,
      })
      .onConflictDoNothing();
    brandIds.set(b.slug, await resolveId(s.brands, s.brands.slug, b.slug, id));
  }

  const categoryIds = new Map<string, string>();
  for (const c of [
    { slug: 'smartphones', name: 'Smartphones', nameAr: 'الهواتف الذكية', path: '/smartphones' },
    { slug: 'audio', name: 'Audio', nameAr: 'الصوتيات', path: '/audio' },
    {
      slug: 'chargers-cables',
      name: 'Chargers & Cables',
      nameAr: 'الشواحن والكابلات',
      path: '/chargers-cables',
    },
    {
      slug: 'computer-accessories',
      name: 'Computer Accessories',
      nameAr: 'ملحقات الكمبيوتر',
      path: '/computer-accessories',
    },
    { slug: 'storage', name: 'Storage', nameAr: 'وحدات التخزين', path: '/storage' },
  ]) {
    const id = uuidv7();
    await d
      .insert(s.categories)
      .values({
        id,
        tenantId: TENANT_ID,
        slug: c.slug,
        name: c.name,
        path: c.path,
        depth: 0,
        isVisible: true,
        translations: { 'ar-AE': { name: c.nameAr } },
      })
      .onConflictDoNothing();
    categoryIds.set(c.slug, await resolveId(s.categories, s.categories.slug, c.slug, id));
  }

  /* ── Attributes ──────────────────────────────────────────────────── */

  /**
   * The specification vocabulary.
   *
   * Attributes are first-class rows rather than free text on the product so
   * "8 GB RAM" and "8GB RAM" cannot become two different facets. Seeding them
   * matters for a second reason: without these the specification table on every
   * product page is empty, which for an electronics store removes the
   * comparison the shopper came to make.
   */
  const attributeIds = new Map<string, string>();
  for (const a of ATTRIBUTES) {
    const id = uuidv7();
    await d
      .insert(s.attributes)
      .values({
        id,
        tenantId: TENANT_ID,
        key: a.key,
        name: a.name,
        type: a.type,
        unit: a.unit ?? null,
        options: a.options ?? [],
        isFilterable: a.filterable ?? true,
        isComparable: true,
        isKeySpec: a.keySpec ?? false,
        position: a.position,
      })
      .onConflictDoNothing();
    attributeIds.set(a.key, await resolveId(s.attributes, s.attributes.key, a.key, id));
  }

  /* ── Products ────────────────────────────────────────────────────── */

  let seeded = 0;
  for (const p of PRODUCTS) {
    const productId = uuidv7();
    const [inserted] = await d
      .insert(s.products)
      .values({
        id: productId,
        tenantId: TENANT_ID,
        storeId: STORE_ID,
        slug: p.slug,
        title: p.title,
        subtitle: p.subtitle,
        description: p.description,
        highlights: p.highlights,
        brandId: brandIds.get(p.brand)!,
        categoryId: categoryIds.get(p.category)!,
        status: 'active',
        condition: 'new',
        publishedAt: new Date(),
        warrantyMonths: p.warrantyMonths,
        ratingAverage: p.ratingAverage,
        ratingCount: p.ratingCount,
        priceFrom: Math.min(...p.variants.map((v) => v.price)),
        compareAtPriceFrom: p.variants[0]!.compareAtPrice ?? null,
        currency: 'AED',
        metaTitle: `${p.title} — Voltix UAE`,
        metaDescription: p.subtitle,
        aeoFacts: p.answerableFacts,
        tags: p.tags,
        translations: { 'ar-AE': { title: p.titleAr, subtitle: p.subtitleAr } },
      })
      .onConflictDoNothing()
      .returning({ id: s.products.id });

    if (!inserted) continue; // already seeded
    seeded += 1;

    for (const [i, v] of p.variants.entries()) {
      const variantId = uuidv7();
      await d.insert(s.variants).values({
        id: variantId,
        tenantId: TENANT_ID,
        productId,
        sku: v.sku,
        mpn: v.mpn ?? null,
        title: v.title,
        options: v.options,
        price: v.price,
        compareAtPrice: v.compareAtPrice ?? null,
        costPrice: v.cost,
        currency: 'AED',
        weightGrams: v.weightGrams ?? null,
        // Handsets, laptops and tablets are serialised: IMEI capture, warranty
        // by unit, and theft traceability all need per-unit identity.
        isSerialised: p.category === 'smartphones',
        requiresShipping: true,
        position: i,
        isActive: true,
      });

      const warehouse = i % 2 === 0 ? dubai : abuDhabi;
      await d.insert(s.stockLevels).values({
        id: uuidv7(),
        tenantId: TENANT_ID,
        variantId,
        warehouseId: warehouse,
        onHand: v.onHand,
        reserved: 0,
        incoming: v.incoming ?? 0,
        reorderPoint: v.reorderPoint ?? 5,
        reorderQuantity: 20,
        leadTimeDays: v.leadTimeDays ?? 14,
        allowBackorder: false,
      });

      // Opening balance in the ledger, so on-hand is reconstructible from
      // movements alone rather than being an unexplained starting number.
      await d.insert(s.stockMovements).values({
        id: uuidv7(),
        tenantId: TENANT_ID,
        variantId,
        warehouseId: warehouse,
        delta: v.onHand,
        balanceAfter: v.onHand,
        reason: 'purchase_received',
        unitCost: v.cost,
        currency: 'AED',
        note: 'Opening balance (seed)',
      });
    }

    await d.insert(s.media).values({
      id: uuidv7(),
      tenantId: TENANT_ID,
      productId,
      kind: 'image',
      url: `/products/${p.slug}.svg`,
      width: 1200,
      height: 1200,
      altText: p.imageAlt,
      position: 0,
    });
  }

  /* ── Specification values ────────────────────────────────────────── */

  /**
   * A pass of its own, deliberately, rather than a step inside the loop above.
   *
   * That loop skips a product that already exists, which is what keeps the seed
   * idempotent — but it also means anything added to it later never reaches a
   * store that was seeded before the addition. Every existing local database and
   * every CI run has those products already, so specifications attached in there
   * would be written exactly never, and the table would look empty for reasons
   * nobody could see. Resolving the product by slug backfills instead, and the
   * unique index on (product_id, attribute_id) makes a re-run a no-op.
   */
  let specValues = 0;
  for (const [slug, specs] of Object.entries(PRODUCT_SPECS)) {
    const [product] = await d
      .select({ id: s.products.id })
      .from(s.products)
      .where(sql`${s.products.slug} = ${slug} and ${s.products.tenantId} = ${TENANT_ID}`);
    if (!product) continue;

    for (const spec of specs) {
      const attributeId = attributeIds.get(spec.key);
      if (!attributeId) continue;
      const [row] = await d
        .insert(s.productAttributeValues)
        .values({
          id: uuidv7(),
          tenantId: TENANT_ID,
          productId: product.id,
          attributeId,
          // Exactly one of these is set, matching the attribute's declared type.
          valueText: spec.text ?? null,
          valueNumber: spec.number ?? null,
          valueBoolean: spec.boolean ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: s.productAttributeValues.id });
      if (row) specValues += 1;
    }
  }

  /* ── Customers with UAE addresses ────────────────────────────────── */

  const customers = [
    {
      email: 'aisha.almansoori@example.ae',
      phone: '+971501234567',
      firstName: 'Aisha',
      lastName: 'Al Mansoori',
      address: {
        emirate: 'DU',
        area: 'Dubai Marina',
        buildingName: 'Marina Heights Tower',
        flatOrVilla: '2104',
        makani: '2648870219',
      },
    },
    {
      email: 'r.thomas@example.ae',
      phone: '+971552223344',
      firstName: 'Rohan',
      lastName: 'Thomas',
      address: {
        emirate: 'AZ',
        area: 'Al Reem Island',
        buildingName: 'Sun Tower',
        flatOrVilla: '1802',
      },
    },
    {
      email: null,
      phone: '+971569998877',
      firstName: 'Fatima',
      lastName: 'Hassan',
      address: {
        emirate: 'SH',
        area: 'Al Nahda',
        buildingName: 'Sahara Complex',
        flatOrVilla: 'Villa 12',
        landmark: 'Behind Sahara Centre',
      },
    },
  ];

  for (const c of customers) {
    const customerId = uuidv7();
    const [row] = await d
      .insert(s.customers)
      .values({
        id: customerId,
        tenantId: TENANT_ID,
        email: c.email,
        phone: c.phone,
        firstName: c.firstName,
        lastName: c.lastName,
        phoneVerifiedAt: new Date(),
        acceptsMarketingEmail: true,
        acceptsMarketingWhatsapp: true,
        loyaltyTier: 'silver',
      })
      .onConflictDoNothing()
      .returning({ id: s.customers.id });

    if (!row) continue;
    await d.insert(s.addresses).values({
      id: uuidv7(),
      tenantId: TENANT_ID,
      customerId: row.id,
      label: 'Home',
      recipientName: `${c.firstName} ${c.lastName}`,
      phone: c.phone,
      countryCode: 'AE',
      isDefaultShipping: true,
      isDefaultBilling: true,
      ...c.address,
    });
  }

  /* ── Discounts ───────────────────────────────────────────────────── */

  await d
    .insert(s.discounts)
    .values([
      {
        id: uuidv7(),
        tenantId: TENANT_ID,
        code: 'WELCOME10',
        name: '10% off your first order',
        type: 'percentage',
        scope: 'order',
        value: 1000,
        maxDiscountAmount: 20_000, // AED 200 cap
        currency: 'AED',
        conditions: { firstOrderOnly: true, minSubtotal: 20_000 },
        isStackable: false,
        priority: 10,
        isActive: true,
      },
      {
        id: uuidv7(),
        tenantId: TENANT_ID,
        code: null,
        name: 'Free delivery over AED 200',
        type: 'free_shipping',
        scope: 'shipping',
        value: 0,
        currency: 'AED',
        conditions: { minSubtotal: 20_000 },
        isStackable: true,
        priority: 5,
        isActive: true,
      },
    ])
    .onConflictDoNothing();

  const countRows = await d.select({ count: sql<number>`count(*)::int` }).from(s.products);
  const productCount = countRows[0]?.count ?? 0;

  console.log(`✓ Seeded ${seeded} new products (${productCount} total)`);
  console.log(`✓ Seeded ${specValues} new specification values across ${ATTRIBUTES.length} attributes`);
  console.log(`  tenant ${TENANT_ID}`);
  console.log('  warehouses: Dubai (Al Quoz), Abu Dhabi (Mussafah)');
  console.log('  prices are VAT-inclusive at 5%, in fils');
}

/** Returns the inserted id, or looks up the existing row on conflict. */
async function resolveId(
  table: typeof s.brands | typeof s.categories | typeof s.attributes,
  // The column itself rather than its name: attributes are unique on `key`
  // within a tenant where the other two are unique on `slug`, and indexing a
  // union of tables by a union of column names is not something TypeScript can
  // narrow.
  column: AnyPgColumn,
  value: string,
  attemptedId: string,
): Promise<string> {
  const rows = await dbAdmin()
    .select({ id: table.id })
    .from(table)
    .where(sql`${column} = ${value} and ${table.tenantId} = ${TENANT_ID}`);
  return rows[0]?.id ?? attemptedId;
}

const SYSTEM_ROLE_SEED = [
  { key: 'owner', name: 'Owner', description: 'Full control.', permissions: ['*'] },
  {
    key: 'manager',
    name: 'Store Manager',
    description: 'Day-to-day trading.',
    permissions: [
      'product:read',
      'product:write',
      'inventory:read',
      'inventory:adjust',
      'order:read',
      'order:write',
      'customer:read',
      'customer:read_pii',
      'discount:write',
      'finance:read',
      'ai:use',
    ],
  },
  {
    key: 'support',
    name: 'Customer Support',
    description: 'Orders and customers. No cost or margin.',
    permissions: [
      'product:read',
      'inventory:read',
      'order:read',
      'order:write',
      'return:manage',
      'customer:read',
      'customer:read_pii',
      'ai:use',
    ],
  },
  {
    key: 'warehouse',
    name: 'Warehouse Staff',
    description: 'Receives stock and fulfils orders.',
    permissions: ['product:read', 'inventory:read', 'inventory:adjust', 'order:read', 'order:write'],
  },
] as const;

interface SeedVariant {
  sku: string;
  mpn?: string;
  title: string;
  options: Record<string, string>;
  price: number;
  compareAtPrice?: number;
  cost: number;
  onHand: number;
  incoming?: number;
  reorderPoint?: number;
  leadTimeDays?: number;
  weightGrams?: number;
}

interface SeedAttribute {
  key: string;
  name: string;
  type: 'text' | 'number' | 'boolean' | 'enum' | 'measurement';
  /** Rendered after the value. A measurement without one is just a number. */
  unit?: string;
  /** Allowed values for `enum`, ordered for facet display. */
  options?: string[];
  /** Headline spec — the storefront shows these before the rest. */
  keySpec?: boolean;
  filterable?: boolean;
  /** Display order of the specification table. Spaced so a new attribute can
   *  be slotted between two others without renumbering the rest. */
  position: number;
}

/**
 * The specification vocabulary for a UAE electronics catalogue.
 *
 * `value_number` is an INTEGER column, so anything fractional — a 6.9" display,
 * Bluetooth 5.3 — is a text attribute rather than a measurement. Storing 6.9 as
 * a number is not available, and rounding it to 7 would be a lie on a spec
 * sheet.
 */
const ATTRIBUTES: SeedAttribute[] = [
  { key: 'display', name: 'Display', type: 'text', keySpec: true, position: 10 },
  { key: 'processor', name: 'Processor', type: 'text', keySpec: true, position: 20 },
  { key: 'ram', name: 'RAM', type: 'measurement', unit: 'GB', keySpec: true, position: 30 },
  { key: 'storage', name: 'Storage', type: 'measurement', unit: 'GB', keySpec: true, position: 40 },
  {
    key: 'main_camera',
    name: 'Main camera',
    type: 'measurement',
    unit: 'MP',
    keySpec: true,
    position: 50,
  },
  {
    key: 'battery_capacity',
    name: 'Battery',
    type: 'measurement',
    unit: 'mAh',
    keySpec: true,
    position: 60,
  },
  {
    key: 'network',
    name: 'Network',
    type: 'enum',
    options: ['4G', '5G'],
    keySpec: true,
    position: 70,
  },
  {
    key: 'output_power',
    name: 'Output',
    type: 'measurement',
    unit: 'W',
    keySpec: true,
    position: 80,
  },
  { key: 'ports', name: 'Ports', type: 'number', position: 90, filterable: false },
  {
    key: 'charge_technology',
    name: 'Technology',
    type: 'enum',
    options: ['GaN', 'GaN II'],
    position: 100,
  },
  {
    key: 'sensor_dpi',
    name: 'Sensor',
    type: 'measurement',
    unit: 'DPI',
    keySpec: true,
    position: 110,
  },
  {
    key: 'battery_life_days',
    name: 'Battery life',
    type: 'measurement',
    unit: 'days',
    position: 120,
  },
  { key: 'charging_port', name: 'Charging', type: 'enum', options: ['USB-C', 'Micro-USB'], position: 130 },
  {
    key: 'battery_buds_hours',
    name: 'Battery (buds)',
    type: 'measurement',
    unit: 'hours',
    position: 140,
  },
  {
    key: 'battery_total_hours',
    name: 'Battery (with case)',
    type: 'measurement',
    unit: 'hours',
    keySpec: true,
    position: 150,
  },
  { key: 'bluetooth', name: 'Bluetooth', type: 'text', position: 160, filterable: false },
  {
    key: 'noise_cancelling',
    name: 'Active noise cancelling',
    type: 'boolean',
    keySpec: true,
    position: 170,
  },
  { key: 'capacity', name: 'Capacity', type: 'measurement', unit: 'TB', keySpec: true, position: 180 },
  {
    key: 'read_speed',
    name: 'Read speed',
    type: 'measurement',
    unit: 'MB/s',
    keySpec: true,
    position: 190,
  },
  { key: 'interface', name: 'Interface', type: 'text', position: 200, filterable: false },
  { key: 'water_resistant', name: 'Water resistant', type: 'boolean', position: 210 },
];

/** Exactly one of `text`, `number` or `boolean`, matching the attribute's type. */
interface SeedSpec {
  key: string;
  text?: string;
  number?: number;
  boolean?: boolean;
}

/**
 * Specifications per product, keyed by slug.
 *
 * Held beside the products rather than inside them so the product literals stay
 * readable, and so the spread of types — text, number, boolean, enum and
 * measurement — is visible in one place. Every type is represented, because a
 * type nothing exercises is a rendering bug waiting for its first real product.
 */
const PRODUCT_SPECS: Record<string, SeedSpec[]> = {
  'samsung-galaxy-s25-ultra': [
    { key: 'display', text: '6.9" QHD+ AMOLED, 120Hz' },
    { key: 'processor', text: 'Snapdragon 8 Elite' },
    { key: 'ram', number: 12 },
    { key: 'storage', number: 256 },
    { key: 'main_camera', number: 200 },
    { key: 'battery_capacity', number: 5000 },
    { key: 'network', text: '5G' },
    { key: 'water_resistant', boolean: true },
  ],
  'xiaomi-redmi-note-14-pro': [
    { key: 'display', text: '6.67" AMOLED, 120Hz' },
    { key: 'ram', number: 8 },
    { key: 'storage', number: 256 },
    { key: 'main_camera', number: 200 },
    { key: 'network', text: '5G' },
  ],
  'anker-nano-ii-65w-charger': [
    { key: 'output_power', number: 65 },
    { key: 'ports', number: 1 },
    { key: 'charge_technology', text: 'GaN II' },
  ],
  'logitech-mx-master-3s': [
    { key: 'sensor_dpi', number: 8000 },
    { key: 'battery_life_days', number: 70 },
    { key: 'charging_port', text: 'USB-C' },
  ],
  'soundcore-liberty-4-nc': [
    { key: 'battery_buds_hours', number: 10 },
    { key: 'battery_total_hours', number: 50 },
    { key: 'bluetooth', text: '5.3' },
    { key: 'noise_cancelling', boolean: true },
  ],
  'samsung-t7-shield-1tb': [
    { key: 'capacity', number: 1 },
    { key: 'read_speed', number: 1050 },
    { key: 'interface', text: 'USB 3.2 Gen 2' },
    { key: 'water_resistant', boolean: true },
  ],
};

interface SeedProduct {
  slug: string;
  title: string;
  titleAr: string;
  subtitle: string;
  subtitleAr: string;
  brand: string;
  category: string;
  description: string;
  highlights: string[];
  warrantyMonths: number;
  ratingAverage: number;
  ratingCount: number;
  tags: string[];
  imageAlt: string;
  answerableFacts: Array<{ question: string; answer: string }>;
  variants: SeedVariant[];
}

/** UAE retail pricing, VAT-inclusive, in fils. */
const PRODUCTS: SeedProduct[] = [
  {
    slug: 'samsung-galaxy-s25-ultra',
    title: 'Samsung Galaxy S25 Ultra',
    titleAr: 'سامسونج جالاكسي S25 ألترا',
    subtitle: '6.9" QHD+ · 200MP · Snapdragon 8 Elite',
    subtitleAr: '‏٦٫٩ بوصة · ٢٠٠ ميجابكسل · سناب دراجون ٨ إيليت',
    brand: 'samsung',
    category: 'smartphones',
    description:
      'A flagship for people who use their phone as their main camera and their main computer. The 200MP sensor holds detail when you crop, the 5,000mAh battery clears a full day of heavy use, and the titanium frame survives being carried without a case.',
    highlights: [
      '200MP main camera with optical image stabilisation',
      '6.9-inch QHD+ display, 1–120Hz adaptive refresh',
      '5,000mAh battery, 45W wired charging',
      'Titanium frame, IP68 water and dust resistance',
      // Was "UAE warranty, activated on your IMEI at dispatch". Removed because
      // nothing writes to `serial_units` — no IMEI is captured at dispatch or
      // anywhere else. See the note in apps/storefront/src/app/page.tsx for
      // what would have to be true before it may return. Debt P-03 / C-05.
      // NOTE: this seeder is `onConflictDoNothing`, so a tenant seeded before
      // this change keeps the old text in `products.highlights` until the row
      // is updated. Fixing the source does not fix already-seeded data.
      'Official UAE warranty, claimed with the dated invoice issued with your order',
    ],
    warrantyMonths: 12,
    ratingAverage: 468,
    ratingCount: 213,
    tags: ['5g', 'flagship', 'camera'],
    imageAlt: 'Samsung Galaxy S25 Ultra in titanium grey',
    answerableFacts: [
      { question: 'Does it support 5G?', answer: 'Yes, the Galaxy S25 Ultra supports 5G networks.' },
      // Was "…registered to the handset IMEI." Nothing registers an IMEI, and an
      // answerable fact is the version assistants quote back. Debt P-03 / C-05.
      {
        question: 'What warranty is included?',
        answer:
          '12 months UAE warranty from the manufacturer. The dated invoice issued with your order carries our TRN and is the proof of purchase the service centre asks for.',
      },
      { question: 'How large is the battery?', answer: 'The battery is 5,000mAh with 45W wired charging.' },
    ],
    variants: [
      {
        sku: 'SAM-S25U-256-TG',
        mpn: 'SM-S938BZKAMEA',
        title: '256GB · Titanium Grey',
        options: { Storage: '256GB', Colour: 'Titanium Grey' },
        price: 469_900,
        compareAtPrice: 519_900,
        cost: 428_000,
        onHand: 7,
        reorderPoint: 5,
        leadTimeDays: 18,
        weightGrams: 218,
      },
      {
        sku: 'SAM-S25U-512-TG',
        title: '512GB · Titanium Grey',
        options: { Storage: '512GB', Colour: 'Titanium Grey' },
        price: 519_900,
        cost: 472_000,
        onHand: 3,
        reorderPoint: 3,
        leadTimeDays: 18,
        weightGrams: 218,
      },
      {
        sku: 'SAM-S25U-256-TB',
        title: '256GB · Titanium Black',
        options: { Storage: '256GB', Colour: 'Titanium Black' },
        price: 469_900,
        cost: 428_000,
        onHand: 0,
        reorderPoint: 5,
        leadTimeDays: 18,
        weightGrams: 218,
      },
    ],
  },
  {
    slug: 'xiaomi-redmi-note-14-pro',
    title: 'Xiaomi Redmi Note 14 Pro',
    titleAr: 'شاومي ريدمي نوت ١٤ برو',
    subtitle: '6.67" AMOLED · 108MP · 5,110mAh',
    subtitleAr: '‏٦٫٦٧ بوصة أموليد · ١٠٨ ميجابكسل',
    brand: 'xiaomi',
    category: 'smartphones',
    description:
      'The value pick. You give up wireless charging and the flagship chipset; you keep a bright AMOLED panel, a camera that is genuinely good in daylight, and a battery that lasts two days on light use.',
    highlights: [
      '108MP main camera',
      '6.67-inch AMOLED, 120Hz',
      '5,110mAh battery with 45W fast charging',
      '8GB RAM + 256GB storage',
    ],
    warrantyMonths: 12,
    ratingAverage: 441,
    ratingCount: 587,
    tags: ['5g', 'value', 'battery'],
    imageAlt: 'Xiaomi Redmi Note 14 Pro in midnight black',
    answerableFacts: [
      { question: 'How much RAM does it have?', answer: 'It has 8 GB of RAM.' },
      { question: 'Does it have an AMOLED screen?', answer: 'Yes, a 6.67-inch AMOLED display at 120Hz.' },
    ],
    variants: [
      {
        sku: 'XIA-RN14P-256-MB',
        title: '8GB + 256GB · Midnight Black',
        options: { RAM: '8GB', Storage: '256GB', Colour: 'Midnight Black' },
        price: 99_900,
        compareAtPrice: 114_900,
        cost: 82_000,
        onHand: 24,
        reorderPoint: 10,
        leadTimeDays: 12,
        weightGrams: 190,
      },
      {
        sku: 'XIA-RN14P-128-MB',
        title: '8GB + 128GB · Midnight Black',
        options: { RAM: '8GB', Storage: '128GB', Colour: 'Midnight Black' },
        price: 84_900,
        cost: 70_000,
        onHand: 41,
        reorderPoint: 10,
        leadTimeDays: 12,
        weightGrams: 190,
      },
    ],
  },
  {
    slug: 'anker-nano-ii-65w-charger',
    title: 'Anker Nano II 65W GaN Charger',
    titleAr: 'شاحن أنكر نانو II بقوة ٦٥ واط',
    subtitle: 'Charges a laptop from a plug the size of a matchbox',
    subtitleAr: 'يشحن الحاسوب المحمول من قابس بحجم علبة الثقاب',
    brand: 'anker',
    category: 'chargers-cables',
    description:
      'Gallium nitride lets this run cool enough to be a third the size of the charger that came with your laptop. One USB-C port at 65W handles a MacBook Air, an iPad, or any recent Android phone at full speed.',
    highlights: [
      '65W USB-C Power Delivery output',
      'GaN II — roughly one third the size of a standard 65W brick',
      'Works with laptops, tablets and phones',
      'UAE three-pin plug',
    ],
    warrantyMonths: 18,
    ratingAverage: 479,
    ratingCount: 1204,
    tags: ['gan', 'fast-charging', 'usb-c'],
    imageAlt: 'Anker Nano II 65W charger in white',
    answerableFacts: [
      { question: 'Can it charge a laptop?', answer: 'Yes — 65W USB-C Power Delivery charges most ultrabooks at full speed.' },
      { question: 'Does it have a UAE plug?', answer: 'Yes, it ships with a UK-style three-pin plug used in the UAE.' },
    ],
    variants: [
      {
        sku: 'ANK-A2663-WH',
        title: 'White',
        options: { Colour: 'White' },
        price: 14_900,
        cost: 9_800,
        onHand: 63,
        reorderPoint: 25,
        leadTimeDays: 20,
        weightGrams: 112,
      },
    ],
  },
  {
    slug: 'logitech-mx-master-3s',
    title: 'Logitech MX Master 3S',
    titleAr: 'لوجيتك إم إكس ماستر ٣ إس',
    subtitle: 'Quiet clicks · 8K DPI · works on glass',
    subtitleAr: 'نقرات هادئة · ٨٠٠٠ نقطة لكل بوصة',
    brand: 'logitech',
    category: 'computer-accessories',
    description:
      'The mouse people buy once and keep for five years. The magnetic scroll wheel free-spins through long documents, the click is 90% quieter than the previous model, and it pairs with three machines at once.',
    highlights: [
      '8,000 DPI sensor — tracks on glass',
      'MagSpeed electromagnetic scrolling',
      'Connects to three devices, switch with a button',
      '70-day battery, USB-C quick charge',
    ],
    warrantyMonths: 24,
    ratingAverage: 486,
    ratingCount: 892,
    tags: ['productivity', 'wireless'],
    imageAlt: 'Logitech MX Master 3S wireless mouse in graphite',
    answerableFacts: [
      { question: 'Does it work on a glass desk?', answer: 'Yes, the 8K DPI sensor tracks on glass at least 4mm thick.' },
      { question: 'How long does the battery last?', answer: 'Up to 70 days on a full charge.' },
    ],
    variants: [
      {
        sku: 'LOG-MXM3S-GR',
        title: 'Graphite',
        options: { Colour: 'Graphite' },
        price: 37_900,
        compareAtPrice: 42_900,
        cost: 29_500,
        onHand: 4,
        reorderPoint: 5,
        leadTimeDays: 30,
        weightGrams: 141,
      },
    ],
  },
  {
    slug: 'soundcore-liberty-4-nc',
    title: 'Soundcore Liberty 4 NC',
    titleAr: 'ساوندكور ليبرتي ٤ إن سي',
    subtitle: 'Adaptive noise cancelling · 50h total playback',
    subtitleAr: 'إلغاء ضوضاء تكيفي · ٥٠ ساعة تشغيل',
    brand: 'soundcore',
    category: 'audio',
    description:
      'Noise cancelling that measurably works on the metro, at a quarter of the price of the flagship alternatives. Ten hours per charge, fifty with the case, and a fit test in the app so you actually get the seal the ANC depends on.',
    highlights: [
      'Adaptive active noise cancelling',
      '10 hours per charge, 50 hours with the case',
      'Bluetooth 5.3 with multipoint pairing',
      'IPX4 sweat resistant',
    ],
    warrantyMonths: 18,
    ratingAverage: 452,
    ratingCount: 2341,
    tags: ['anc', 'wireless', 'audio'],
    imageAlt: 'Soundcore Liberty 4 NC earbuds with charging case',
    answerableFacts: [
      { question: 'Does it have noise cancelling?', answer: 'Yes, adaptive active noise cancelling.' },
      { question: 'How long is the battery life?', answer: '10 hours from the buds, 50 hours including the case.' },
    ],
    variants: [
      {
        sku: 'SC-LIB4NC-BK',
        title: 'Black',
        options: { Colour: 'Black' },
        price: 29_900,
        compareAtPrice: 36_900,
        cost: 21_000,
        onHand: 38,
        reorderPoint: 15,
        leadTimeDays: 21,
        weightGrams: 48,
      },
      {
        sku: 'SC-LIB4NC-WH',
        title: 'White',
        options: { Colour: 'White' },
        price: 29_900,
        cost: 21_000,
        onHand: 12,
        reorderPoint: 15,
        leadTimeDays: 21,
        weightGrams: 48,
      },
    ],
  },
  {
    slug: 'samsung-t7-shield-1tb',
    title: 'Samsung T7 Shield 1TB Portable SSD',
    titleAr: 'سامسونج T7 شيلد ١ تيرابايت',
    subtitle: '1,050 MB/s · rubber-armoured · IP65',
    subtitleAr: '‏١٠٥٠ ميجابايت/ث · مقاوم للماء والغبار',
    brand: 'samsung',
    category: 'storage',
    description:
      'A terabyte that survives being carried in a bag with your keys. The rubber shell takes a three-metre drop, the IP65 rating shrugs off rain and dust, and it moves a 50GB video project in under a minute.',
    highlights: [
      'Up to 1,050 MB/s read, 1,000 MB/s write',
      'IP65 dust and water resistant',
      '3-metre drop resistance',
      'USB 3.2 Gen 2 — PC, Mac, Android and consoles',
    ],
    warrantyMonths: 36,
    ratingAverage: 474,
    ratingCount: 456,
    tags: ['storage', 'rugged'],
    imageAlt: 'Samsung T7 Shield portable SSD in black',
    answerableFacts: [
      { question: 'Is it waterproof?', answer: 'It is IP65 rated — protected against dust and low-pressure water jets.' },
      { question: 'How fast is it?', answer: 'Up to 1,050 MB/s read and 1,000 MB/s write.' },
    ],
    variants: [
      {
        sku: 'SAM-T7S-1TB-BK',
        title: '1TB · Black',
        options: { Capacity: '1TB', Colour: 'Black' },
        price: 37_900,
        cost: 30_500,
        onHand: 2,
        reorderPoint: 5,
        leadTimeDays: 25,
        weightGrams: 98,
      },
    ],
  },
];

main()
  .catch((error) => {
    console.error('✗ Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => closeConnections());
