# Voltix frontend — review standards

The flagging checklist. **Default to flagging; approval is earned.** A diff that
merely works is not yet a diff that ships — this codebase's frontend holds a
high bar, and a change that reads as foreign to the file around it is a finding
even when it renders correctly.

Report each finding as `file:line` + the evidence + the fix. Do not report a
finding you cannot point at.

**Severity**
- **HIGH** — breaks the product: wrong money, a stock claim that can be false,
  keyboard or screen-reader access lost, layout shift, RTL breakage, CSP
  violation.
- **MEDIUM** — visibly off-convention: hard-coded token values, BEM violations,
  duplicated domain logic, missing `sizes`.
- **LOW** — polish: naming, grouping, comment quality, consolidation.

---

## 1. Styling system — HIGH when it introduces a parallel system

| Flag | Why |
|---|---|
| Any Tailwind utility class (`flex`, `gap-2`, `text-sm`, `p-4`) | No CSS framework is installed. This will not style anything, and it signals the whole diff was written against the wrong mental model. |
| `styled-components`, `@emotion`, `vanilla-extract`, `clsx`, `cva` | Not dependencies. Adding one forks the styling system for a single component. |
| `style={{ … }}` inline objects for anything static | Belongs in `globals.css`. Inline style also interacts badly with the CSP. |
| A new CSS file next to a component | Both apps put CSS in their single `globals.css`. |

## 2. Tokens — MEDIUM, HIGH if it breaks dark mode

Flag any literal where a token exists:

- Colours: `#1d4ed8`, `rgb(…)`, `white`, `black` → `var(--colour-*)`.
  **HIGH** — a hard-coded colour is invisible in dark mode, and dark mode is
  otherwise free in this codebase.

  **Two carve-outs, both already in the codebase — do not flag these:**
  - *Third-party brand colours.* `.button--whatsapp` is `#128c7e` because that
    is WhatsApp's green. It is not a theme value; a merchant re-theming their
    store must not repaint someone else's brand. Same would apply to Tabby or
    a card network mark.
  - *A foreground on a background that is fixed in both themes.* The discount
    badge is `color: #fff` on `--colour-discount`, which is red in light and
    dark alike, so white is correct in both. Flag this only if the background
    token actually changes lightness between themes.

  Everything else is a finding.
- Sizes: `16px`, `1rem` for spacing → `var(--space-*)` (4px grid).
- Type: `font-size: 14px` → `var(--text-*)` (all `clamp()`-based, fluid).
- Radii: `border-radius: 8px` → `var(--radius-*)`.
- Shadows: any hand-written `box-shadow` → `var(--shadow-*)`. Heavy drop
  shadows are explicitly rejected in `tokens.css`.
- Motion: a bare `cubic-bezier(...)` or `300ms` → `var(--ease-out)`,
  `var(--duration-fast|base)`.

Also flag a **new** token that duplicates an existing one by another name, and
a token named for appearance (`--colour-green`) rather than meaning
(`--colour-in-stock`).

## 3. BEM — MEDIUM

- `block__element__grandchild` — BEM does not nest twice. Flatten it.
- `block--modifier` used without the base `block` class on the element.
- camelCase or snake_case block names. Blocks are kebab-case; note that
  *modifier values mirroring domain enums* legitimately use snake_case
  (`.availability--low_stock`) because they map to the enum. Do not "fix" those.
- Two class names for the same concept (`.product-tile` alongside
  `.product-card`).

## 4. Domain truth — HIGH

The most damaging category. Every one of these forks a fact that has one owner.

- Availability computed inline (`onHand > 0 ? 'In stock' : …`) instead of
  `summarise()` from `@voltix/core`. **The tile and the checkout must not be
  able to disagree.**
- A stock number rendered from a prop that did not come from the availability
  engine — "Only 2 left" that can be false.
- Money formatted by hand: `price / 100`, `` `AED ${n}` ``, `toFixed(2)`.
  Money is integer minor units; use `formatPrice(amount, currency, locale)`.
- VAT recomputed in a component rather than `splitVatInclusive`.
- Discount percentage computed inline rather than `discountPercent`.
- Rating or count rendered with `String(n)` rather than `formatRating` /
  `formatCount` — breaks Eastern Arabic numerals.
- Relative time hand-rolled rather than `relativeTime`.

## 5. Layout stability — HIGH

- A media container without `aspect-ratio` set before load.
- `next/image` without `sizes` on a responsive image — **MEDIUM**, and the
  `sizes` string must be derived from the actual grid, not copied from another
  component with a different column rule.
- Content that appears after hydration and pushes layout (badges, prices,
  stock labels) rather than being server-rendered into place.

## 6. Bilingual and RTL — HIGH

- Physical CSS properties on the **inline (horizontal) axis**:
  `margin-left`, `padding-right`, `left:`, `text-align: left`, `border-left`.
  Use `margin-inline-start`, `padding-inline-end`, `inset-inline-start`,
  `text-align: start`, `border-inline-start`.

  The bar here is absolute, not aspirational: `globals.css` currently has
  **22 logical properties and zero physical ones**. The first physical one is a
  regression, not a stylistic slip.

  *Not findings:* block-axis properties (`top`, `bottom`, `margin-block`) —
  RTL does not mirror the vertical axis. Symmetric shorthands
  (`padding: 0 var(--space-4)`) are also fine.
- A literal user-visible English string in JSX instead of `t('…')`.
- `dir` set on a component rather than inherited from `<html>` — **except** the
  deliberate `dir="ltr"` islands for phone numbers, TRN and licence numbers.
  Flag the *absence* of that wrapper on a new identifier of that kind.
- A number rendered with `String()`/template literal instead of `formatCount`.
- An icon or layout that implies direction (arrows, chevrons, progress) with no
  RTL handling.

## 7. Accessibility — HIGH

- `outline: none` / `outline: 0` anywhere. Non-negotiable: keyboard checkout
  depends on `:focus-visible`.
- `<div>` or `<span>` with `onClick` instead of `<button>`.
- Nested interactive elements — a link inside a link, a button inside a link.
- `display: none` used for screen-reader-only text instead of
  `.visually-hidden`.
- Decorative glyph (`★`, `·`, `→`) without `aria-hidden="true"`.
- An image with no `alt`, or a decorative image with a described `alt`.
- Heading levels skipped (`<h2>` → `<h4>`), or a heading used for visual size
  rather than structure.
- A form control with no associated `<label>`.
- Colour as the sole carrier of meaning (stock state, error) with no text or
  icon alongside.

## 8. Rendering model — MEDIUM

- `'use client'` on a component with no interactivity, event handler or hook.
  The storefront's read paths are server-rendered and indexable; converting one
  to a client component silently costs that.
- Data fetching in a client component that a server component could do.
- `useEffect` used to derive state that could be computed during render.

## 9. CSP — HIGH

- An inline `<style>` or `<script>` without the nonce.
- An inline event handler attribute (`onclick="…"`) in raw HTML.
- A remote font, stylesheet or script host not already allowed.

## 10. Cohesion — LOW

- A comment restating what the code does rather than *why*. The convention in
  this codebase is the second kind — see the header of `product-card.tsx` or
  `tokens.css`, which explain the commercial or accessibility reasoning.
- A new CSS section dropped in without the comment header the surrounding
  sections use.
- Five near-identical rules that should be one class with modifiers.
- A component over ~150 lines doing two jobs.

---

## Approval

Approve only when: the diff introduces no parallel system, every literal that
has a token uses it, every domain fact comes from its owner, it renders
correctly in EN and AR and in light and dark, and it is keyboard-operable with
visible focus.

If you approve, say what you checked. "Looks good" is not a review.
