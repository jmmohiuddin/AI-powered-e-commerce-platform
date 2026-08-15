import type { Locale } from './locale';

/**
 * PRIVACY AND TERMS COPY, IN BOTH LOCALES.
 *
 * A separate module from `lib/locale.ts` on purpose. That file is an interface
 * dictionary and says so — "fewer than fifty interface strings" is the premise
 * that justifies a flat `Record` and no i18n runtime. Two policy documents are
 * several hundred sentences and would drown it. The call-site ergonomics are
 * the same: `legalCopy(locale)` in, strings out.
 *
 * WHAT IS *NOT* IN HERE, AND WHY THAT IS THE POINT.
 *
 * No number and no legal identifier is written down in this file. The VAT rate,
 * the return window, the invoice threshold, the cookie names and lifetimes, the
 * merchant's legal name, TRN and trade licence, and the list of payment
 * processors are all passed in by the page from the constants and tables the
 * rest of the system already runs on. This is the rule `app/delivery/page.tsx`
 * established — it probes `deliveryFee()` rather than printing a table — and it
 * matters more here than there: a published privacy notice that disagrees with
 * what the software does is not a stale paragraph, it is a false statement to a
 * data subject and to a regulator.
 *
 * Sentences that would name a value we cannot read are simply absent. Where a
 * value is unset, the page omits the line. There are no placeholders anywhere
 * in this file for the same reason there are none in `lib/contact.ts`: a
 * plausible-looking fake registered address on a privacy page tells someone
 * where to send a request that nobody will ever receive.
 */

/**
 * The date these documents were last substantively changed.
 *
 * Hand-maintained, and it has to be: nothing in the repository knows the
 * difference between rewording a sentence and changing what the merchant
 * actually does with someone's data, and only the second kind should reset the
 * clock a reader uses to decide whether to re-read. Bump it when the substance
 * changes, not when a typo is fixed.
 */
export const LEGAL_LAST_UPDATED = new Date('2026-08-15T00:00:00Z');

export function formatLegalDate(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Dubai',
  }).format(date);
}

export interface LegalCopy {
  readonly privacy: PrivacyCopy;
  readonly terms: TermsCopy;
  /** Shared chrome. */
  readonly lastUpdated: string;
  readonly lastUpdatedLabel: string;
  readonly seeAlsoPrivacy: string;
  readonly seeAlsoTerms: string;
  readonly contactUs: string;
  readonly deliveryPage: string;
  readonly returnsPage: string;
  /**
   * Link labels for use *inside* a sentence, as opposed to the nav-style labels
   * above. A sentence has to be split around its link rather than have one
   * appended, or it reads "…is on the delivery page. Delivery & charges." —
   * and the split has to be per-language, because the clause the link belongs
   * to does not sit in the same place in Arabic as in English.
   */
  readonly deliveryPageInline: string;
  readonly returnsPageInline: string;
  readonly contactPageInline: string;
}

interface PrivacyCopy {
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly title: string;
  readonly intro: string;

  readonly controllerHeading: string;
  readonly controllerIntro: string;
  readonly controllerTrn: string;
  readonly controllerLicence: string;
  readonly controllerAddress: string;
  readonly controllerUnknown: string;

  readonly collectHeading: string;
  readonly collectIntro: string;
  readonly collectRequired: string;
  readonly collectOptional: string;
  readonly collectBusiness: string;
  readonly collectOrder: string;
  readonly collectNoAccount: string;
  readonly collectNoCard: string;

  readonly basisHeading: string;
  readonly basisContract: string;
  readonly basisLegal: string;
  readonly basisInterest: string;

  readonly cookiesHeading: string;
  readonly cookiesIntro: string;
  readonly cookieColName: string;
  readonly cookieColPurpose: string;
  readonly cookieColLifetime: string;
  readonly cookieDays: string;
  readonly cookieCart: string;
  readonly cookieLocale: string;
  readonly cookiesNone: string;

  readonly technicalHeading: string;
  readonly technicalBody: string;

  readonly transferHeading: string;
  readonly transferBody: string;
  readonly transferReview: string;

  readonly recipientsHeading: string;
  readonly recipientsIntro: string;
  readonly recipientsPayment: string;
  readonly recipientsPaymentNone: string;
  readonly recipientsCourier: string;
  readonly recipientsMessaging: string;
  readonly recipientsNoSale: string;

  readonly retentionHeading: string;
  readonly retentionBody: string;
  readonly retentionHonest: string;

  readonly rightsHeading: string;
  readonly rightsIntro: string;
  readonly rightsList: readonly string[];
  readonly rightsHowBefore: string;
  readonly rightsHowAfter: string;
  readonly rightsVerify: string;

  readonly securityHeading: string;
  readonly securityBody: string;
  readonly breachBody: string;

  readonly changesHeading: string;
  readonly changesBody: string;
}

interface TermsCopy {
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly title: string;
  readonly intro: string;

  readonly sellerHeading: string;
  readonly sellerIntro: string;
  readonly sellerUnknown: string;

  readonly pricesHeading: string;
  readonly pricesBody: string;
  readonly pricesDeliveryBefore: string;
  readonly pricesDeliveryAfter: string;

  readonly invoiceHeading: string;
  readonly invoiceBody: string;
  readonly invoiceFull: string;

  readonly warrantyHeading: string;
  readonly warrantyBody: string;
  readonly warrantyNoImei: string;

  readonly returnsHeading: string;
  readonly returnsBodyBefore: string;
  readonly returnsBodyAfter: string;

  readonly paymentHeading: string;
  readonly paymentBody: string;
  readonly paymentNone: string;

  readonly orderHeading: string;
  readonly orderBody: string;

  readonly lawHeading: string;
  readonly lawBody: string;
}

const EN: Omit<LegalCopy, 'lastUpdated'> = {
  lastUpdatedLabel: 'Last updated',
  seeAlsoPrivacy: 'Privacy notice',
  seeAlsoTerms: 'Terms of sale',
  contactUs: 'Contact us',
  deliveryPage: 'Delivery & charges',
  returnsPage: 'Returns & warranty',
  deliveryPageInline: 'delivery page',
  returnsPageInline: 'returns page',
  contactPageInline: 'contact page',

  privacy: {
    metaTitle: 'Privacy notice',
    metaDescription:
      'What personal data this store collects, why, where it is processed, which cookies are set, and how to ask for a copy or for deletion.',
    title: 'Privacy notice',
    intro:
      'This describes what we do with your personal data, written against what the software actually does rather than against a template. If a paragraph here and the shop disagree, the paragraph is the bug — please tell us.',

    controllerHeading: 'Who is responsible for your data',
    controllerIntro: 'The seller and data controller is:',
    controllerTrn: 'Tax Registration Number',
    controllerLicence: 'Trade licence',
    controllerAddress: 'Registered address',
    controllerUnknown:
      'The licensing details of the seller are not published on this page yet. Please ask us for them before you order — you are entitled to know who you are buying from.',

    collectHeading: 'What we collect',
    collectIntro: 'Everything below is something you type into the checkout, or a direct consequence of placing an order. There is nothing else.',
    collectRequired:
      'To deliver an order we need your full name, a UAE mobile number, the emirate, and your area or community — plus a building name or a Makani number, because without one of those a courier cannot find the door.',
    collectOptional:
      'Optional, and only if you offer them: an email address, a flat or villa number, a Makani number, and a delivery note.',
    collectBusiness:
      'If you are buying for a business and give us your Tax Registration Number, we store it on that order. It is what makes the sale a business supply and obliges us to issue a full tax invoice carrying your number.',
    collectOrder:
      'We also keep the order itself: what you bought, what it cost, the delivery charge, the VAT, which payment method you chose, and the delivery address exactly as it was when the order shipped.',
    collectNoAccount:
      'There are no customer accounts on this store, so there is no password, no profile and no browsing history tied to a person. Order tracking uses your order number and the mobile number you ordered with.',
    collectNoCard:
      'We never see your card number. Card and instalment payments are completed on the payment provider’s own page; your card details are never sent to this site and are never stored by us.',

    basisHeading: 'Why we are allowed to hold it',
    basisContract:
      'Performing our contract with you. Name, phone, address and order contents exist so that we can take the order, deliver it, and handle a return.',
    basisLegal:
      'Meeting a legal obligation. UAE tax law requires us to issue and retain invoices, and to be able to attribute a sale to the emirate it was received in.',
    basisInterest:
      'Our legitimate interest in running the shop safely — specifically, limiting how many times the order-tracking page can be queried, which is what stops someone walking through order numbers to find out who bought what.',

    cookiesHeading: 'Cookies',
    cookiesIntro: 'This site sets two cookies. Both are strictly necessary, which is why there is no consent banner.',
    cookieColName: 'Cookie',
    cookieColPurpose: 'What it does',
    cookieColLifetime: 'Lifetime',
    cookieDays: '{n} days',
    cookieCart:
      'Identifies your basket so the items you added are still there on the next page. It is set only once you interact with the basket, it holds a random token and nothing about you, and it cannot be read by JavaScript.',
    cookieLocale:
      'Remembers whether you chose English or Arabic. Set only when you press the language switch.',
    cookiesNone:
      'There is no analytics cookie, no advertising cookie, no tracking pixel and no third-party script on this site. That is a deliberate decision rather than an omission: an identifier set on ordinary browsing in order to measure behaviour would need consent, and this store has no consent mechanism to offer you.',

    technicalHeading: 'Your IP address',
    technicalBody:
      'Our servers see your IP address on every request, as any web server does. We count requests against it for a few minutes at a time to rate-limit the order-tracking page, then the counter expires. It is not written to your order and we do not build a profile from it.',

    transferHeading: 'Where your data is processed — outside the UAE',
    transferBody:
      'Our database is hosted in Singapore (the ap-southeast-1 region) and the site is served from Singapore as well. So although the shop, the stock and you are in the UAE, your personal data is stored and processed outside the country. We are telling you this plainly because under the UAE Personal Data Protection Law a cross-border transfer is something you are entitled to know about before you order, not something to find in a footnote.',
    transferReview:
      'The hosting region is under review for exactly this reason. If it moves, this page changes with it.',

    recipientsHeading: 'Who else sees it',
    recipientsIntro: 'We do not sell your data. It is shared only where an order cannot be completed without it:',
    recipientsPayment:
      'The payment provider you choose at checkout. This store is currently able to take payment through: {providers}. They receive what they need to process the payment and are responsible for your card details, which we never hold.',
    recipientsPaymentNone:
      'A payment provider, when one is enabled for online payment. None is enabled on this store at the moment.',
    recipientsCourier:
      'The courier delivering your order, who receives your name, phone number and delivery address — that is the delivery.',
    recipientsMessaging:
      'The provider that sends order emails and messages on our behalf, which receives your email address or mobile number and the contents of that message.',
    recipientsNoSale:
      'Beyond these, and beyond a lawful request from an authority, nobody. We do not share your data with advertisers or data brokers, and there is no code in this store that could.',

    retentionHeading: 'How long we keep it',
    retentionBody:
      'Orders and invoices are kept for as long as tax and consumer-protection record-keeping require, which is longer than the order itself takes. That is not optional for us: an invoice we have deleted is one we cannot produce to the tax authority or to you.',
    retentionHonest:
      'To be straight with you: there is no automatic deletion schedule running in the background today. If you ask us to delete what we can delete, a person does it. We would rather say that than publish a retention period nothing enforces.',

    rightsHeading: 'Your rights, and how to use them',
    rightsIntro: 'Under the UAE Personal Data Protection Law you can ask us to:',
    rightsList: [
      'give you a copy of the personal data we hold about you',
      'correct anything that is wrong — a misspelt name or a wrong address',
      'delete what we are not legally required to keep',
      'stop using it for a particular purpose, or object to how we are using it',
      'explain any of the above, including this page',
    ],
    rightsHowBefore: 'Ask through any of the channels on our ',
    rightsHowAfter:
      '. There is no separate form, and that is on purpose — a request form that lands in a mailbox nobody watches is worse than an address that reaches a person. A person handles these.',
    rightsVerify:
      'We will ask you for the order number and the mobile number you ordered with before we send anything. Handing someone’s order history to whoever asks for it would itself be the breach.',

    securityHeading: 'How it is protected',
    securityBody:
      'Traffic to this site is encrypted. Order records are isolated per merchant in the database and reachable only by authenticated staff accounts. Card details never reach our servers at all, which is the strongest protection available for the most sensitive thing in a purchase — we cannot lose what we never had.',
    breachBody:
      'If personal data is ever breached in a way that puts you at risk, we will tell you and notify the regulator.',

    changesHeading: 'Changes to this notice',
    changesBody:
      'When what we do with your data changes, this page changes first and the date below moves. It is not versioned behind a login or buried in a PDF.',
  },

  terms: {
    metaTitle: 'Terms of sale',
    metaDescription:
      'Who you are buying from, how prices and VAT work, what invoice you get, what the warranty covers, and how returns and payment work.',
    title: 'Terms of sale',
    intro:
      'The terms you buy under. Short, and specific to what this shop actually does.',

    sellerHeading: 'Who you are buying from',
    sellerIntro:
      'UAE consumer-protection law requires a seller to tell you which licensed entity is behind the shop. That is:',
    sellerUnknown:
      'The licensing details of the seller are not published on this page yet. Please ask us for them before you order.',

    pricesHeading: 'Prices and VAT',
    pricesBody:
      'Every price on this site includes {vatRate}% VAT, as UAE law requires for consumer prices. The price shown is the price charged — we do not add tax at checkout, and we will never charge you more than the price you saw.',
    pricesDeliveryBefore:
      'Delivery is charged separately where it applies, and the charge is shown before you pay. The full table is on the ',
    pricesDeliveryAfter: '.',

    invoiceHeading: 'Your invoice',
    invoiceBody:
      'Every order is invoiced, dated, and carries our Tax Registration Number. Keep it — it is your proof of purchase, and it is what a service centre asks to see on a warranty claim.',
    invoiceFull:
      'Where you give us a Tax Registration Number, or the order comes to more than {threshold}, you receive a full tax invoice rather than a simplified one, so a business buyer can reclaim the input VAT.',

    warrantyHeading: 'Warranty',
    // No number in this sentence, deliberately. The warranty length is per
    // product (`products.warranty_months`, defaulted from the brand), so any
    // figure written here would be a second, unmaintained answer to a question
    // the product page already answers correctly.
    warrantyBody:
      'Products carry the manufacturer’s warranty, honoured here in the UAE. The length is shown on each product page — twelve months on most things, longer on some brands and on some accessories. Your dated invoice is the proof of purchase a claim needs.',
    warrantyNoImei:
      'To be precise about one thing, because it is easy to assume otherwise: we do not record device serial numbers or IMEIs against your order. Your warranty is evidenced by the invoice, not by a serial number we hold on file.',

    returnsHeading: 'Returns',
    returnsBodyBefore:
      'You may return an unused item in its original packaging within {days} days of delivery for a full refund, and a faulty item within {defectDays} days. The detail, including what cannot be returned once opened, is on the ',
    returnsBodyAfter: '.',

    paymentHeading: 'Paying',
    paymentBody: 'This store currently accepts: {providers}.',
    paymentNone: 'No online payment method is enabled on this store at the moment.',

    orderHeading: 'When the order is binding',
    orderBody:
      'Placing an order is an offer to buy. It is accepted when we confirm it, and we may decline one — most often because the last unit sold in the minutes before you paid. If we decline after taking payment, you get the money back in full.',

    lawHeading: 'Governing law',
    lawBody:
      'These terms are governed by the laws of the United Arab Emirates. Nothing here limits your statutory rights as a consumer.',
  },
};

const AR: Omit<LegalCopy, 'lastUpdated'> = {
  lastUpdatedLabel: 'آخر تحديث',
  seeAlsoPrivacy: 'إشعار الخصوصية',
  seeAlsoTerms: 'شروط البيع',
  contactUs: 'تواصل معنا',
  deliveryPage: 'التوصيل والرسوم',
  returnsPage: 'الإرجاع والضمان',
  deliveryPageInline: 'صفحة التوصيل',
  returnsPageInline: 'صفحة الإرجاع',
  contactPageInline: 'صفحة التواصل',

  privacy: {
    metaTitle: 'إشعار الخصوصية',
    metaDescription:
      'ما البيانات الشخصية التي يجمعها هذا المتجر، ولماذا، وأين تُعالَج، وما ملفات تعريف الارتباط المستخدمة، وكيف تطلب نسخة من بياناتك أو حذفها.',
    title: 'إشعار الخصوصية',
    intro:
      'يوضّح هذا الإشعار ما نفعله ببياناتك الشخصية، وهو مكتوب استناداً إلى ما يفعله النظام فعلاً لا إلى نموذج جاهز. إذا اختلفت فقرة هنا عمّا يفعله المتجر، فالخطأ في الفقرة — أخبرنا رجاءً.',

    controllerHeading: 'من المسؤول عن بياناتك',
    controllerIntro: 'البائع والمتحكّم في البيانات هو:',
    controllerTrn: 'رقم التسجيل الضريبي',
    controllerLicence: 'الرخصة التجارية',
    controllerAddress: 'العنوان المسجّل',
    controllerUnknown:
      'لم تُنشر بعد بيانات ترخيص البائع على هذه الصفحة. اسألنا عنها قبل الطلب — من حقك أن تعرف ممّن تشتري.',

    collectHeading: 'ما الذي نجمعه',
    collectIntro:
      'كل ما يلي إمّا تكتبه أنت عند إتمام الطلب، أو ينتج مباشرةً عن تقديم الطلب. لا شيء غير ذلك.',
    collectRequired:
      'لتوصيل الطلب نحتاج اسمك الكامل، ورقم هاتف متحرك إماراتي، والإمارة، والمنطقة أو المجمّع — إضافةً إلى اسم المبنى أو رقم مكاني، فبدون أحدهما لا يستطيع المندوب الوصول إلى بابك.',
    collectOptional:
      'اختيارية، ولا نأخذها إلا إذا قدّمتها: البريد الإلكتروني، ورقم الشقة أو الفيلا، ورقم مكاني، وملاحظة التوصيل.',
    collectBusiness:
      'إذا كنت تشتري لحساب منشأة وأعطيتنا رقم تسجيلك الضريبي، فإننا نحفظه على ذلك الطلب. وهو ما يجعل البيع توريداً تجارياً ويلزمنا بإصدار فاتورة ضريبية كاملة تحمل رقمك.',
    collectOrder:
      'نحتفظ أيضاً بالطلب نفسه: ما اشتريته، وقيمته، ورسوم التوصيل، وضريبة القيمة المضافة، ووسيلة الدفع التي اخترتها، وعنوان التوصيل كما كان وقت الشحن.',
    collectNoAccount:
      'لا توجد حسابات عملاء في هذا المتجر، فلا كلمة مرور ولا ملف شخصي ولا سجل تصفّح مرتبط بشخص. ويعتمد تتبّع الطلب على رقم الطلب ورقم الهاتف الذي طلبت به.',
    collectNoCard:
      'نحن لا نرى رقم بطاقتك إطلاقاً. تتم مدفوعات البطاقات والتقسيط على صفحة مزوّد الدفع نفسه؛ ولا تُرسل بيانات بطاقتك إلى هذا الموقع ولا نخزّنها.',

    basisHeading: 'الأساس القانوني لاحتفاظنا بها',
    basisContract:
      'تنفيذ العقد المبرم معك. فالاسم والهاتف والعنوان ومحتويات الطلب موجودة لكي نستلم الطلب ونوصّله ونعالج أي إرجاع.',
    basisLegal:
      'الوفاء بالتزام قانوني. يلزمنا القانون الضريبي الإماراتي بإصدار الفواتير والاحتفاظ بها، وبأن نكون قادرين على نسبة كل عملية بيع إلى الإمارة التي استُلمت فيها.',
    basisInterest:
      'مصلحتنا المشروعة في تشغيل المتجر بأمان — تحديداً الحدّ من عدد الاستعلامات على صفحة تتبّع الطلبات، وهو ما يمنع أي شخص من تصفّح أرقام الطلبات لمعرفة من اشترى ماذا.',

    cookiesHeading: 'ملفات تعريف الارتباط',
    cookiesIntro:
      'يستخدم هذا الموقع ملفَّي تعريف ارتباط فقط، وكلاهما ضروري تماماً — ولهذا لا توجد نافذة موافقة.',
    cookieColName: 'الملف',
    cookieColPurpose: 'وظيفته',
    cookieColLifetime: 'مدة البقاء',
    cookieDays: '{n} يوماً',
    cookieCart:
      'يحدّد سلّتك لتبقى المنتجات التي أضفتها موجودة في الصفحة التالية. لا يُنشأ إلا عند تفاعلك مع السلّة، ويحمل رمزاً عشوائياً لا يتضمّن أي شيء عنك، ولا يمكن لجافاسكريبت قراءته.',
    cookieLocale:
      'يتذكّر ما إذا اخترت العربية أو الإنجليزية. ولا يُنشأ إلا عند ضغطك على زر تبديل اللغة.',
    cookiesNone:
      'لا يوجد في هذا الموقع ملف تعريف ارتباط للتحليلات ولا للإعلانات، ولا بكسل تتبّع، ولا أي نص برمجي خارجي. وهذا قرار مقصود لا إغفال: فالمعرّف الذي يُنشأ أثناء التصفّح العادي لقياس السلوك يتطلّب موافقة، ولا يملك هذا المتجر آلية موافقة يعرضها عليك.',

    technicalHeading: 'عنوان IP الخاص بك',
    technicalBody:
      'ترى خوادمنا عنوان IP الخاص بك مع كل طلب، شأنها شأن أي خادم ويب. ونعدّ الطلبات مقابله لدقائق معدودة في كل مرة للحدّ من معدّل الاستعلام على صفحة تتبّع الطلبات، ثم ينتهي العدّاد. ولا يُكتب هذا العنوان في طلبك ولا نبني منه ملفاً عنك.',

    transferHeading: 'أين تُعالَج بياناتك — خارج الإمارات',
    transferBody:
      'قاعدة بياناتنا مستضافة في سنغافورة (منطقة ap-southeast-1)، ويُقدَّم الموقع من سنغافورة أيضاً. أي أنه رغم وجود المتجر والمخزون ووجودك أنت في الإمارات، فإن بياناتك الشخصية تُخزَّن وتُعالَج خارج الدولة. ونقول ذلك صراحةً لأن قانون حماية البيانات الشخصية في الإمارات يجعل نقل البيانات عبر الحدود أمراً من حقك معرفته قبل الطلب، لا تفصيلاً يُدفن في هامش.',
    transferReview:
      'منطقة الاستضافة قيد المراجعة لهذا السبب تحديداً. وإذا تغيّرت، تتغيّر هذه الصفحة معها.',

    recipientsHeading: 'من يطّلع عليها أيضاً',
    recipientsIntro:
      'نحن لا نبيع بياناتك. ولا تُشارك إلا حيث يتعذّر إتمام الطلب بدونها:',
    recipientsPayment:
      'مزوّد الدفع الذي تختاره عند إتمام الطلب. يستطيع هذا المتجر حالياً تحصيل المدفوعات عبر: {providers}. ويتلقّى المزوّد ما يلزمه لمعالجة الدفع، وهو المسؤول عن بيانات بطاقتك التي لا نحتفظ بها نحن أبداً.',
    recipientsPaymentNone:
      'مزوّد دفع، عند تفعيل أحدهم للدفع الإلكتروني. ولا يوجد أي مزوّد مفعّل في هذا المتجر حالياً.',
    recipientsCourier:
      'شركة التوصيل التي تسلّم طلبك، وتتلقّى اسمك ورقم هاتفك وعنوان التوصيل — فذلك هو التوصيل نفسه.',
    recipientsMessaging:
      'المزوّد الذي يرسل رسائل الطلب وبريده نيابةً عنّا، ويتلقّى بريدك الإلكتروني أو رقم هاتفك ومحتوى تلك الرسالة.',
    recipientsNoSale:
      'وما عدا هؤلاء، وما عدا طلباً قانونياً من جهة مختصة، لا أحد. نحن لا نشارك بياناتك مع المعلنين أو وسطاء البيانات، ولا يوجد في هذا المتجر أي كود يمكّنه من ذلك.',

    retentionHeading: 'مدة الاحتفاظ',
    retentionBody:
      'نحتفظ بالطلبات والفواتير طوال المدة التي يفرضها حفظ السجلات الضريبية وسجلات حماية المستهلك، وهي أطول من عمر الطلب نفسه. وليس هذا خياراً لنا: الفاتورة التي نحذفها هي فاتورة لا نستطيع تقديمها للهيئة الضريبية ولا لك.',
    retentionHonest:
      'ولنكن صريحين معك: لا يوجد اليوم جدول حذف تلقائي يعمل في الخلفية. فإذا طلبت منّا حذف ما يمكن حذفه، يقوم بذلك شخص. ونفضّل قول ذلك على نشر مدة احتفاظ لا ينفّذها شيء.',

    rightsHeading: 'حقوقك وكيفية استخدامها',
    rightsIntro: 'بموجب قانون حماية البيانات الشخصية في الإمارات، يمكنك أن تطلب منّا:',
    rightsList: [
      'تزويدك بنسخة من بياناتك الشخصية لدينا',
      'تصحيح أي معلومة خاطئة — اسم مكتوب بخطأ أو عنوان غير صحيح',
      'حذف ما لا يلزمنا القانون بالاحتفاظ به',
      'التوقّف عن استخدامها لغرض معيّن، أو الاعتراض على طريقة استخدامنا لها',
      'شرح أيٍّ ممّا سبق، بما في ذلك هذه الصفحة',
    ],
    rightsHowBefore: 'اطلب ذلك عبر أي من قنوات ',
    rightsHowAfter:
      '. لا يوجد نموذج منفصل، وهذا مقصود — فنموذج طلبات يصل إلى صندوق بريد لا يتابعه أحد أسوأ من عنوان يصل إلى شخص. ويتولّى هذه الطلبات شخص فعلاً.',
    rightsVerify:
      'سنطلب منك رقم الطلب ورقم الهاتف الذي طلبت به قبل أن نرسل أي شيء. فتسليم سجلّ طلبات شخص ما لأي سائل يكون هو نفسه الاختراق.',

    securityHeading: 'كيف تُحمى',
    securityBody:
      'حركة البيانات إلى هذا الموقع مشفّرة. وسجلات الطلبات معزولة لكل تاجر داخل قاعدة البيانات ولا يصل إليها إلا حسابات موظفين موثّقة. أما بيانات البطاقات فلا تصل إلى خوادمنا أصلاً، وهي أقوى حماية ممكنة لأكثر عنصر حساسية في عملية الشراء — فلا يمكننا أن نفقد ما لم نملكه قط.',
    breachBody:
      'إذا تعرّضت بيانات شخصية لاختراق يعرّضك للخطر، فسنُبلغك ونُبلغ الجهة الرقابية.',

    changesHeading: 'التعديلات على هذا الإشعار',
    changesBody:
      'عندما يتغيّر ما نفعله ببياناتك، تتغيّر هذه الصفحة أولاً ويتحرّك التاريخ أدناه. ولا تُخفى خلف تسجيل دخول ولا تُدفن في ملف PDF.',
  },

  terms: {
    metaTitle: 'شروط البيع',
    metaDescription:
      'ممّن تشتري، وكيف تُحتسب الأسعار وضريبة القيمة المضافة، وما الفاتورة التي تحصل عليها، وما الذي يغطّيه الضمان، وكيف يعمل الإرجاع والدفع.',
    title: 'شروط البيع',
    intro: 'الشروط التي تشتري بموجبها. موجزة، ومحدّدة بما يفعله هذا المتجر فعلاً.',

    sellerHeading: 'ممّن تشتري',
    sellerIntro:
      'يلزم قانون حماية المستهلك في الإمارات البائع بالإفصاح عن الجهة المرخّصة التي تقف خلف المتجر. وهي:',
    sellerUnknown:
      'لم تُنشر بعد بيانات ترخيص البائع على هذه الصفحة. اسألنا عنها قبل الطلب.',

    pricesHeading: 'الأسعار وضريبة القيمة المضافة',
    pricesBody:
      'كل سعر في هذا الموقع شامل ضريبة القيمة المضافة بنسبة {vatRate}٪، كما يوجب القانون الإماراتي في أسعار المستهلك. والسعر المعروض هو السعر المحصَّل — لا نضيف ضريبة عند الدفع، ولن نحمّلك أكثر ممّا رأيت.',
    pricesDeliveryBefore:
      'تُحتسب رسوم التوصيل على حدة حيثما تنطبق، وتُعرض قبل الدفع. والجدول الكامل في ',
    pricesDeliveryAfter: '.',

    invoiceHeading: 'فاتورتك',
    invoiceBody:
      'لكل طلب فاتورة مؤرّخة تحمل رقم تسجيلنا الضريبي. احتفظ بها — فهي إثبات الشراء، وهي ما يطلب مركز الخدمة الاطّلاع عليه عند المطالبة بالضمان.',
    invoiceFull:
      'إذا أعطيتنا رقم تسجيل ضريبي، أو تجاوز الطلب {threshold}، تحصل على فاتورة ضريبية كاملة بدلاً من المبسّطة، ليتمكّن المشتري التجاري من استرداد ضريبة المدخلات.',

    warrantyHeading: 'الضمان',
    warrantyBody:
      'تحمل المنتجات ضمان الشركة المصنّعة، معتمداً هنا في الإمارات. والمدة معروضة في صفحة كل منتج — اثنا عشر شهراً في معظم المنتجات، وأطول لدى بعض العلامات وبعض الملحقات. وفاتورتك المؤرّخة هي إثبات الشراء الذي تحتاجه أي مطالبة.',
    warrantyNoImei:
      'ونوضّح نقطة واحدة بدقّة لأن من السهل افتراض غير ذلك: نحن لا نسجّل الأرقام التسلسلية للأجهزة ولا أرقام IMEI على طلبك. ضمانك يُثبَت بالفاتورة، لا برقم تسلسلي محفوظ لدينا.',

    returnsHeading: 'الإرجاع',
    returnsBodyBefore:
      'يمكنك إرجاع أي منتج غير مستعمل بعبوته الأصلية خلال {days} يوماً من الاستلام لاسترداد كامل المبلغ، وإرجاع المنتج المعيب خلال {defectDays} يوماً. والتفاصيل، بما فيها ما لا يمكن إرجاعه بعد فتحه، في ',
    returnsBodyAfter: '.',

    paymentHeading: 'الدفع',
    paymentBody: 'يقبل هذا المتجر حالياً: {providers}.',
    paymentNone: 'لا توجد وسيلة دفع إلكتروني مفعّلة في هذا المتجر حالياً.',

    orderHeading: 'متى يصبح الطلب ملزماً',
    orderBody:
      'تقديم الطلب هو عرض بالشراء. ويصبح مقبولاً عند تأكيدنا له، ويجوز لنا رفض طلب — وغالباً لأن آخر قطعة بيعت في الدقائق التي سبقت دفعك. وإذا رفضناه بعد استلام المبلغ، يُعاد إليك كاملاً.',

    lawHeading: 'القانون الواجب التطبيق',
    lawBody:
      'تخضع هذه الشروط لقوانين دولة الإمارات العربية المتحدة. ولا يحدّ أي ممّا ورد هنا من حقوقك القانونية كمستهلك.',
  },
};

/**
 * The copy for a locale.
 *
 * No per-key fallback to English, unlike `translator()` in lib/locale.ts. That
 * fallback is right for interface labels — a stray English word on a button is
 * a blemish. It is wrong here: a half-English privacy notice is a document an
 * Arabic-speaking reader cannot rely on, and silently degrading to the other
 * language would hide the fact that a section was never translated. Both
 * dictionaries satisfy the same interface, so TypeScript refuses the build if
 * one of them is missing a section.
 */
export function legalCopy(locale: Locale): LegalCopy {
  const copy = locale === 'ar-AE' ? AR : EN;
  return { ...copy, lastUpdated: formatLegalDate(LEGAL_LAST_UPDATED, locale) };
}

/**
 * The companies behind the payment gateways, for the "who else sees it" list.
 *
 * The gateway's own `displayName` is what a *shopper choosing how to pay* needs
 * — Stripe and Network International both present as "Card", which is correct
 * at checkout and useless in a privacy notice, where the question is which
 * organisation receives your data. So the id is mapped to the processor.
 *
 * Only ids that are actually registered ever reach this map, and the registry
 * is built from configuration (see `paymentRegistry()` in lib/session.ts). A
 * gateway with no credentials is not registered, so it is not offered at
 * checkout and it is not named here — the page cannot claim a data recipient
 * this deployment does not have.
 *
 * `cod` and `bank_transfer` are absent on purpose: paying the courier in cash
 * involves no third-party processor, so listing one would be a fiction.
 */
const PAYMENT_PROCESSORS: Record<string, string> = {
  stripe: 'Stripe',
  network: 'Network International (N-Genius)',
  paytabs: 'PayTabs',
  tabby: 'Tabby',
  tamara: 'Tamara',
};

export function paymentProcessorNames(gatewayIds: readonly string[]): string[] {
  return gatewayIds.map((id) => PAYMENT_PROCESSORS[id]).filter((name): name is string => Boolean(name));
}

/**
 * Joins a list the way a sentence does, in the reader's language.
 *
 * `Intl.ListFormat` rather than `join(', ')`: Arabic uses "و" without the comma
 * English puts before "and", and a hand-rolled join gets that wrong in exactly
 * the sentence a reader is most likely to be scrutinising.
 */
export function listSentence(items: readonly string[], locale: Locale): string {
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items);
}

/** Substitutes `{name}` placeholders, matching `translator()`'s convention. */
export function fill(template: string, params: Record<string, string | number>): string {
  return Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    template,
  );
}
