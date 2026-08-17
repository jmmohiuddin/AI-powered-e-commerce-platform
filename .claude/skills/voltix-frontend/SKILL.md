---
name: voltix-frontend
description: Build or change UI in the Voltix storefront and admin to this codebase's actual standards — hand-written BEM CSS over design tokens (no Tailwind, no css-in-js), bilingual EN/AR with RTL, stock and price truth derived from the domain rather than restated, and an accessibility floor that keyboard checkout depends on. Use when writing or editing anything under apps/storefront or apps/admin, adding a component, touching globals.css or tokens.css, or reviewing a frontend diff. For animation craft specifically, compose with the animate and review-animations skills.
---

# Voltix frontend

This encodes what `apps/storefront` and `apps/admin` already do. It is not a
style preference — every rule below is reconstructed from the existing code,
and breaking one produces a diff that is visibly foreign to the file it lands
in.

**Read `STANDARDS.md` in this directory when reviewing a diff.** It is the
flagging checklist, with severities. This file is for building.

## Hard rules

These are not negotiable and not a matter of taste. Violating one is a defect,
not a discussion.

1. **No Tailwind. No css-in-js. No utility classes.** Neither app has a CSS
   framework, `styled-components`, `@emotion`, `vanilla-extract`, `clsx` or
   `cva` in its dependencies. Styling is hand-written CSS in the app's
   `globals.css`, addressed by semantic class names. Reaching for `className="flex
   items-center gap-2"` is the single fastest way to produce a diff that has to
   be rewritten.

2. **BEM, strictly.** `block`, `block__element`, `block--modifier`. The 116
   existing classes follow it without exception: `.cart-line__controls`,
   `.availability--low_stock`, `.button--primary`. Do not invent a second
   convention.

3. **Never hard-code a value that exists as a token.** Colours, type sizes,
   spacing, radii, shadows, easing and duration all live in
   `packages/ui/src/tokens.css`. A literal `#1d4ed8`, `16px` or `200ms` in a
   component's CSS is a defect. Both apps `@import '@voltix/ui/tokens.css'` —
   the tokens are already in scope.

4. **Never restate a domain fact the domain already computes.** Availability
   comes from `summarise()` in `@voltix/core`, the same function checkout
   enforces — so a tile and the cart cannot disagree. Prices, ratings, counts
   and relative times come from `@voltix/ui` formatters. Writing
   `${price / 100} AED` or `qty > 0 ? 'In stock' : 'Out'` forks the truth.

5. **Read the Next.js docs before using a Next API.** `apps/storefront/AGENTS.md`
   says it plainly: this Next version has breaking changes against training
   data. The docs are in `node_modules/next/dist/docs/`, resolved from the app
   directory — not the repo root.

## Build order

Decide in this sequence. Skipping ahead is what produces UI that has to be
unpicked later.

1. **Does it need to be a new component at all?** `packages/ui` is formatters
   only; components live in the app that uses them. If storefront and admin
   both need it, that is the moment to consider promoting it — not before.

2. **Server or client?** Default to a server component. Add `'use client'` only
   for actual interactivity. The storefront's read paths are server-rendered
   and indexable, and that is load-bearing for a commerce site.

3. **Name the block.** Pick the BEM block name before writing markup. If you
   cannot name it in one or two words, the component is doing two things.

4. **Markup, semantically.** `<article>` for a card, `<h3>` for its title,
   `<nav>` for navigation. The product card is a worked example: one `<article>`,
   headings in order, no `<div>` where an element with meaning exists.

5. **CSS at the bottom of the app's `globals.css`**, grouped under a comment
   header like the sections already there. Tokens only.

6. **Then check it in both directions and both themes.** See below.

## Commerce truths this UI must not break

**Do not shift.** Any media box gets a fixed `aspect-ratio` before the image
loads. `.product-card__media` is `4 / 3`, gallery thumbs are `1`. A tile that
moves under a thumb costs a tap on the wrong product, and often the session.

**Be one link.** A card is a single anchor, not a card containing several. The
product card links the media and the title to the same href rather than
wrapping the whole tile in one anchor with nested interactive children —
nested links are a screen-reader mess and double the tap targets on mobile.

**Scarcity must be true.** "Only 2 left" converts once if it is a lie. The
number comes from the availability engine, never from a prop someone passed in
optimistically.

**Prices carry their currency and locale.** `formatPrice(minorUnits, currency,
locale)`. Money is integer minor units everywhere in this system — a bare
`number` rendered directly is either 100× wrong or a fils leak. VAT is
inclusive and stated; `splitVatInclusive` exists for when the split must show.

**Give `sizes` to every responsive image, derived from the real grid.** The
product card's `sizes` string is computed from `.product-grid`'s actual
`auto-fill, minmax(min(100%, 220px), 1fr)` inside a 1280px container. Guessing
here over-fetches most on a narrow phone, which is where it costs most.

## Bilingual and RTL

The storefront ships English and Arabic with full RTL. This is not a
post-processing step.

- `dir` is set on `<html>` from `directionFor(locale)`. Do not set it per
  component.
- **Use CSS logical properties** — `margin-inline-start`, `padding-inline`,
  `inset-inline-end`, `text-align: start` — never `margin-left`/`right`.
  `globals.css` currently holds 22 logical properties and **zero** physical
  ones on the inline axis. A physical property in new code mirrors wrongly in
  Arabic. (`top`/`bottom` are fine — RTL does not mirror vertically.)
- **Numbers that are not prose stay LTR.** Phone numbers, TRN and trade licence
  numbers are wrapped in `<span dir="ltr">` inside Arabic text. Copy that
  pattern for any identifier a user might read aloud or dial.
- All user-visible strings go through `t()`. A literal English string in JSX is
  a defect in the storefront.
- Numerals are locale-formatted: `formatCount` gives Eastern Arabic numerals on
  an Arabic page. Never `String(n)` for a user-facing number.

## Accessibility floor

Not aspiration — the level the existing code already holds.

- **Never remove focus outlines.** `:focus-visible` is styled globally with a
  2px accent outline. Removing it makes keyboard checkout impossible, which is
  the most common accessibility failure on commerce sites.
- Use `.visually-hidden` (already defined) for screen-reader-only text, not
  `display: none`, which removes it from the accessibility tree too.
- Decorative imagery gets `aria-hidden` or an empty alt; the product card marks
  placeholder images `decorative`.
- Icons and glyphs used as ornament (`★`, `·`) are `aria-hidden="true"` with the
  meaning supplied in adjacent visually-hidden text.
- Interactive targets are real `<button>`/`<a>`. A `<div onClick>` is a defect.

## Motion

Tokens exist: `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`, `--duration-fast:
120ms`, `--duration-base: 180ms`. Use them; do not introduce a parallel curve.

`prefers-reduced-motion: reduce` is already handled globally in `tokens.css` —
do not re-implement it per component, and do not defeat it.

For anything beyond a hover transition — a sheet, a drawer, a gesture, an
enter/exit — compose with the `animate` skill, and have `review-animations`
check it. Those carry the motion craft; this file only fixes which tokens it
must use.

## Theming

Every colour is defined for light and redefined under `@media
(prefers-color-scheme: dark)` in `tokens.css`. Because components only ever
reference semantic tokens (`--colour-price`, `--colour-in-stock`), dark mode is
free — *provided* you never hard-code a colour. That is the practical reason
rule 3 exists.

Semantic names over appearance names: `--colour-in-stock`, not
`--colour-green-500`. A new colour that means something new gets a semantic
token in `tokens.css`; it does not get inlined.

## Content-Security-Policy

The storefront enforces a nonce-based CSP, verified against a production build.
Inline `<style>` and inline event handlers will be blocked. Put styles in
`globals.css`. If something genuinely needs an inline style tag, it must carry
the nonce — see `apps/storefront/src/proxy.ts` and the pages that already do it.

## Before you call it done

- Renders in English and Arabic, and nothing mirrors wrongly.
- Renders in light and dark without a hard-coded colour.
- Keyboard: reachable, visibly focused, operable.
- No layout shift as images load.
- `npm run typecheck` clean.
- Read the diff once as if reviewing someone else's — against `STANDARDS.md`.
