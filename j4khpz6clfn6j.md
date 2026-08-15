# Voltix Commerce OS

## Design Document v1.0

**Status:** Draft for design review · **Date:** 12 August 2026 · **Companion to:** PRD v2.0, TRD v2.0, Wireframe Document v1.0

* * *

## 0\. Position

**AUDIT:** the existing design system is small and unusually disciplined. CSS custom properties for colour, space, type, radius and font; light and dark via `prefers-color-scheme` plus a `[data-theme]` override; logical properties (`inset-inline-*`, `text-align: start`) used throughout so RTL is essentially free; hand\-rolled CSS classes with no component library, no CSS\-in\-JS and no Tailwind; system font stack; inline SVG icons. The audit's verdict — "appropriate; zero runtime CSS cost, no dependency risk, tokens are disciplined" — is correct, and none of it is being replaced.

Three things are wrong with it, and they are the three things this document fixes:

1. **Component styles live in two 1,000\-line `globals.css` files.** They grew organically. This is debt T\-12.
2. **There is no documented component inventory.** In a design system, undocumented means non\-existent.
3. **The system was designed for two surfaces and is about to serve four.** A POS used standing up, under shop\-floor glare, by someone who is not looking at the screen, has requirements the storefront never had.

**AUDIT — the design principles reconstructed from the code are genuinely good and are adopted verbatim as the stated principles.** They were applied consistently enough that they were clearly real, even though nobody wrote them down.

* * *

## 1\. Principles

Six inherited from the code, three added for the POS.

### Inherited

**1 · Never fabricate a number.** Missing cost renders as an em dash, not `0%`. No prior period renders as an em dash, not `0.0%`. A zero that means "unknown" is a lie the interface tells, and in a system whose whole claim is correct numbers, it is the worst possible lie.

**2 · Colour follows required action, not enum order.** `refunded` is neutral because nothing needs doing. `failed` is red because something does. Status colour is not decoration; it is a queue.

**3 · Explain absence.** An empty state says why it is empty and what to do about it. Never "No data".

**4 · Honest copy.** A COD confirmation never says "paid". This principle now extends to tax: a receipt never says "Tax Invoice" unless it legally is one, and a reverse\-charge sale says so in words.

**5 · Server\-rendered by default; interactivity where it earns itself.** Unchanged for storefront and admin. **The POS is the deliberate exception** — it is client\-heavy because it must work with no server at all.

**6 · Derive from the source of truth.** The delivery page computes charges from the same function checkout uses, so it cannot lie. Extended: the receipt, the PDF invoice and the emailed copy render from one document object, so they cannot drift apart.

### Added for the counter

**7 · The cashier is not looking at the screen.** They are looking at the customer, the handset, the barcode. Confirmation must be audible and peripheral — a tone, a colour change large enough to catch in peripheral vision, a number that changes size. A subtle toast in a corner is invisible to someone whose eyes are on a customer.

**8 · Nothing destructive is one tap away.** Standing, in a hurry, next to a queue, with a touchscreen. Clear cart, void line and refund all require a confirmation that names what will be lost.

**9 · Offline is a state, not an error.** It gets its own visual treatment — amber, informational, persistent — never a red error, never a modal. The shop keeps trading; the interface should look like it expects to.

* * *

## 2\. Tokens

**AUDIT:** existing tokens are `--colour-*`, `--space-1..8`, `--text-xs..3xl`, `--radius-*`, `--font-*`. British spelling of `colour` is kept — consistency beats convention, and renaming touches every file for nothing.

### 2\.1 Colour

Semantic tokens only in components. Raw scale values are referenced solely by the semantic layer, so a theme change is one file.

```css
/* Neutral scale — the entire chrome of every surface */
--grey-0:#ffffff; --grey-25:#fafbfc; --grey-50:#f4f5f7; --grey-100:#e7e9ed;
--grey-200:#d4d7dd; --grey-400:#767c87; --grey-600:#4a4f58; --grey-900:#16181d;

/* Brand — used sparingly. One accent, not five */
--blue-50:#eaf1fe; --blue-500:#1f6feb; --blue-700:#12457f;

/* Status — chosen for required action, per principle 2 */
--green-50:#ecfaf0; --green-600:#15803d;   /* settled, in stock, synced */
--amber-50:#fef6e7; --amber-600:#b45309;   /* needs attention, offline, pending */
--red-50:#fdeceb;   --red-600:#b42318;     /* blocked, failed, sold twice */

/* Semantic — the only layer components may use */
--surface:              var(--grey-0);
--surface-sunken:       var(--grey-50);
--surface-raised:       var(--grey-0);
--border:               var(--grey-200);
--border-subtle:        var(--grey-100);
--text:                 var(--grey-900);
--text-secondary:       var(--grey-600);
--text-tertiary:        var(--grey-400);
--action:               var(--blue-500);
--action-wash:          var(--blue-50);
--positive:             var(--green-600);
--attention:            var(--amber-600);
--critical:             var(--red-600);
--focus-ring:           var(--blue-500);
```

**Dark mode** remaps the semantic layer only. **AUDIT:** the `prefers-color-scheme` plus `[data-theme]` mechanism already works and is unchanged. Note that the POS runs almost always in light — shop\-floor lighting and glare make dark mode actively worse at a counter — so dark mode is tested but not optimised there.

**Contrast floor.** WCAG 2.2 AA everywhere. On the POS, body text targets 7:1 rather than 4.5:1, because the environment is worse than a desk.

### 2\.2 Type

**AUDIT:** a system font stack, which is the right call — zero load cost, native rendering, and Arabic falls through to the platform's Arabic font, which is better than most webfonts.

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
             "Helvetica Neue", Arial, "Noto Sans Arabic", sans-serif;
--font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

--text-xs:  0.75rem;   /* 12px — metadata, timestamps */
--text-sm:  0.8125rem; /* 13px — table body, secondary */
--text-base:0.875rem;  /* 14px — admin body */
--text-md:  1rem;      /* 16px — POS body. Deliberately one step up */
--text-lg:  1.125rem;  /* 18px — section headings */
--text-xl:  1.375rem;  /* 22px — POS running total */
--text-2xl: 1.75rem;   /* 28px — tender display */
--text-3xl: 2.25rem;   /* 36px — change due. The largest thing on any screen */
```

**Two rules that matter more than the scale.**

**Monospace for every identifier.** IMEIs, SKUs, invoice numbers, tracking numbers, order numbers, TRNs. These get read aloud, compared character by character and typed back in. A proportional font makes `1` and `l`, `0` and `O` ambiguous, and an ambiguous IMEI is a wrong warranty decision.

**Tabular numerals for every quantity.** `font-variant-numeric: tabular-nums` on all money, counts and variances, so columns align and a changing total does not jitter.

### 2\.3 Space and radius

The existing 4px\-based `--space-1..8` scale is kept. One addition for the POS:

```css
--tap-min: 44px;   /* POS minimum touch target */
--tap-comfortable: 56px;   /* primary POS actions */
```

Radius stays modest — `--radius-sm: 4px`, `--radius-md: 6px`, `--radius-lg: 10px`. Nothing is pill\-shaped except status chips. Heavy rounding reads as consumer\-app playfulness, which is wrong for a system whose argument is that its numbers are right.

### 2\.4 Elevation and motion

Two shadow levels only: `--shadow-card` for raised surfaces, `--shadow-overlay` for modals. No elevation ladder — this is a data product, not a material metaphor.

```css
--ease: cubic-bezier(.2,0,.2,1);
--dur-fast: 120ms;    /* hover, focus, colour */
--dur-base: 180ms;    /* panels, modals */
--dur-slow: 280ms;    /* route transitions */
```

**Motion budget on the POS: none that delays.** No animated cart insert, no slide\-in on tender. A cashier ringing forty sales an hour feels every 200ms. Feedback is instantaneous colour and size change plus an audio tone. `prefers-reduced-motion` removes all transitions everywhere.

* * *

## 3\. Component inventory

**AUDIT:** T\-12 — component styles live in two 1,000\-line `globals.css` files with no documented inventory. The fix is structural.

### 3\.1 File structure

```
packages/ui/src/
  tokens.css              raw scale + semantic layer + dark remap
  reset.css
  primitives/             one file per component, colocated docs
    button.css  button.md
    input.css   input.md
    table.css   table.md
    …
  patterns/               composed
    data-table.css
    empty-state.css
    money.css
apps/admin/src/styles/    app-specific only, CSS Modules
apps/pos/src/styles/      app-specific only, CSS Modules
```

**Rule:** if a style appears in two apps it belongs in `packages/ui`. If it appears once it is a CSS Module colocated with its component. `globals.css` shrinks to reset plus token import and nothing else. This is enforced by a lint rule capping `globals.css` length, because the failure mode is gradual and only a hard stop prevents it.

### 3\.2 Inventory

Status: ● documented and built · ◐ built, undocumented · ○ to build

| Component | Status | Variants | Notes |
| --- | --- | --- | --- |
| Button | ◐ | primary, secondary, ghost, danger · sm/md/lg · POS size | Add loading and POS sizes |
| Input | ◐ | text, number, search, **scan** | **Scan is new** — §3.3 |
| Select | ◐ | — |  |
| Checkbox / Radio | ◐ | — |  |
| Table | ◐ | default, dense, **card\-collapse** | Card\-collapse is the sub\-900px admin fix |
| Badge / Status chip | ● | neutral, positive, attention, critical | Colour by required action |
| Card | ◐ | flat, raised, interactive |  |
| Modal | ◐ | sm, md, lg, **full (POS)** |  |
| Toast | ◐ | info, success, warning, error | **Not used on the POS** — too peripheral |
| Empty state | ● | — | Already good; keep the pattern |
| **Skeleton** | ○ | text, row, card, tile | **Closes T\-13 / P\-13** |
| Tabs | ◐ | — |  |
| Sidebar nav | ◐ | full, icon, drawer | Drawer is the sub\-900px fix |
| Money | ○ | inclusive, exclusive, negative, unknown | §3.4 |
| **Identifier** | ○ | imei, sku, invoice, tracking, trn | §3.5 |
| **Product tile** | ○ | in stock, out of stock, serialised | POS |
| **Cart line** | ○ | standard, serialised\-pending, serialised\-bound | POS |
| **Keypad** | ○ | numeric, quick\-amount | POS |
| **Tender method** | ○ | available, selected, unavailable\-with\-reason | POS |
| **Timeline** | ○ | unit history, order history | The differentiator screen |
| **Variance row** | ○ | positive, negative, exception | Stocktake |
| **Sync status card** | ○ | healthy, degraded, disconnected, breaker\-tripped | Channels |
| **Offline banner** | ○ | — | Amber, persistent, never a modal |
| Receipt block | ○ | simplified, full, RCM, credit note | Renders to ESC/POS and PDF from one object |

### 3\.3 Component: Scan input

The single most important new primitive. Every scanning surface uses it — POS sale, IMEI capture, stocktake, PO receiving, unit lookup.

**Behaviour.** Attaches a global `keydown` listener, not a focus\-dependent one. Detects a scan by inter\-keystroke interval under 50ms sustained across a run, terminated by Enter or a configured suffix. A scan resolves; it never visibly types.

**States**

| State | Visual | Behaviour |
| --- | --- | --- |
| Idle | 2px `--action` border, placeholder | Listening |
| Human typing | Border unchanged, live suggestions | Debounced search |
| Scan detected | Brief flash of `--action-wash`, \~120ms | Resolves; no Enter needed |
| Resolved valid | Green flash \+ rising tone | Closes or adds |
| Invalid format | `--critical` border, inline message | **Input is never cleared** |
| Ambiguous | Disambiguation prompt | Never guesses |
| Offline | Amber left border, "local index" hint | Validates against the cache |

**Accessibility.** `role="searchbox"` with `aria-describedby` for the hint. Every scan outcome announced in an `aria-live="assertive"` region — this is the primitive that makes principle 7 real. Auditory feedback is not optional decoration; it is the confirmation channel for someone whose eyes are elsewhere.

**Do / Don't**

| ✅ Do | ❌ Don't |
| --- | --- |
| Return focus after any modal closes | Rely on visible focus to receive a scan |
| Validate IMEI with Luhn before lookup | Accept 15 digits without checking |
| Preserve the input on error | Clear the field so it must be rescanned |
| Announce the outcome audibly | Show only a silent visual toast |

### 3\.4 Component: Money

Money display is a correctness feature in this product, not formatting.

| Prop | Values | Behaviour |
| --- | --- | --- |
| `amount` | `bigint` minor units | Never a float. Ever |
| `mode` | `inclusive` \| `exclusive` | Drives the suffix label |
| `unknown` | boolean | Renders an em dash, never `0.00` — principle 1 |
| `sign` | `auto` \| `always` | Variance columns use `always` |

Rules: always `AED` before the number in English, after in Arabic. Always two decimals. Always tabular numerals. Negative in `--critical` with a minus sign — never brackets, which are an accounting convention a shop manager may misread. VAT\-exclusive amounts always carry a visible "excl. VAT" label, because **RESEARCH:** displaying a VAT\-exclusive price to a consumer without stating it carries an AED 5,000 penalty.

### 3\.5 Component: Identifier

```
<Identifier type="imei"     value="356938035643809" />   → 3569 3803 5643 809   (grouped, monospace, copy)
<Identifier type="imei"     value="…" truncate />        → ·· 3809
<Identifier type="invoice"  value="INV-2026-001204" />   → monospace, links to the document
<Identifier type="tracking" value="7719204418" />        → monospace, links to the carrier
<Identifier type="trn"      value="100234567800003" />   → 1002 3456 7800 003
```

Grouped in fours for readability when read aloud. Truncated form shows the last four, because that is how humans actually disambiguate two handsets on a counter. Click copies the full value and announces the copy. Always `dir="ltr"` even inside an RTL layout — an IMEI rendered right to left is not merely ugly, it is wrong.

### 3\.6 Component: Skeleton

**AUDIT:** T\-13 / P\-13 — no admin screen has a loading skeleton; every one relies on RSC streaming, so on a slow connection the admin appears frozen. On a Sharjah 4G connection this is the difference between "slow" and "broken".

Rule: **skeletons mirror the real layout, never a generic spinner.** A table skeleton has the right number of columns at the right widths. A card skeleton is card\-shaped. This is what makes a slow load read as loading rather than as a failure.

Where a wait is genuinely long — the POS catalogue snapshot at shift open — use a **counted** progress indicator ("1,840 of 2,310"), not an indeterminate bar. Honesty beats reassurance.

* * *

## 4\. Surface\-specific design

### 4\.1 POS

**Environment.** Standing. 15" touchscreen at roughly 60cm. Overhead fluorescent or shop\-window daylight, both producing glare. Ambient noise. The cashier's attention is on the customer.

**Consequences, stated as rules.**

| Rule | Because |
| --- | --- |
| Body text at `--text-md` (16px), never smaller | Viewing distance plus glare |
| Contrast target 7:1, above the AA floor | Glare |
| Touch targets 44px minimum, 56px for primary | Standing, in a hurry |
| Maximum three levels of visual hierarchy on screen | Split attention |
| Feedback is colour \+ size \+ sound, never a toast | Principle 7 |
| No hover\-dependent affordance | Touch first |
| One screen, one job | The sale screen has no navigation chrome |

**The change\-due treatment** is the clearest expression of the whole approach. When cash is over\-tendered, the Complete button becomes the change amount at `--text-3xl` in `--positive`. It is the largest thing on any screen in the product, because it is the number the cashier is about to act on with their hands.

**Offline treatment.** Amber, persistent, informational. Header chip changes state; stale stock counts get a dotted underline meaning "as of 14:12"; unavailable tenders are visibly unavailable **with the reason stated**, not silently missing. There is no modal and no red. Per principle 9, the shop is still trading and the interface should look like it expects to be.

### 4\.2 Admin

Desktop\-first is correct for a product editor and a variant matrix. **AUDIT:** P\-13 — but the primary persona checks a phone many times a day and the admin currently collapses below 900px.

**The responsive rule: below 900px, tables become cards.** Horizontal scroll on a phone is a failure, not a fallback. Priority for the phone experience: Dashboard, Orders, Inventory, Returns. Products and Reports stay desktop\-first — nobody edits a variant matrix on a phone, and pretending otherwise produces a bad version of both.

**Density.** Admin tables are dense by default with a comfortable toggle. A merchant scanning two hundred orders wants rows, not cards. This is the opposite of the POS and that is correct — different bodies, different postures, different tasks.

### 4\.3 Storefront

**AUDIT:** the most complete surface, all ten routes done, purchase flow verified in production. Design changes are limited to what the PRD requires.

- The COD advance\-payment step needs copy that states the refund condition, or the shopper abandons.
- Tax document number and PDF on the confirmation page.
- The IMEI promise appears only on genuinely serialised products, replacing the current blanket homepage claim.
- Arabic **content**, not only Arabic UI.

### 4\.4 Printed output

A receipt is a legal document (**RESEARCH:** it is the simplified tax invoice) and it is designed, not templated by accident.

```
80mm · 42 characters at Font A · ESC/POS

        SEMUL MIAH ELECTRONICS
             TRADING L.L.C
        TRN 100234567800003
       Shop 12, Naif, Deira, Dubai
------------------------------------------
            TAX INVOICE
   فاتورة ضريبية
INV-2026-001204      12 Aug 2026  14:34
Till 1 · Kabir R.
------------------------------------------
iPhone 15 Pro 256GB Natural Ti
  IMEI 3569 3803 5643 809
  Warranty 12 months to 12 Aug 2027
  1 x            4,094.29     4,094.29
AirPods Pro 2
  2 x              856.19     1,712.38
------------------------------------------
Subtotal                       5,806.67
VAT 5%                           290.33
                             ------------
TOTAL                     AED 6,097.00
   المجموع
Cash                           6,500.00
Change                           403.00
------------------------------------------
   Returns within 7 days with this receipt
   الإرجاع خلال ٧ أيام مع هذا الإيصال
------------------------------------------
```

**Design decisions.** The IMEI is on the receipt because it is the customer's warranty proof and the shop's dispute defence — this is the audit's P\-03 promise being kept in the most tangible place. Warranty expiry is an absolute date, not a duration, because "12 months" requires the customer to remember when they bought it. Bilingual on the lines that carry legal weight; English\-only elsewhere to keep the paper short. Change is visually prominent because the cashier reads it off the paper too.

**RCM variant** replaces the VAT line with:

```
VAT                            0.00
Reverse charge - Cabinet Decision 91/2023
Buyer accounts for VAT
TRN 100234567800003  Al Noor Trading LLC
الاحتساب العكسي
```

**Visual regression tests cover receipt and invoice rendering.** These are legal documents; a CSS change that breaks a layout is a compliance issue, not a cosmetic one.

* * *

## 5\. Arabic and RTL

**AUDIT:** logical properties are used throughout, which makes structural RTL essentially free and is a genuinely good decision. The remaining work is content and edge cases.

| Rule | Detail |
| --- | --- |
| Layout mirrors | `inset-inline-*`, `margin-inline-*`, `text-align: start` — already done |
| **Numbers stay LTR** | Prices, IMEIs, phone numbers, invoice numbers, TRNs, dates. `dir="ltr"` with `unicode-bidi: isolate`. Getting this wrong makes an Arabic receipt unreadable |
| Icons that mirror | Back, forward, next, previous, progress |
| Icons that do not | Play, clock, checkmark, logos, external\-link |
| Mixed direction fields | An Arabic input inside an English admin form — `dir="rtl"` on the field only, never inherited. This is the specific detail most implementations get wrong |
| Product content | **AUDIT:** P\-09 — Arabic UI with English product data is jarring. The `translations` column exists and is unused; wire it |
| Arabic\-indic digits | **DECISION: do not use them.** Western digits throughout, including in Arabic. UAE commercial practice, and it keeps identifiers unambiguous |
| Font | System Arabic (SF Arabic, Segoe UI, Noto Sans Arabic). No webfont — Arabic webfonts are large and the platform fonts are better |

**OPEN — W6:** should the POS default to Arabic? The cashier persona may read Arabic more comfortably than English, while the owner persona works in English. The decision is per user, not per tenant, and the default is worth asking a real cashier about.

* * *

## 6\. Accessibility

**AUDIT:** semantic HTML, `sr-only` and aria labels are present but were never audited; focus\-visible styling is unverified. The audit rated a keyboard\-navigation audit High priority. This is the standard.

| Area | Requirement | Verified by |
| --- | --- | --- |
| Contrast | AA everywhere; 7:1 body text on the POS | Automated token check \+ axe in CI |
| Focus | Visible ring on every interactive element, 2px `--focus-ring` with 2px offset, never removed | Manual keyboard audit per release |
| Keyboard | Every action reachable without a mouse. The POS is keyboard\-first by design | Scripted keyboard\-only pass on the three money paths |
| Targets | 44px POS, 32px admin | Automated measurement |
| Announcements | Scan results, tender outcomes, sync state to live regions | Screen\-reader pass per release |
| Forms | Label bound to every control; errors bound by `aria-describedby`; error text names the fix | axe |
| Tables | `scope` on headers; caption or `aria-label` on every data table | axe |
| Motion | `prefers-reduced-motion` removes all transitions | Manual |
| Zoom | 200% without loss of function on admin and storefront | Manual |

**The POS accessibility case is unusual and worth stating.** Its most important accessibility feature is not screen\-reader support — it is **audio confirmation for a sighted user who is not looking at the screen**. Principle 7 and the accessibility requirement point at exactly the same implementation. Build it once, and both are served.

* * *

## 7\. Design handoff

**AUDIT:** step 11 of the ideal process — "UI design / design system" — was recorded as "tokens were designed; screens were not". This is the mechanism that stops that recurring.

**Source of truth is the code.** `packages/ui` is canonical. Figma mirrors it; where they disagree, the code wins. A design system whose source of truth is a design file drifts within one sprint — the audit's documentation drift is the same failure in a different medium.

**Definition of done for any new component**

1. Token\-only styling — no hardcoded hex, no arbitrary spacing. Enforced by a stylelint rule.
2. All applicable states implemented: default, hover, active, focus, disabled, loading, error, empty.
3. Keyboard path defined and tested.
4. Live\-region announcement where the component reports an outcome.
5. RTL verified, including the numbers\-stay\-LTR rule.
6. A colocated `.md` documenting variants, props, states, accessibility and do/don't.
7. Added to the pattern library page in admin (**AUDIT:** recommended and not built — build it).
8. Visual regression snapshot, mandatory for anything that prints.

**Every one of these is checkable in a pull request.** That is the point — the audit's central lesson is that documentation which is not produced in the same commit as the code does not stay true.

* * *

## 8\. Design debt disposition

| \# | Audit finding | Priority | Disposition |
| --- | --- | --- | --- |
| T\-12 | Two 1,000\-line `globals.css` files | Low → **Medium** | §3.1 restructure. Raised because two more apps are about to be added to the same files |
| T\-13 | No loading skeletons in admin | Low → **High** | §3.6. Raised because it is indistinguishable from broken on 4G |
| P\-13 | Admin unusable below 900px | Medium | §4.2 card\-collapse |
| — | No documented component inventory | Low | §3.2 plus a pattern library page |
| — | Focus\-visible styling unverified | **High (a11y)** | §6, audited per release |
| P\-09 | Arabic UI, English product content | Medium | §5, wire the `translations` column |
| P\-03 | IMEI promised on the homepage, never delivered | **High** | §4.4 — on the receipt, and on the PDP only where genuinely serialised |

* * *

## 9\. Open questions

| \# | Question | Blocks |
| --- | --- | --- |
| D1 | POS screen size and orientation — 15" landscape assumed. A 10" portrait tablet needs a different sale layout, not a responsive squeeze | POS layout |
| D2 | Receipt width — 80mm assumed. 58mm halves the usable characters and forces a different template | Receipt template |
| D3 | Arabic\-first POS default? Per user, not per tenant. Worth asking a cashier | Localisation |
| D4 | Is there a visual brand — logo, wordmark, accent — or does the system accent stand in? The product currently has no identity beyond its tokens | Storefront, receipt header |
| D5 | Customer\-facing display in scope? Needed for BNPL QR flows and it changes the tender screen | R3.16 |
| D6 | Is dark mode worth maintaining on the POS, given it is actively worse under shop lighting? | Theme scope |

* * *

*Companion documents: PRD v2.0, TRD v2.0, Wireframe Document v1.0, and the interactive prototype `voltix-wireframes.html`.*
