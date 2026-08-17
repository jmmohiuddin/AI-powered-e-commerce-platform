# Roadmap

Estimates assume **two engineers**. They are ranges, not commitments, and they are deliberately not
optimistic — the failure mode in commerce projects is a launch date set before the payment
integration has been tested against a real merchant account.

## Where this is now

**Phase 1 — Foundation. Complete.** Schema live in Postgres with row-level security, domain logic,
UAE market rules, payment abstraction, AI platform, a bilingual storefront and an admin that build
and run, documented decisions.

**Phase 2 — partly done.** Guest checkout works end to end: cart, server-authoritative pricing,
row-locked stock reservation, order creation with gap-free numbering, idempotency, and a background
job runner. 190 tests pass, 16 of them against real Postgres as the restricted role.

**What that does not mean.** No gateway has been tested against a live merchant account. No load
test has been run. There is no authentication, no admin order management, and no notification
transport. Nothing here has touched real money.

---

## Phase 2 — Transactable (3–5 weeks remaining)

The goal is one merchant taking real orders. Nothing in this phase is optional.

| Work | Weeks | Status |
|---|---|---|
| Checkout: session → pricing → reservation → payment → order, with the 409 paths | 2 | **Done** — guest checkout works end to end, covered by integration tests |
| Job runner: reservation sweep, abandoned carts, payment reconciliation | 1 | **Done** — Postgres queue, `SKIP LOCKED`, backoff, dead-lettering |
| Auth: staff sessions, MFA, customer accounts | 1.5 | Not started. Guest identity by phone already works |
| Payment integration tested against real sandbox *and* live merchant accounts | 1.5 | Not started — the biggest remaining risk |
| Admin CRUD: products, variants, stock adjustments, order actions | 1.5 | Not started |
| Notifications: order confirmation and dispatch by SMS, email, WhatsApp (TDRA sender registration is a lead-time item) | 1 | Queued as jobs; transport not wired |
| Load test | 0.5 | Not started |

**Exit criteria.** A real order can be placed, paid by each configured method, fulfilled, and
refunded — with the ledger reconciling against the gateway settlement report without a spreadsheet.

**Biggest risk.** Gateway integration always takes longer than the API docs suggest. Tabby's
pre-scoring and rejection paths, and Network International's short-lived tokens and versioned vendor
media types, are both places where the happy path works in an afternoon and the failure paths take a
fortnight. The 1.5-week estimate assumes merchant account credentials are available on day one; in
the UAE, where an acquiring account usually comes through the merchant's bank, they rarely are.

## Phase 3 — Complete storefront (5–7 weeks)

| Work | Weeks |
|---|---|
| Customer accounts: order history, tracking, addresses, wishlist | 1.5 |
| Reviews: submission, verified-purchase badge, AI moderation, summaries | 1.5 |
| Product comparison, recently viewed, frequently bought together | 1 |
| Courier integration (Aramex / Emirates Post): labels, tracking webhooks, COD remittance | 1.5 |
| Returns and warranty flow with serial-unit tracking | 1.5 |

## Phase 4 — Operations & intelligence (6–8 weeks)

| Work | Weeks |
|---|---|
| Purchasing: PO lifecycle, receiving, supplier scorecards | 1.5 |
| Multi-warehouse allocation and transfers in the UI | 1 |
| Reporting: revenue, margin, cohorts, search analytics, exports | 2 |
| AI catalogue tooling: bulk import, extraction, review queue | 1.5 |
| Campaigns: audience builder, content approval, send, ROI attribution | 2 |

**The highest-ROI item here is the search analytics report.** Zero-result and zero-click queries are
customers telling you, in their own words, what you failed to sell them. It is a two-week build that
routinely pays for itself in a month.

## Phase 5 — SaaS (8–12 weeks)

Turning one merchant's platform into a product for many. The schema already supports it; the
operational surface does not.

| Work | Weeks |
|---|---|
| Merchant onboarding, plan limits, subscription billing | 3 |
| Theming and per-tenant branding beyond token overrides | 2 |
| Public API, keys, docs, and a merchant-facing webhook subscription UI | 2 |
| Tenant-level observability, per-tenant cost attribution, support tooling | 2 |
| Load testing at 100+ tenants; connection-pool and index tuning under multi-tenant load | 2 |

**Do not start Phase 5 before one merchant has been live for a quarter.** Every SaaS assumption made
before a real merchant has used the product in anger is a guess, and the expensive ones are
structural.

## Phase 6 — Mobile & channels (8–10 weeks)

React Native app sharing `packages/core` and `packages/ai` (the dependency rule is what makes this
cheap rather than a rewrite), and POS for physical counter sales.

**Marketplace channel sync was pulled forward** and the noon integration now exists in
`packages/noon`: stock and price push, catalogue content upsert, order import, and a drift
reconcile, all driven by the worker. It has never run against a live noon account, which is the
single largest risk on it — see that package's README for exactly which endpoint paths are verified
against noon's documentation and which one is inferred.

What remains on this phase for channels: turning noon orders into first-class marketplace order
records in admin, automating shipment confirmation back to noon, replacing the five-minute order
poll with noon's event-notification webhooks, and generalising `noon_listings` into a channel
abstraction once there is a second marketplace to generalise *from*.

---

## What is deliberately not on this roadmap

**Autonomous social posting.** The campaign generator drafts; a human approves. Autonomous posting
is a brand-damage incident waiting for a bad prompt, and the time saved is minutes per week.

**LLM-based demand forecasting.** Covered in ADR-0007. Statistics win on accuracy, cost,
determinism and testability.

**A recommendation model trained from scratch.** Collaborative filtering needs interaction volume no
new store has. Content-based similarity from embeddings plus explicit merchandising rules covers the
first two years, and the `product_links` table already carries the curated relationships that
outperform a cold-start model.

**Blockchain anything.** No.

---

## Open questions requiring a decision from the business

These change the work materially and cannot be answered from the code:

1. **~~Target market.~~ Settled: UAE.** Payments are card-and-wallet first with Tabby BNPL and COD
   last, VAT is 5% inclusive, addresses are emirate + Makani, and the storefront ships English and
   Arabic. What remains open is whether to expand to Saudi Arabia next — the schema and the payment
   port already support it (SAR, Tamara, ZATCA e-invoicing is the real work).
2. **Single merchant or SaaS first.** Phases 2–4 serve both. Phase 5 is only worth starting if the
   SaaS ambition is real, and starting it early costs more than it saves.
3. **Courier partners.** Aramex, Emirates Post, Quiqup and the quick-commerce fleets all differ in
   label format, COD remittance schedule and tracking webhook shape. This is the second-largest
   integration surface after payments, and same-day delivery in Dubai is a competitive requirement
   rather than a nice-to-have.
4. **Arabic content, not just Arabic UI.** The interface is translated and RTL works. Product
   content is a different problem: it needs Arabic titles, descriptions and specs captured *at
   entry*, because retrofitting translations onto a populated catalogue costs several times more
   than capturing them as products are created. The `translations` column is ready; the decision is
   whether Arabic product content is mandatory from the first import.
5. **ZATCA e-invoicing, if Saudi Arabia is next.** Saudi requires cryptographically signed,
   government-cleared e-invoices — a materially larger compliance surface than UAE VAT, and worth
   scoping before committing to the expansion rather than after.
