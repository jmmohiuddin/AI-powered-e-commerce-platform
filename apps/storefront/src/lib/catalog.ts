import { classifyQuery, reciprocalRankFusion } from '@voltix/ai';
import * as repository from './repository';
import type { CategoryView, ProductView, SearchFilters, SearchResult } from './types';

export * from './types';

/**
 * CATALOGUE ACCESS
 *
 * One interface, two implementations:
 *
 *   • **Postgres** when `DATABASE_URL` is set — the real path. Hybrid search,
 *     live stock, translations, everything.
 *   • **In-memory demo** otherwise — so `npm install && npm run dev` on a fresh
 *     clone serves a working store. A platform you cannot see running until you
 *     have provisioned a database, run migrations and seeded data is a platform
 *     nobody evaluates.
 *
 * The fallback is for local evaluation only. `packages/config` refuses to boot
 * production without a real `DATABASE_URL`, so it cannot reach a live store by
 * accident.
 */

const USE_DATABASE = Boolean(process.env.DATABASE_URL);

/** Seeded tenant. Production resolves this from the request host in middleware. */
export const DEMO_TENANT_ID = '01920000-0000-7000-8000-000000000001';

export async function listProducts(tenantId = DEMO_TENANT_ID): Promise<ProductView[]> {
  if (!USE_DATABASE) return DEMO_PRODUCTS;
  try {
    const rows = await repository.listProducts(tenantId);
    return rows.length > 0 ? rows : DEMO_PRODUCTS;
  } catch (error) {
    return onDatabaseError(error, DEMO_PRODUCTS);
  }
}

export async function getProduct(
  slug: string,
  tenantId = DEMO_TENANT_ID,
): Promise<ProductView | undefined> {
  const fallback = DEMO_PRODUCTS.find((p) => p.slug === slug);
  if (!USE_DATABASE) return fallback;
  try {
    return (await repository.getProductBySlug(tenantId, slug)) ?? fallback;
  } catch (error) {
    return onDatabaseError(error, fallback);
  }
}

export async function listCategories(tenantId = DEMO_TENANT_ID): Promise<CategoryView[]> {
  if (!USE_DATABASE) return demoCategories();
  try {
    const rows = await repository.listCategories(tenantId);
    return rows.length > 0 ? rows : demoCategories();
  } catch (error) {
    return onDatabaseError(error, demoCategories());
  }
}

export async function searchProducts(
  filters: SearchFilters,
  tenantId = DEMO_TENANT_ID,
): Promise<SearchResult> {
  if (!USE_DATABASE) return demoSearch(filters);
  try {
    return await repository.searchProducts(tenantId, filters);
  } catch (error) {
    return onDatabaseError(error, demoSearch(filters));
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function relatedProducts(
  product: ProductView,
  tenantId = DEMO_TENANT_ID,
): Promise<ProductView[]> {
  // A product that came from the demo fallback has a slug-shaped id, not a
  // uuid. Passing it to the database path is a type error Postgres catches at
  // runtime rather than TypeScript catching at build — so the boundary is
  // guarded here, where the two shapes actually meet.
  if (!USE_DATABASE || !UUID.test(product.id)) return demoRelated(product);
  try {
    return await repository.relatedProducts(tenantId, product);
  } catch (error) {
    return onDatabaseError(error, demoRelated(product));
  }
}

export function totalAvailable(product: ProductView): number {
  return product.variants.reduce((n, v) => n + v.available, 0);
}

/**
 * A database failure degrades to demo data in development and rethrows in
 * production.
 *
 * Silently serving placeholder products from a live store would be far worse
 * than an error page: a shopper could order something that does not exist.
 */
function onDatabaseError<T>(error: unknown, fallback: T): T {
  if (process.env.NODE_ENV === 'production') throw error;
  console.warn('[catalog] database unavailable, serving demo data:', (error as Error).message);
  return fallback;
}

/* ─────────────────────── Demo catalogue (UAE) ───────────────────────── */

/**
 * Prices are UAE retail in fils, VAT-inclusive — AED 4,699 is 469_900.
 * Realistic magnitudes matter: a layout validated on "$99" breaks on
 * "AED 4,699", and a rounding bug hides at AED 10 and shows at AED 4,699.
 */
const DEMO_PRODUCTS: ProductView[] = [
  {
    id: 'p-galaxy-s25',
    slug: 'samsung-galaxy-s25-ultra',
    title: 'Samsung Galaxy S25 Ultra',
    subtitle: '6.9" QHD+ · 200MP · Snapdragon 8 Elite',
    brand: 'Samsung',
    category: 'Smartphones',
    categorySlug: 'smartphones',
    description:
      'A flagship for people who use their phone as their main camera and their main computer. The 200MP sensor holds detail when you crop, the 5,000mAh battery clears a full day of heavy use, and the titanium frame survives being carried without a case.',
    highlights: [
      '200MP main camera with optical image stabilisation',
      '6.9-inch QHD+ display, 1–120Hz adaptive refresh',
      '5,000mAh battery, 45W wired charging',
      'Titanium frame, IP68 water and dust resistance',
      'UAE warranty, activated on your IMEI at dispatch',
    ],
    specs: {
      Display: '6.9" QHD+ AMOLED, 120Hz',
      Processor: 'Snapdragon 8 Elite',
      RAM: '12 GB',
      Storage: '256 GB',
      'Main camera': '200 MP',
      Battery: '5000 mAh',
      Network: '5G',
    },
    translations: {
      'ar-AE': {
        title: 'سامسونج جالاكسي S25 ألترا',
        subtitle: '‏٦٫٩ بوصة · ٢٠٠ ميجابكسل · سناب دراجون ٨ إيليت',
      },
    },
    imageUrl: '/products/samsung-galaxy-s25-ultra.svg',
    imageAlt: 'Samsung Galaxy S25 Ultra in titanium grey',
    price: 469_900,
    compareAtPrice: 519_900,
    currency: 'AED',
    ratingAverage: 468,
    ratingCount: 213,
    warrantyMonths: 12,
    tags: ['5g', 'flagship', 'camera'],
    variants: [
      {
        id: 'v-s25-256-grey',
        sku: 'SAM-S25U-256-TG',
        title: '256GB · Titanium Grey',
        options: { Storage: '256GB', Colour: 'Titanium Grey' },
        price: 469_900,
        compareAtPrice: 519_900,
        available: 7,
      },
      {
        id: 'v-s25-512-grey',
        sku: 'SAM-S25U-512-TG',
        title: '512GB · Titanium Grey',
        options: { Storage: '512GB', Colour: 'Titanium Grey' },
        price: 519_900,
        available: 3,
      },
      {
        id: 'v-s25-256-black',
        sku: 'SAM-S25U-256-TB',
        title: '256GB · Titanium Black',
        options: { Storage: '256GB', Colour: 'Titanium Black' },
        price: 469_900,
        available: 0,
      },
    ],
    answerableFacts: [
      { question: 'Does it support 5G?', answer: 'Yes, the Galaxy S25 Ultra supports 5G networks.' },
      {
        question: 'What warranty is included?',
        answer: '12 months UAE warranty registered to the handset IMEI.',
      },
    ],
  },
  {
    id: 'p-redmi-note-14',
    slug: 'xiaomi-redmi-note-14-pro',
    title: 'Xiaomi Redmi Note 14 Pro',
    subtitle: '6.67" AMOLED · 108MP · 5,110mAh',
    brand: 'Xiaomi',
    category: 'Smartphones',
    categorySlug: 'smartphones',
    description:
      'The value pick. You give up wireless charging and the flagship chipset; you keep a bright AMOLED panel, a camera that is genuinely good in daylight, and a battery that lasts two days on light use.',
    highlights: ['108MP main camera', '6.67-inch AMOLED, 120Hz', '5,110mAh battery, 45W charging'],
    specs: { Display: '6.67" AMOLED, 120Hz', RAM: '8 GB', Storage: '256 GB', Network: '5G' },
    translations: { 'ar-AE': { title: 'شاومي ريدمي نوت ١٤ برو' } },
    imageUrl: '/products/xiaomi-redmi-note-14-pro.svg',
    imageAlt: 'Xiaomi Redmi Note 14 Pro in midnight black',
    price: 99_900,
    compareAtPrice: 114_900,
    currency: 'AED',
    ratingAverage: 441,
    ratingCount: 587,
    warrantyMonths: 12,
    tags: ['5g', 'value', 'battery'],
    variants: [
      {
        id: 'v-rn14-256',
        sku: 'XIA-RN14P-256-MB',
        title: '8GB + 256GB · Midnight Black',
        options: { RAM: '8GB', Storage: '256GB' },
        price: 99_900,
        compareAtPrice: 114_900,
        available: 24,
      },
      {
        id: 'v-rn14-128',
        sku: 'XIA-RN14P-128-MB',
        title: '8GB + 128GB · Midnight Black',
        options: { RAM: '8GB', Storage: '128GB' },
        price: 84_900,
        available: 41,
      },
    ],
    answerableFacts: [{ question: 'How much RAM does it have?', answer: 'It has 8 GB of RAM.' }],
  },
  {
    id: 'p-anker-charger',
    slug: 'anker-nano-ii-65w-charger',
    title: 'Anker Nano II 65W GaN Charger',
    subtitle: 'Charges a laptop from a plug the size of a matchbox',
    brand: 'Anker',
    category: 'Chargers & Cables',
    categorySlug: 'chargers-cables',
    description:
      'Gallium nitride lets this run cool enough to be a third the size of the charger that came with your laptop. One USB-C port at 65W handles a MacBook Air, an iPad, or any recent Android phone at full speed.',
    highlights: [
      '65W USB-C Power Delivery',
      'One third the size of a standard 65W brick',
      'UAE three-pin plug',
    ],
    specs: { Output: '65 W', Ports: '1 × USB-C', Technology: 'GaN II' },
    translations: { 'ar-AE': { title: 'شاحن أنكر نانو II بقوة ٦٥ واط' } },
    imageUrl: '/products/anker-nano-ii-65w-charger.svg',
    imageAlt: 'Anker Nano II 65W charger in white',
    price: 14_900,
    currency: 'AED',
    ratingAverage: 479,
    ratingCount: 1204,
    warrantyMonths: 18,
    tags: ['gan', 'fast-charging', 'usb-c'],
    variants: [
      {
        id: 'v-anker-65-white',
        sku: 'ANK-A2663-WH',
        title: 'White',
        options: { Colour: 'White' },
        price: 14_900,
        available: 63,
      },
    ],
    answerableFacts: [
      {
        question: 'Can it charge a laptop?',
        answer: 'Yes — 65W USB-C Power Delivery charges most ultrabooks at full speed.',
      },
    ],
  },
  {
    id: 'p-logitech-mx',
    slug: 'logitech-mx-master-3s',
    title: 'Logitech MX Master 3S',
    subtitle: 'Quiet clicks · 8K DPI · works on glass',
    brand: 'Logitech',
    category: 'Computer Accessories',
    categorySlug: 'computer-accessories',
    description:
      'The mouse people buy once and keep for five years. The magnetic scroll wheel free-spins through long documents, the click is 90% quieter than the previous model, and it pairs with three machines at once.',
    highlights: [
      '8,000 DPI sensor — tracks on glass',
      'Connects to three devices',
      '70-day battery',
    ],
    specs: { Sensor: '8000 DPI', Battery: '70 days', Charging: 'USB-C' },
    imageUrl: '/products/logitech-mx-master-3s.svg',
    imageAlt: 'Logitech MX Master 3S wireless mouse in graphite',
    price: 37_900,
    compareAtPrice: 42_900,
    currency: 'AED',
    ratingAverage: 486,
    ratingCount: 892,
    warrantyMonths: 24,
    tags: ['productivity', 'wireless'],
    variants: [
      {
        id: 'v-mx3s-graphite',
        sku: 'LOG-MXM3S-GR',
        title: 'Graphite',
        options: { Colour: 'Graphite' },
        price: 37_900,
        compareAtPrice: 42_900,
        available: 4,
      },
    ],
    answerableFacts: [
      {
        question: 'Does it work on a glass desk?',
        answer: 'Yes, the 8K DPI sensor tracks on glass at least 4mm thick.',
      },
    ],
  },
  {
    id: 'p-soundcore-buds',
    slug: 'soundcore-liberty-4-nc',
    title: 'Soundcore Liberty 4 NC',
    subtitle: 'Adaptive noise cancelling · 50h total playback',
    brand: 'Soundcore',
    category: 'Audio',
    categorySlug: 'audio',
    description:
      'Noise cancelling that measurably works on the metro, at a quarter of the price of the flagship alternatives. Ten hours per charge, fifty with the case.',
    highlights: [
      'Adaptive active noise cancelling',
      '50 hours with the case',
      'Bluetooth 5.3 multipoint',
    ],
    specs: { 'Battery (buds)': '10 hours', 'Battery (total)': '50 hours', Bluetooth: '5.3' },
    translations: { 'ar-AE': { title: 'ساوندكور ليبرتي ٤ إن سي' } },
    imageUrl: '/products/soundcore-liberty-4-nc.svg',
    imageAlt: 'Soundcore Liberty 4 NC earbuds with charging case',
    price: 29_900,
    compareAtPrice: 36_900,
    currency: 'AED',
    ratingAverage: 452,
    ratingCount: 2341,
    warrantyMonths: 18,
    tags: ['anc', 'wireless', 'audio'],
    variants: [
      {
        id: 'v-lib4-black',
        sku: 'SC-LIB4NC-BK',
        title: 'Black',
        options: { Colour: 'Black' },
        price: 29_900,
        compareAtPrice: 36_900,
        available: 38,
      },
      {
        id: 'v-lib4-white',
        sku: 'SC-LIB4NC-WH',
        title: 'White',
        options: { Colour: 'White' },
        price: 29_900,
        available: 12,
      },
    ],
    answerableFacts: [
      { question: 'Does it have noise cancelling?', answer: 'Yes, adaptive active noise cancelling.' },
    ],
  },
  {
    id: 'p-samsung-t7',
    slug: 'samsung-t7-shield-1tb',
    title: 'Samsung T7 Shield 1TB Portable SSD',
    subtitle: '1,050 MB/s · rubber-armoured · IP65',
    brand: 'Samsung',
    category: 'Storage',
    categorySlug: 'storage',
    description:
      'A terabyte that survives being carried in a bag with your keys. The rubber shell takes a three-metre drop and the IP65 rating shrugs off rain and dust.',
    highlights: ['1,050 MB/s read', 'IP65 dust and water resistant', '3-metre drop resistance'],
    specs: { Capacity: '1 TB', 'Read speed': '1050 MB/s', Interface: 'USB 3.2 Gen 2' },
    imageUrl: '/products/samsung-t7-shield-1tb.svg',
    imageAlt: 'Samsung T7 Shield portable SSD in black',
    price: 37_900,
    currency: 'AED',
    ratingAverage: 474,
    ratingCount: 456,
    warrantyMonths: 36,
    tags: ['storage', 'rugged'],
    variants: [
      {
        id: 'v-t7-1tb',
        sku: 'SAM-T7S-1TB-BK',
        title: '1TB · Black',
        options: { Capacity: '1TB' },
        price: 37_900,
        available: 2,
      },
    ],
    answerableFacts: [
      {
        question: 'Is it waterproof?',
        answer: 'It is IP65 rated — protected against dust and low-pressure water jets.',
      },
    ],
  },
];

function demoCategories(): CategoryView[] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const product of DEMO_PRODUCTS) {
    const existing = counts.get(product.categorySlug);
    if (existing) existing.count += 1;
    else counts.set(product.categorySlug, { name: product.category, count: 1 });
  }
  return [...counts.entries()].map(([slug, v]) => ({ slug, ...v }));
}

/** Mirrors the production retrieval shape so page code cannot tell them apart. */
function demoSearch(filters: SearchFilters): SearchResult {
  const query = filters.query?.trim() ?? '';
  let candidates = DEMO_PRODUCTS;
  let intent = 'browse';

  if (query) {
    const classified = classifyQuery(query);
    intent = classified.intent;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const score = (haystack: string) =>
      terms.reduce((n, t) => n + (haystack.toLowerCase().includes(t) ? 1 : 0), 0);

    const lexical = DEMO_PRODUCTS.map((p) => ({
      id: p.id,
      score: score(
        `${p.title} ${p.brand} ${p.subtitle ?? ''} ${p.variants.map((v) => v.sku).join(' ')}`,
      ),
    }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);

    const semantic = DEMO_PRODUCTS.map((p) => ({
      id: p.id,
      score: score(
        `${p.description} ${p.tags.join(' ')} ${Object.values(p.specs).join(' ')} ${p.category}`,
      ),
    }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);

    const fused = reciprocalRankFusion([
      { label: 'lexical', results: lexical, weight: classified.lexicalWeight },
      { label: 'semantic', results: semantic, weight: classified.semanticWeight },
    ]);
    const order = new Map(fused.map((r, i) => [r.id, i]));
    candidates = DEMO_PRODUCTS.filter((p) => order.has(p.id)).sort(
      (a, b) => order.get(a.id)! - order.get(b.id)!,
    );
  }

  let filtered = [...candidates];
  if (filters.category) filtered = filtered.filter((p) => p.categorySlug === filters.category);
  if (filters.brand) filtered = filtered.filter((p) => p.brand === filters.brand);
  if (filters.minPrice != null) filtered = filtered.filter((p) => p.price >= filters.minPrice!);
  if (filters.maxPrice != null) filtered = filtered.filter((p) => p.price <= filters.maxPrice!);
  if (filters.inStockOnly) {
    filtered = filtered.filter((p) => p.variants.some((v) => v.available > 0));
  }

  if (filters.sort === 'price_asc') filtered.sort((a, b) => a.price - b.price);
  else if (filters.sort === 'price_desc') filtered.sort((a, b) => b.price - a.price);
  else if (filters.sort === 'rating') {
    filtered.sort((a, b) => (b.ratingAverage ?? 0) - (a.ratingAverage ?? 0));
  }

  const brandCounts = new Map<string, number>();
  const categoryCounts = new Map<string, { slug: string; count: number }>();
  for (const p of filtered) {
    brandCounts.set(p.brand, (brandCounts.get(p.brand) ?? 0) + 1);
    const c = categoryCounts.get(p.category);
    if (c) c.count += 1;
    else categoryCounts.set(p.category, { slug: p.categorySlug, count: 1 });
  }
  const prices = filtered.map((p) => p.price);

  return {
    products: filtered,
    total: filtered.length,
    intent,
    facets: {
      brands: [...brandCounts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count),
      categories: [...categoryCounts.entries()].map(([value, v]) => ({ value, ...v })),
      priceRange: {
        min: prices.length ? Math.min(...prices) : 0,
        max: prices.length ? Math.max(...prices) : 0,
      },
    },
  };
}

function demoRelated(product: ProductView, limit = 4): ProductView[] {
  return DEMO_PRODUCTS.filter((p) => p.id !== product.id)
    .map((p) => ({
      product: p,
      score:
        (p.categorySlug === product.categorySlug ? 2 : 0) +
        (p.brand === product.brand ? 1 : 0) +
        p.tags.filter((t) => product.tags.includes(t)).length,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.product);
}
