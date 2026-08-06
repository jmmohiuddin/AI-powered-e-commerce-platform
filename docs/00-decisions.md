# Architecture Decision Records

Every significant choice, the alternatives that were rejected, and the reasoning. Where a decision
would flip under different circumstances, that trigger is stated — an ADR that cannot be revisited
is dogma, not engineering.

---

## ADR-0001 — Modular monolith, not microservices

**Decision.** One deployable application with hard internal module boundaries (`packages/*`), not a
fleet of services.

**Alternatives considered.**

| Option | Why not |
|---|---|
| Microservices per domain | Distributed transactions across order + payment + inventory is the hardest problem in commerce. Splitting them across network boundaries turns a database transaction into a saga with compensating actions, and every one of those is a new failure mode. The operational cost lands on day one; the scaling benefit arrives — if ever — at a volume this platform is years from. |
| Serverless functions per endpoint | Cold starts on a checkout path are a conversion cost. Connection pooling against Postgres from N lambdas requires a pooler anyway. Fine for webhooks and cron; wrong as the primary architecture. |
| Headless SaaS backend (Shopify/Medusa/commercetools) | Fastest to launch, and correct for many businesses. Rejected because the stated goal is a platform that becomes a SaaS product: on someone else's commerce backend, the merchant is a tenant of *their* tenancy model, per-transaction fees compound, and the AI and inventory work — the actual differentiation — is confined to whatever their APIs expose. |

**Why this wins.** The module boundaries are real (separate packages, explicit dependencies,
independently tested), so extracting a service later is a build-config change rather than an
untangling. What is deferred is the *deployment* split, which is the expensive half.

**Revisit when.** A single domain needs independent scaling or an independent release cadence —
realistically, search or the AI job runner first.

---

## ADR-0002 — PostgreSQL as the only datastore

**Decision.** Postgres 17 with `pgvector`, `pg_trgm` and native full-text search. No separate search
engine, no separate vector database, no document store.

**Alternatives considered.**

| Option | Why not (yet) |
|---|---|
| Postgres + Elasticsearch/OpenSearch | A second stateful system to operate, plus an indexing pipeline that will drift from the source of truth. Real hybrid search — BM25, vectors and RRF — is now available inside Postgres. |
| Postgres + Algolia/Typesense | Excellent merchandising and typo tolerance out of the box, and genuinely worth it at scale. Rejected for now on cost shape: Algolia prices on operations and records, which scales aggressively for a multi-tenant catalogue, and it puts the merchant's catalogue in a third system. |
| Postgres + Pinecone/Qdrant | pgvector with an HNSW index handles the sub-500k-SKU catalogues this targets comfortably. A dedicated vector store adds an operational surface for a problem we do not yet have. |
| MongoDB | Product catalogues look document-shaped, which is the trap. Orders, payments and inventory need multi-row transactions and referential integrity, and those are the parts where being wrong costs money. |

**Why this wins.** One backup story, one failover story, one connection pool, one set of
transactional guarantees. Every cross-domain query — "which slow-moving SKUs have open purchase
orders" — is a join rather than an integration.

**Revisit when.** A tenant crosses ~200k SKUs, or search latency at p95 exceeds 150 ms with HNSW
tuned. At that point search moves out first; nothing else does.

---

## ADR-0003 — Drizzle ORM over Prisma

**Decision.** Drizzle for schema definition and queries.

**Reasoning.** Three properties decided it. Drizzle has no separate query engine binary, so it runs
in edge and serverless runtimes without a shim. Its generated SQL is predictable enough to reason
about from the TypeScript — which matters when a query on a 40-million-row `analytics_events` table
needs an index hint. And the schema is TypeScript, so `pgvector` columns, partial indexes and
generated columns are expressible without escaping to raw SQL for half the schema.

**Against Prisma:** better DX for simple CRUD and a genuinely better migration UX. Rejected because
its relational query builder still produces surprising SQL on deep includes, and the engine binary
constrains deployment targets.

**Against raw SQL + Kysely:** maximum control, no type-safe schema-to-migration path. Drizzle Kit's
generated, reviewable, committed migrations are the deciding factor: migrations are code, and
`drizzle-kit push` against a database holding real orders is banned in this repo for the same
reason.

---

## ADR-0004 — Next.js App Router for both apps

**Decision.** Next.js 16, React 19, server components by default.

**Reasoning.** The storefront's requirements are, in priority order: fastest possible first paint on
a mid-range Android phone over a congested mobile network; correct SEO; and only then rich
interactivity. Server components invert the default — a product listing page ships markup, not a
component tree plus data plus a hydration pass. The interactive islands (variant picker, cart) are
scoped to the two components that need state.

**Alternatives.** Astro is arguably better for a pure content storefront, but the admin is an
application, and running two frameworks doubles the shared-component problem. Remix/React Router is
a close call with a cleaner mutation story; Next wins on ISR granularity, which is what lets a
product page be static *and* reflect a price change within a minute. A SPA was never in contention:
client-rendered commerce is a measurable conversion loss.

---

## ADR-0005 — Payment abstraction, tuned for the UAE

**Decision.** One `PaymentGateway` port. Every provider is an adapter behind it.
Card-and-wallet first, BNPL second, cash on delivery offered but never the default.

**The market reasoning.** The UAE is a card-and-wallet market with high Apple Pay and Google Pay
adoption, very high buy-now-pay-later penetration, and a cash-on-delivery share that is real but
shrinking. That produces a different ordering from a cash-dominant market, and ordering is a
conversion lever rather than a cosmetic choice:

| Adapter | Status | Why it is here |
|---|---|---|
| **Stripe** | Implemented | Cards plus Apple Pay and Google Pay, which ride the same rails. Auth-then-capture, so funds are held at checkout and taken when the warehouse actually picks the item. |
| **Network International (N-Genius)** | Implemented | The incumbent domestic acquirer. Many established UAE merchants already hold an account through their bank, and asking them to move acquiring to a foreign processor is a bigger adoption barrier than any technical objection. |
| **Tabby** | Implemented | BNPL, split into four. Not a card alternative — a basket-size lever. On a AED 4,699 handset, "AED 1,175 today" converts shoppers who abandon at the full price. |
| **PayTabs** | Config only | The usual regional alternative to Network. Credentials are wired; the adapter is not written. |
| **Tamara** | Not built | The other major regional BNPL. Provider id is reserved. |
| **Cash on delivery** | Implemented | Offered across all seven emirates, ordered last. Every COD order converted to prepaid removes a refusal risk and a courier remittance delay. |

**What Tabby forced into the design.** Tabby underwrites the shopper and returns approved or
rejected *before* they choose to pay, and rejection is normal rather than an error. That produced
two requirements a card-only design would not have: a `preScore()` call so eligibility is checked
while the checkout assembles its method list rather than after the shopper has committed, and a
rejection path that surfaces Tabby's own customer-safe wording instead of "payment failed". Telling
someone their credit was refused, in a shop full of people, is the failure mode being avoided.

**What the port deliberately does not do:** pretend gateways are uniform. `GatewayCapabilities`
makes the differences declared data — auth-vs-sale, partial refunds, redirect flows, deferred
settlement — so checkout branches once on capability instead of discovering incompatibility through
a runtime failure. Note that Tabby settles the merchant in full up front, so it is *not* deferred
settlement despite the shopper paying over time; only COD is.

**Not yet true:** no adapter has been run against a live merchant account. Field names follow each
provider's documented API as built and must be confirmed against a sandbox before go-live.

## ADR-0006 — Hybrid search: BM25 + vectors fused with RRF

**Decision.** Two retrievers — Postgres full-text and pgvector cosine — combined with Reciprocal
Rank Fusion, then merchandising boosts applied separately.

**Why not one or the other.** Lexical search nails `SM-S928B` and returns nothing for "phone with a
good camera under 40k". Vector search understands the second and confidently returns the S23 Ultra
for the first. Electronics shoppers issue both query shapes constantly.

**Why RRF and not score normalisation.** BM25 scores and cosine similarities are not comparable
quantities. Min-max or z-score normalisation makes them *look* comparable and breaks whenever one
list has an outlier. RRF uses rank position only, so it is immune — and it structurally rewards
agreement between the two retrievers, which is exactly the signal we want.

**Why boosts are applied after fusion, never folded in.** Relevance answers "does this match";
merchandising answers "which match to show first". Folding a margin boost into the relevance score
makes both untunable and produces the failure every shopper has experienced: searching for a
specific product and being shown a more profitable one instead. Boosts are multiplicative and
bounded so they reorder near-ties and cannot rescue an irrelevant result.

---

## ADR-0007 — AI is a metered gateway, and forecasting is not AI

**Decision.** All LLM traffic goes through one class with per-tenant budgets, prompt caching, cost
accounting and structured output. Demand forecasting uses classical statistics.

**Why the gateway.** In a single-merchant store an unbounded LLM bill is an annoyance. In a SaaS,
one tenant bulk-generating descriptions for a 40,000-SKU catalogue can outspend a month's
subscription revenue in an afternoon. Metering has to be structural, not a policy nobody enforces.

**Why forecasting is not an LLM feature.** It has a measurable error metric. A seasonal-naive, Holt,
or Croston baseline beats a language model at it, costs nothing per prediction, produces the same
answer twice, and can be backtested. An LLM asked "how many will I sell" returns a plausible number
with no error bars — worse than useless when that number becomes a purchase order. The LLM explains
the forecast and drafts the supplier email. See `packages/ai/src/forecast.ts`.

**Why every customer-facing generation requires human approval.** A model asked to describe a phone
will invent a battery capacity. In commerce a stated specification is a contractual claim, and in
advertising copy it is a legal exposure for the merchant. `requiresReview` on the task registry is
the enforcement, and grounding rules in every prompt are the mitigation.

---

## ADR-0008 — Money as integer minor units

**Decision.** Every monetary value is an integer count of minor units plus a currency code, in a
`bigint` column, manipulated only through the `Money` type.

**Rejected:** floats (lose pennies, and the loss is silent), `numeric` (correct, but forces string
round-tripping in JS and invites an accidental `Number()` cast somewhere in a render path), and a
plain `number` of "dirhams" (mixing units is the bug that ships and is discovered when a customer is
charged 100× too much).

The non-obvious part is **allocation**. Order-level discounts must be split across lines for
per-line refunds, tax and margin. Naive proportional splitting loses or invents minor units;
largest-remainder allocation guarantees the parts sum exactly to the whole. This is fuzz-tested
across 500 random splits per run.

---

## ADR-0009 — Three-axis order state, not one enum

**Decision.** `status`, `paymentStatus` and `fulfilmentStatus` are independent, each with its own
transition graph.

**Reasoning.** A single enum forces unanswerable questions: is `refunded` before or after `shipped`?
Real orders are paid *and* partially shipped *and* partially refunded simultaneously — that is an
ordinary Tuesday, not an edge case. Three axes make every real combination representable and every
transition independently guarded, and let the admin render exactly the actions that are currently
legal rather than a Refund button that throws when clicked.

---

## ADR-0010 — Row-level security, not just application filters

**Decision.** Postgres RLS on every tenant-owned table, with the tenant set as a transaction-local
setting.

**Reasoning.** `WHERE tenant_id = ?` is correct until the one query where somebody forgets. In a
multi-tenant commerce product that single omission is a cross-merchant breach — one store reading
another's customers, orders and margins. RLS makes the database refuse those rows regardless of what
the application asked for, so a forgotten filter becomes an empty result set rather than an incident
report.

Transaction-local scope (`set_config(..., true)`) is essential under connection pooling: a
session-level setting survives the connection being handed to the next request, for a different
tenant. `FORCE ROW LEVEL SECURITY` is also set, because without it the table owner silently bypasses
the policy and the protection is theatre.

---

## ADR-0011 — UUIDv7 primary keys

**Decision.** Time-ordered UUIDv7, generated in the application.

**Against UUIDv4:** random keys scatter B-tree inserts across the whole index. On `analytics_events`
or `order_events` every insert dirties a different page, write amplification climbs, and the index
stops fitting in cache. **Against bigserial:** sequential ids leak business volume — order #1042
today and #1109 next week tells a competitor the weekly throughput — and require coordination for
multi-region writes. **Against nanoid/cuid:** Postgres has a native 16-byte `uuid` type; a 21-char
text id costs more storage and index space for no benefit.

Human-facing references (`#10428`, `PO-2026-0184`) are separate display sequences, never keys.

---

## ADR-0012 — Server-authoritative pricing, always

**Decision.** One pure function computes the total. It runs when the cart changes, when checkout
renders, and again immediately before payment authorisation. Nothing the client computes is trusted.

**Why recompute rather than mutate.** Incremental totals drift: a coupon applied, a line removed,
the coupon's minimum no longer met — an incremental design has to remember to undo, and eventually
forgets. Recomputing from inputs makes the result a function of the inputs alone, which is also what
makes it safe inside a retry and trivial to test.

**The order of operations is the specification.** Line discounts → order discounts → shipping → tax
on the *post-discount* amount → stored value as tender. Taxing the pre-discount amount overcharges
the customer and is unlawful in most VAT regimes. Treating a gift card as a discount rather than a
payment understates revenue and corrupts every margin report downstream.

---

## ADR-0013 — UAE localisation is structural, not a translation layer

**Decision.** Market rules live in `packages/core/src/regions/uae.ts` and in configuration, not
scattered through feature code. Arabic support is built on logical CSS properties and `Intl` from
the start, even though the locale routing is deliberately simple.

**Why a region module rather than sprinkled constants.** Four UAE rules break a store that gets
them wrong, and each one is invisible until it is expensive:

1. **VAT is 5% and prices must be displayed inclusive.** Adding VAT at checkout to a price that
   already contains it is a 5% overcharge; the reverse understates margin by 5%. The pricing engine
   supports both modes and `UAE_STANDARD_VAT` selects the right one. A tax invoice still has to
   state net and VAT separately, which is what `extractVat` is for.
2. **There is no postal-code system.** This is the single detail that breaks imported checkout
   flows. A required postal-code field either blocks the order or trains every customer to type
   "00000" — which then defeats address validation, courier zone lookup and fraud scoring at once.
   What a courier actually needs is the emirate, the community, a building name, and ideally a
   Makani number.
3. **A tax invoice without a TRN is not a valid tax invoice.** A business customer will reject it
   because they cannot reclaim the input VAT. `packages/config` refuses to boot production without
   a format-valid TRN, because discovering this at the first audit is the expensive version.
4. **The weekend is Saturday–Sunday.** Delivery promises, courier pickup windows and supplier lead
   times all compute against it. A system assuming otherwise promises deliveries that cannot happen.

**On Arabic.** The locale is resolved from a cookie, which makes the root layout dynamic — a real
cost, and the wrong long-term answer. The right one is an `/[locale]/…` route segment that keeps
both language trees statically generated, and it is not built here because doubling the route
surface before there is evidence of Arabic demand is speculative work.

What is *not* deferred is the part that is expensive to retrofit. Every component already uses
logical CSS properties (`margin-inline-start`, not `margin-left`) and `Intl` formatting, so moving
to route segments later relocates files without touching styling or formatting. Converting
`margin-left` to `margin-inline-start` across a finished storefront is the painful version, and
this avoids it. `dir="rtl"` on the root element then does the work a separate RTL stylesheet would.

One detail worth recording because it is counter-intuitive: `ar-AE` correctly renders Western
Arabic digits (4,699), not Eastern ones (٤٬٦٩٩) — that is the UAE convention, and `ar-EG` differs.
`Intl` already knows this. Do not "fix" it by forcing `-u-nu-arab`.
