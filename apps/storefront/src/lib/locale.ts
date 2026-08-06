import { cookies } from 'next/headers';
import { directionFor } from '@voltix/ui';

/**
 * LOCALE RESOLUTION
 *
 * The UAE store ships English and Arabic. Arabic is not a translation layer
 * bolted on top — it changes text direction, numerals, date and currency
 * formatting, and the physical side of the page every margin sits on.
 *
 * HOW THE LOCALE IS CHOSEN, and the trade-off in that choice:
 *
 * A cookie set by the shopper's explicit choice, defaulting to English. Read in
 * the root layout, which opts the layout into dynamic rendering.
 *
 * The alternative is an `/[locale]/…` route segment, which keeps every page
 * statically generated per locale and is the right answer once Arabic traffic
 * is material — two prerendered trees instead of one dynamic one. It is not
 * done here because it doubles the route surface before there is any evidence
 * of Arabic demand, and the migration is mechanical when that evidence arrives.
 *
 * What is *not* deferred is the part that is expensive to retrofit: every
 * component below already uses logical CSS properties and `Intl` formatting, so
 * switching to route segments later moves files without touching styling or
 * formatting. Retrofitting `margin-left` → `margin-inline-start` across a
 * finished storefront is the painful version, and this avoids it.
 */

export const LOCALES = ['en-AE', 'ar-AE'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en-AE';
export const LOCALE_COOKIE = 'voltix_locale';

export function isLocale(value: string | undefined): value is Locale {
  return LOCALES.includes(value as Locale);
}

export async function resolveLocale(): Promise<Locale> {
  const store = await cookies();
  const value = store.get(LOCALE_COOKIE)?.value;
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export function directionOf(locale: Locale): 'ltr' | 'rtl' {
  return directionFor(locale);
}

/**
 * Interface copy.
 *
 * A flat dictionary rather than a translation library. The storefront has
 * fewer than fifty interface strings — product content is translated in the
 * database, not here — and adding an i18n runtime for fifty strings costs
 * bundle size and a build step to solve a problem this size does not have.
 * When the string count or the pluralisation rules outgrow it, swap the
 * `t()` implementation; the call sites do not change.
 */
const MESSAGES: Record<Locale, Record<string, string>> = {
  'en-AE': {
    'nav.search': 'Search products',
    'nav.searchPlaceholder': 'Search for a phone, charger or model number…',
    'nav.searchButton': 'Search',
    'nav.trackOrder': 'Track order',
    'nav.account': 'Account',
    'nav.cart': 'Cart',
    'nav.categories': 'Product categories',
    'nav.deals': 'Deals',
    'nav.skip': 'Skip to content',

    'home.heroTitle': 'Genuine electronics, delivered across the UAE.',
    'home.heroBody':
      'Official-warranty smartphones, accessories and computer gear. Pay by card, Apple Pay, Tabby, or cash on delivery.',
    'home.shopPhones': 'Shop smartphones',
    'home.whatsapp': 'Order on WhatsApp',
    'home.whyTitle': 'Why buy here',
    'home.categories': 'Shop by category',
    'home.browseAll': 'Browse everything',
    'home.deals': 'On offer now',
    'home.allDeals': 'See all deals',
    'home.popular': 'Popular right now',
    'home.topRated': 'Top rated',

    'product.chooseOption': 'Choose an option',
    'product.quantity': 'Quantity',
    'product.addToCart': 'Add to cart',
    'product.outOfStock': 'Out of stock',
    'product.whatYouGet': 'What you get',
    'product.specifications': 'Specifications',
    'product.commonQuestions': 'Common questions',
    'product.warranty': 'Warranty',
    'product.related': 'Frequently bought with this',
    'product.deliveryPayment': 'Delivery & payment',
    'product.months': 'months',
    'product.reviews': 'reviews',
    'product.outOf5': 'out of 5',

    'stock.inStock': 'In stock',
    'stock.only': 'Only {n} left',
    'stock.out': 'Out of stock',
    'stock.preorder': 'Available to pre-order',
    'stock.backorder': 'Available on backorder',

    'search.results': 'Results for “{q}”',
    'search.all': 'All products',
    'search.products': 'products',
    'search.product': 'product',
    'search.filter': 'Filter results',
    'search.category': 'Category',
    'search.allCategories': 'All categories',
    'search.brand': 'Brand',
    'search.allBrands': 'All brands',
    'search.availability': 'Availability',
    'search.inStockOnly': 'In stock only',
    'search.price': 'Price',
    'search.sort': 'Sort results',
    'search.relevance': 'Relevance',
    'search.priceAsc': 'Price: low to high',
    'search.priceDesc': 'Price: high to low',
    'search.rating': 'Rating',
    'search.emptyTitle': 'Nothing matched that search.',
    'search.emptyBody': 'Try a broader search, or ask us on WhatsApp — we can often source a product that is not listed.',

    'vat.inclusive': 'Price includes 5% VAT',
    'trust.cod': 'Cash on delivery available',
    'trust.dispatch': 'Same-day dispatch on orders before 2pm',
    'trust.replacement': '7-day replacement on manufacturing faults',

    'footer.shop': 'Shop',
    'footer.help': 'Help',
    'footer.buying': 'Buying',
    'footer.contact': 'Talk to us',
    'locale.switch': 'العربية',
  },
  'ar-AE': {
    'nav.search': 'البحث عن المنتجات',
    'nav.searchPlaceholder': 'ابحث عن هاتف أو شاحن أو رقم موديل…',
    'nav.searchButton': 'بحث',
    'nav.trackOrder': 'تتبع الطلب',
    'nav.account': 'حسابي',
    'nav.cart': 'السلة',
    'nav.categories': 'فئات المنتجات',
    'nav.deals': 'العروض',
    'nav.skip': 'تخطي إلى المحتوى',

    'home.heroTitle': 'إلكترونيات أصلية، تُوصَّل في جميع أنحاء الإمارات.',
    'home.heroBody':
      'هواتف ذكية وملحقات وأجهزة كمبيوتر بضمان رسمي. ادفع بالبطاقة أو Apple Pay أو تابي أو نقداً عند الاستلام.',
    'home.shopPhones': 'تسوق الهواتف',
    'home.whatsapp': 'اطلب عبر واتساب',
    'home.whyTitle': 'لماذا تشتري من هنا',
    'home.categories': 'تسوق حسب الفئة',
    'home.browseAll': 'تصفح كل المنتجات',
    'home.deals': 'العروض الحالية',
    'home.allDeals': 'كل العروض',
    'home.popular': 'الأكثر رواجاً',
    'home.topRated': 'الأعلى تقييماً',

    'product.chooseOption': 'اختر النسخة',
    'product.quantity': 'الكمية',
    'product.addToCart': 'أضف إلى السلة',
    'product.outOfStock': 'غير متوفر',
    'product.whatYouGet': 'ماذا ستحصل عليه',
    'product.specifications': 'المواصفات',
    'product.commonQuestions': 'أسئلة شائعة',
    'product.warranty': 'الضمان',
    'product.related': 'يُشترى عادةً مع هذا المنتج',
    'product.deliveryPayment': 'التوصيل والدفع',
    'product.months': 'شهراً',
    'product.reviews': 'تقييم',
    'product.outOf5': 'من ٥',

    'stock.inStock': 'متوفر',
    'stock.only': 'بقي {n} فقط',
    'stock.out': 'غير متوفر',
    'stock.preorder': 'متاح للطلب المسبق',
    'stock.backorder': 'متاح عند التوفر',

    'search.results': 'نتائج البحث عن «{q}»',
    'search.all': 'كل المنتجات',
    'search.products': 'منتجات',
    'search.product': 'منتج',
    'search.filter': 'تصفية النتائج',
    'search.category': 'الفئة',
    'search.allCategories': 'كل الفئات',
    'search.brand': 'العلامة التجارية',
    'search.allBrands': 'كل العلامات',
    'search.availability': 'التوفر',
    'search.inStockOnly': 'المتوفر فقط',
    'search.price': 'السعر',
    'search.sort': 'ترتيب النتائج',
    'search.relevance': 'الأكثر صلة',
    'search.priceAsc': 'السعر: من الأقل للأعلى',
    'search.priceDesc': 'السعر: من الأعلى للأقل',
    'search.rating': 'التقييم',
    'search.emptyTitle': 'لا توجد نتائج مطابقة.',
    'search.emptyBody': 'جرّب بحثاً أوسع، أو راسلنا على واتساب — يمكننا غالباً توفير منتج غير مدرج.',

    'vat.inclusive': 'السعر شامل ضريبة القيمة المضافة ٥٪',
    'trust.cod': 'الدفع عند الاستلام متاح',
    'trust.dispatch': 'الشحن في نفس اليوم للطلبات قبل الساعة ٢ ظهراً',
    'trust.replacement': 'استبدال خلال ٧ أيام لعيوب التصنيع',

    'footer.shop': 'تسوق',
    'footer.help': 'المساعدة',
    'footer.buying': 'الشراء',
    'footer.contact': 'تواصل معنا',
    'locale.switch': 'English',
  },
};

export function translator(locale: Locale) {
  return (key: string, params?: Record<string, string | number>): string => {
    const template = MESSAGES[locale][key] ?? MESSAGES[DEFAULT_LOCALE][key] ?? key;
    if (!params) return template;
    return Object.entries(params).reduce(
      (text, [name, value]) => text.replace(`{${name}}`, String(value)),
      template,
    );
  };
}

export type Translate = ReturnType<typeof translator>;
