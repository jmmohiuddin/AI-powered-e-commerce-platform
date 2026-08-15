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
/** A year. Exported so the privacy notice states the lifetime that is actually set. */
export const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

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

    /*
      THE HOMEPAGE REASSURANCE PANEL.
      Moved here from page.tsx, where it was hardcoded English and therefore
      rendered in English on the Arabic homepage — the one panel a hesitant
      shopper actually reads.

      `home.whyWarrantyBody` no longer says the IMEI is recorded. See the
      comment at its call site in app/page.tsx for why, and for what would have
      to become true before that sentence may return.
    */
    'home.whyWarrantyTitle': 'Official UAE warranty',
    'home.whyWarrantyBody':
      'Every handset carries the manufacturer’s regional warranty, and every order is invoiced — dated and carrying our TRN, which is the proof of purchase a service centre asks for.',
    'home.whyDeliveryTitle': 'Delivered across all seven emirates',
    'home.whyDeliveryBody':
      'Same-day in Dubai on orders before 2pm, next day to Abu Dhabi and Sharjah.',
    'home.whyPaymentTitle': 'Pay how you like',
    'home.whyPaymentBody':
      'Card, Apple Pay, Tabby in four instalments, or cash on delivery.',
    'home.whyStockTitle': 'Real stock counts',
    'home.whyStockBody': 'If the site says three left, there are three.',
    'home.categories': 'Shop by category',
    'home.browseAll': 'Browse everything',
    'home.deals': 'On offer now',
    'home.allDeals': 'See all deals',
    'home.popular': 'Popular right now',
    'home.topRated': 'Top rated',
    'home.emptyTitle': 'Nothing is listed yet.',
    'home.emptyBody':
      'This store has no published products at the moment. Please check back shortly.',

    'nav.home': 'Home',

    'category.emptyTitle': 'Nothing in this category yet.',
    'category.emptyBody': 'Try another category, or browse everything in the store.',
    'category.metaDescription':
      'Buy {name} in the UAE — genuine stock, official warranty, delivery across all seven emirates and cash on delivery.',

    'limit.title': 'Too many attempts.',
    'limit.orders': 'Please wait a few minutes before looking up another order.',
    'limit.search': 'Please wait a moment before searching again.',

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

    /* The four cards under "Delivery & payment" on a product page. Same story
       as the homepage panel: previously hardcoded English, and the warranty
       card previously promised IMEI recording. */
    'product.dpDeliveryTitle': 'Same-day in Dubai',
    'product.dpDeliveryBody':
      'Order before 2pm for same-day delivery in Dubai, next day to Abu Dhabi and Sharjah.',
    'product.dpPaymentTitle': 'Card, Apple Pay or Tabby',
    'product.dpPaymentBody':
      'Pay in full, or split into four interest-free payments with Tabby.',
    'product.dpCodTitle': 'Cash on delivery',
    'product.dpCodBody': 'Available across all seven emirates. Check the box before you pay.',
    'product.dpWarrantyTitle': 'Official UAE warranty',
    'product.dpWarrantyBody':
      '{n} months from the manufacturer, honoured here in the UAE. Your dated invoice is the proof of purchase.',

    'product.months': 'months',
    'product.reviews': 'reviews',
    'product.outOf5': 'out of 5',
    'product.gallery': 'Product images',
    'product.imageOf': 'Image {n} of {total}',

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
    'search.subcategories': 'Refine',
    'search.priceMin': 'Min price, AED',
    'search.priceMax': 'Max price, AED',
    'search.priceMinShort': 'Min',
    'search.priceMaxShort': 'Max',
    'search.priceApply': 'Apply',
    'search.pagination': 'Pagination',
    'search.previous': 'Previous',
    'search.next': 'Next',
    'search.pageN': 'Page {n}',
    'search.pageOf': 'Page {n} of {total}',
    'search.emptyTitle': 'Nothing matched that search.',
    'search.emptyBody': 'Try a broader search, or ask us on WhatsApp — we can often source a product that is not listed.',

    'deposit.legend': 'Deposit for cash on delivery',
    'deposit.explainer':
      'Pay {amount} now to confirm this order. It comes off your total — the courier collects the remaining {balance} in cash when your parcel arrives.',
    'deposit.refundCondition':
      'If we cancel the order or cannot deliver it, the deposit is refunded in full to the same card. If you refuse the delivery, the deposit covers the return courier cost and is not refunded.',
    'deposit.chooseCard': 'Pay the deposit with',
    'deposit.noCard':
      'No online payment method is available right now, so a deposit cannot be taken. Please message us and we will confirm your order another way.',

    'return.orderLabel': 'Order',
    'return.pendingBadge': 'Payment in progress',
    'return.pendingTitle': 'We’re confirming your payment',
    'return.pendingBody':
      'Your bank has not finished confirming this payment yet. This page checks again every few seconds — you can safely leave it open, or come back later and track the order. Nothing else is needed from you.',
    'return.failedBadge': 'Payment not completed',
    'return.failedTitle': 'That payment did not go through',
    'return.failedBody':
      'You have not been charged, and your basket is exactly as you left it. Try again with another card, or choose cash on delivery at checkout.',
    'return.retry': 'Back to checkout',
    'return.help': 'Talk to us',
    'return.whatsappMessage': 'Hello, I need help with payment for order #{n}.',
    'return.unknownTitle': 'We could not find that order',
    'return.unknownBody':
      'This browser has no order in progress — it can happen if cookies were cleared or the payment was finished on another device. If money has left your account, track the order with your order number and phone, or message us and we will find it.',

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

    'home.whyWarrantyTitle': 'ضمان رسمي في الإمارات',
    'home.whyWarrantyBody':
      'كل جهاز يحمل ضمان الشركة المصنّعة الإقليمي، ولكل طلب فاتورة مؤرّخة تحمل رقمنا الضريبي — وهي إثبات الشراء الذي يطلبه مركز الخدمة.',
    'home.whyDeliveryTitle': 'توصيل إلى الإمارات السبع',
    'home.whyDeliveryBody':
      'توصيل في نفس اليوم داخل دبي للطلبات قبل الساعة ٢ ظهراً، واليوم التالي إلى أبوظبي والشارقة.',
    'home.whyPaymentTitle': 'ادفع كما يناسبك',
    'home.whyPaymentBody': 'بالبطاقة أو Apple Pay أو تابي على أربع دفعات أو نقداً عند الاستلام.',
    'home.whyStockTitle': 'أرصدة مخزون حقيقية',
    'home.whyStockBody': 'إذا قال الموقع إنه بقي ثلاثة، فهناك ثلاثة فعلاً.',
    'home.categories': 'تسوق حسب الفئة',
    'home.browseAll': 'تصفح كل المنتجات',
    'home.deals': 'العروض الحالية',
    'home.allDeals': 'كل العروض',
    'home.popular': 'الأكثر رواجاً',
    'home.topRated': 'الأعلى تقييماً',
    'home.emptyTitle': 'لا توجد منتجات معروضة بعد.',
    'home.emptyBody': 'لا توجد منتجات منشورة في هذا المتجر حالياً. يرجى العودة قريباً.',

    'nav.home': 'الرئيسية',

    'category.emptyTitle': 'لا توجد منتجات في هذه الفئة بعد.',
    'category.emptyBody': 'جرّب فئة أخرى، أو تصفّح كل منتجات المتجر.',
    'category.metaDescription':
      'اشترِ {name} في الإمارات — منتجات أصلية بضمان رسمي، وتوصيل إلى جميع الإمارات السبع، والدفع عند الاستلام.',

    'limit.title': 'محاولات كثيرة جداً.',
    'limit.orders': 'يرجى الانتظار بضع دقائق قبل البحث عن طلب آخر.',
    'limit.search': 'يرجى الانتظار قليلاً قبل البحث مرة أخرى.',

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

    'product.dpDeliveryTitle': 'توصيل في نفس اليوم داخل دبي',
    'product.dpDeliveryBody':
      'اطلب قبل الساعة ٢ ظهراً للتوصيل في نفس اليوم داخل دبي، واليوم التالي إلى أبوظبي والشارقة.',
    'product.dpPaymentTitle': 'بطاقة أو Apple Pay أو تابي',
    'product.dpPaymentBody': 'ادفع المبلغ كاملاً، أو قسّمه على أربع دفعات بدون فوائد مع تابي.',
    'product.dpCodTitle': 'الدفع عند الاستلام',
    'product.dpCodBody': 'متاح في جميع الإمارات السبع. اختر هذا الخيار قبل الدفع.',
    'product.dpWarrantyTitle': 'ضمان رسمي في الإمارات',
    'product.dpWarrantyBody':
      '{n} شهراً من الشركة المصنّعة، معتمد داخل الإمارات. فاتورتك المؤرّخة هي إثبات الشراء.',

    'product.months': 'شهراً',
    'product.reviews': 'تقييم',
    'product.outOf5': 'من ٥',
    'product.gallery': 'صور المنتج',
    'product.imageOf': 'الصورة {n} من {total}',

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
    'search.subcategories': 'تصفية',
    'search.priceMin': 'أقل سعر بالدرهم',
    'search.priceMax': 'أعلى سعر بالدرهم',
    'search.priceMinShort': 'من',
    'search.priceMaxShort': 'إلى',
    'search.priceApply': 'تطبيق',
    'search.pagination': 'ترقيم الصفحات',
    'search.previous': 'السابق',
    'search.next': 'التالي',
    'search.pageN': 'صفحة {n}',
    'search.pageOf': 'صفحة {n} من {total}',
    'search.emptyTitle': 'لا توجد نتائج مطابقة.',
    'search.emptyBody': 'جرّب بحثاً أوسع، أو راسلنا على واتساب — يمكننا غالباً توفير منتج غير مدرج.',

    'deposit.legend': 'دفعة مقدمة للدفع عند الاستلام',
    'deposit.explainer':
      'ادفع {amount} الآن لتأكيد الطلب. يُخصم هذا المبلغ من إجمالي طلبك — ويحصّل مندوب التوصيل المبلغ المتبقي {balance} نقداً عند وصول الطرد.',
    'deposit.refundCondition':
      'إذا ألغينا الطلب أو تعذّر علينا توصيله، تُعاد الدفعة المقدمة بالكامل إلى البطاقة نفسها. أما إذا رفضت استلام الطرد، فتُستخدم الدفعة لتغطية تكلفة إعادة الشحن ولا تُعاد.',
    'deposit.chooseCard': 'ادفع الدفعة المقدمة بواسطة',
    'deposit.noCard':
      'لا تتوفر حالياً وسيلة دفع إلكتروني، لذا لا يمكن تحصيل الدفعة المقدمة. راسلنا وسنؤكد طلبك بطريقة أخرى.',

    'return.orderLabel': 'الطلب',
    'return.pendingBadge': 'جارٍ تنفيذ الدفع',
    'return.pendingTitle': 'نؤكد عملية الدفع الآن',
    'return.pendingBody':
      'لم ينتهِ البنك من تأكيد هذه العملية بعد. تتحقق هذه الصفحة تلقائياً كل بضع ثوانٍ — يمكنك تركها مفتوحة أو العودة لاحقاً وتتبّع الطلب. لا حاجة لأي إجراء منك.',
    'return.failedBadge': 'لم تكتمل عملية الدفع',
    'return.failedTitle': 'لم تتم عملية الدفع',
    'return.failedBody':
      'لم يتم خصم أي مبلغ، وسلّتك كما تركتها تماماً. جرّب بطاقة أخرى، أو اختر الدفع عند الاستلام عند إتمام الطلب.',
    'return.retry': 'العودة إلى إتمام الطلب',
    'return.help': 'تواصل معنا',
    'return.whatsappMessage': 'مرحباً، أحتاج مساعدة بخصوص الدفع للطلب رقم {n}.',
    'return.unknownTitle': 'لم نتمكن من العثور على هذا الطلب',
    'return.unknownBody':
      'لا يوجد طلب قيد التنفيذ في هذا المتصفح — قد يحدث ذلك عند مسح ملفات تعريف الارتباط أو إتمام الدفع على جهاز آخر. إذا خُصم المبلغ من حسابك، تتبّع الطلب برقم الطلب ورقم الهاتف، أو راسلنا وسنجده لك.',

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
