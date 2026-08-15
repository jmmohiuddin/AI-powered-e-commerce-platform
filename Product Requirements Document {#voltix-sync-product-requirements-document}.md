# Voltix Sync — Product Requirements Document

**One stock pool across noon, Amazon.ae, voltix.ae and the shop counter.**

|  |  |
| --- | --- |
| **Version** | 1\.0 — first forward\-looking PRD for this product |
| **Date** | 12 August 2026 |
| **Author** | Product |
| **Status** | Draft for review |
| **Supersedes** | Nothing. The 9 Aug 2026 *Reverse PRD* is an audit of what was built; this document defines what to build next. |
| **Related** | Voltix Commerce — Product & Technical Master Document (reverse\-engineered audit, 9 Aug 2026) |

* * *

## How to read this document

This PRD was written **after** market, competitive and technical research, and **after** an audit of the existing codebase. That ordering matters, because the previous build inverted it.

Three labels appear throughout:

- **VERIFIED** — confirmed against official documentation (channel API docs, marketplace fee schedules, government sources) during research on 12 Aug 2026. Sources are listed in Appendix C.
- **REPORTED** — from a credible secondary source (analyst report, vendor documentation, review site) but not confirmed at the primary source.
- **ASSUMPTION** — our inference or a placeholder that must be validated. Every assumption that could change the design appears in **§16 Open Questions** with an owner.

Anything not labelled is a product decision, not a fact.

* * *

## 1\. Executive summary

Voltix today is a single\-tenant e\-commerce platform with a well\-built money path and a half\-built back office. It sells on one channel — its own storefront. The merchant it was built for (a Dubai consumer\-electronics trading company) does not sell on one channel. They sell, or intend to sell, on **noon.com**, **Amazon.ae**, **their own website**, and **over a counter in a physical shop** — and today every one of those inventory numbers is maintained by hand.

That manual reconciliation is the actual product problem. It was never written down, so it was never built. Instead, the codebase acquired 72 database tables, an inert AI package, and a name that promises something the software does not do.

**Voltix Sync is the correction.** It makes the Voltix database the single system of record for stock, and pushes an authoritative, buffer\-adjusted quantity out to every channel within seconds of anything changing — a marketplace order, a website checkout, a counter sale, a goods receipt. Orders flow back in the other direction, into one queue.

**Why now, and why this is buildable.** noon published a full public partner API in 2026 with a stock endpoint rated at 1,500 requests per 60 seconds — VERIFIED. Amazon's SP\-API supports both real\-time listing patches and a closed\-loop quantity\-change notification — VERIFIED. Neither existed in usable public form when most of the incumbent tooling was designed, which is why **no mainstream multichannel tool has a noon connector** — VERIFIED across Linnworks, Veeqo, Sellbrite, Zentail, SellerCloud, Cin7, Extensiv, Zoho Inventory, Katana, inFlow and Shopify Marketplace Connect.

**Why this is worth building rather than buying.** The tools that *do* integrate noon are priced for enterprises — ChannelEngine targets sellers above US$1m marketplace GMV, and Omniful charges roughly US$4,000 setup plus US$900/month \\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\*\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\*per module\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\*\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\* (REPORTED, from its published price sheet). The tools an SMB can afford do not speak to noon. And the fourth channel — a physical shop drawing from the same stock pool — collapses nearly every option: of the tools researched, only Omniful has both a noon connector and a POS module, at roughly US$8,000 setup for the pair.

**The scope of v1** is deliberately narrow: **inventory and orders, both directions, four channels.** Not listing creation. Not pricing automation. Not AI.

**The honest constraint.** Six of twelve admin sections in Voltix are unbuilt, including product create/edit. There are no database backups, no error tracking, no payment webhooks, and no outbound email. **A sync engine on top of that foundation would amplify failures rather than remove them.** §14 defines a hard prerequisite gate: Phase 0 ships before any channel adapter is written.

* * *

## 2\. Background — what exists, and what was missed

### 2\.1 What is already built and good

The 9 Aug 2026 audit found genuinely strong correctness foundations, and Voltix Sync depends on all of them:

| Existing capability | Why Voltix Sync needs it |
| --- | --- |
| Money as integer minor units | Marketplace fee and payout reconciliation cannot tolerate float drift |
| `stock_movements` append\-only, UPDATE/DELETE revoked | Becomes the audit trail for every channel\-driven stock change |
| Stock reservations under concurrency, tested | The primitive that a marketplace order, a cart hold and a counter sale all reuse |
| Three\-axis order state machine (lifecycle / payment / fulfilment) | A marketplace order has a different payment axis to a COD website order; a single enum could not express it |
| Payments behind a port with four adapters and a circuit breaker | The exact architectural pattern the channel adapters should copy |
| Row\-level security, forced, adversarially tested | Keeps the SaaS horizon open at no extra cost |
| Immutable price/cost snapshot on order items | Per\-channel margin after commission is computable historically |

**This is the reason to extend Voltix rather than start again.** The hard parts — correctness under concurrency, gapless numbering, ledger\-derived state — are done and tested.

### 2\.2 What was missed, and why

The original build had no PRD, no user research and no problem statement. The consequences are specific and measurable:

| Symptom | Root cause |
| --- | --- |
| 72 tables, \~30 with no writer | Schema designed from imagined scope, not from a workflow |
| An `@voltix/ai` package whose Anthropic client is dead code | Positioning chosen before the problem was defined |
| No product create/edit in the admin | Depth built before the vertical slice was complete |
| **No channel integration of any kind** | **The merchant's actual daily pain was never captured as a requirement** |

The last row is this document's reason to exist.

### 2\.3 The strategic reframe

The repository is named *AI\-powered\-e\-commerce\-platform*. The running software contains no language\-model call. That gap must close in one direction, deliberately.

**This PRD closes it by changing the claim, not by adding a model.** The product's defensible promise for the next twelve months is *"your stock number is right on every channel, always"* — which is a correctness and latency claim, and which the existing engineering culture is unusually well\-suited to deliver.

AI is not abandoned; it is sequenced. §13 sets out where machine intelligence earns its place once the sync engine is real, and why the statistical forecaster already shipping (Croston's method, Holt's smoothing) is the correct tool for demand forecasting and should not be replaced by a language model.

* * *

## 3\. Research summary

Full detail and sources in Appendix C. This section carries only what changes a product decision.

### 3\.1 The market

| Finding | Value | Confidence |
| --- | --- | --- |
| UAE e\-commerce market | AED 32.3bn (\~US$8.8bn) in 2024, forecast AED 50.6bn by 2029 at 9.4% CAGR (Euromonitor × EZDubai) | VERIFIED — note other credible sources put 2026 at up to US$12.3bn; the spread is a methodology difference, not an error |
| Electronics share of UAE online retail | \~34% of revenue — the single largest category | REPORTED (ECDB) |
| UAE electronics e\-commerce | \~US$2.78bn (2025); 30–35% of the total UAE electronics market is now online | REPORTED (ECDB) |
| Channel concentration | Amazon.ae \+ noon \+ Carrefour ≈ 45–50% of UAE e\-commerce GMV | REPORTED (Mordor) |
| Multichannel sellers vs single\-channel | 34% of marketplace sellers now run two or more marketplaces; multi\-channel sellers average 17.5× the GMV of single\-channel | REPORTED (Mirakl 2026 Seller Report, global — **no MENA cut exists**) |

**Decision this drives:** the category is large enough and concentrated enough that two marketplaces plus own\-site plus shop covers the realistic addressable demand for a Dubai electronics retailer. A long tail of additional channels is not where v1 effort goes.

### 3\.2 What overselling actually costs

This is the business case, and it is unusually crisp because both marketplaces publish the penalty:

| Cost | Detail | Confidence |
| --- | --- | --- |
| **noon cancellation fee** | Charged at the applicable referral\-fee percentage — you pay commission on a sale you never made | VERIFIED (noon FBP fee schedule, eff. 1 Sep 2025) |
| **noon referral fees, electronics** | TVs 5% · mobiles 5–6% · laptops 6.5% · cameras 6% · headphones 8–15% · wearables 15%; minimum AED 1/item | VERIFIED |
| **noon return administration** | Lesser of AED 15 or 20% of the referral fee | VERIFIED |
| **Amazon.ae referral fees** | Consumer electronics 7% · mobile phones 5% · accessories 15% up to AED 250, 8% above | VERIFIED (sell.amazon.ae/pricing) |
| **Amazon Pre\-Fulfilment Cancel Rate** | Policy target below 2.5%; sustained breach risks selling\-privilege suspension | REPORTED — Seller Central metric pages are login\-gated. **Must be confirmed in the AE account.** |

**The risk to anchor on is not the cancelled order. It is the account.** A stockout\-driven cancellation on Amazon damages an account\-health metric that, if breached persistently, ends the channel.

### 3\.3 The competitive white space

| Segment | Who is there | Why it does not fit |
| --- | --- | --- |
| Free / entry (US$0–99/mo) | Veeqo, Sellbrite, Shopify Marketplace Connect, Zoho Inventory | **No noon connector.** Veeqo does support Amazon.ae (VERIFIED) but Amazon will never build a noon integration |
| Core SMB (US$100–400/mo) | Linnworks, Cin7 Core, Zentail, inFlow, Katana | No noon. Cin7 and inFlow additionally gate connector count by pricing tier |
| Mid / enterprise (US$900–3,000/mo\+) | ChannelEngine, Omniful, Unicommerce, Anchanto, Rithum | Have noon, but priced and sold for a different customer. ChannelEngine states a US$1m\+ marketplace GMV target |
| Point\-to\-point pipes (US$59–299) | SKUPlugs, Ecosire, Commercium | Move data between two systems; not an inventory hub, no shared pool, no POS |

**Two findings sharpen the wedge:**

1. **Best\-in\-class noon sync today is a 15\-minute cadence.** ChannelEngine's published noon connector specification runs offer and stock export/import every 15 minutes (VERIFIED). For high\-ASP electronics with thin stock depth, that is a 15\-minute oversell window on every fast mover.
2. **A Dubai agency is selling this exact build by hand.** Soluvide markets bespoke engineering to "sync stock across Noon, Amazon.ae, and your physical POS in real\-time" (VERIFIED — their site). Ecosire hand\-builds a single Shopify↔noon connector in 2–4 weeks for US$299. **Customers paying agencies to hand\-build a repeatable workflow is the clearest demand signal found in this research.**

**Decision this drives:** the product's differentiating claim is *measured end\-to\-end latency per channel*, published on a dashboard — not the word "real\-time", which every incumbent uses and none of them quantifies (VERIFIED — ChannelDock's audit found no vendor in the category publishes an actual sync\-frequency number).

### 3\.4 What the channels actually permit

This is the constraint set the architecture must obey. All VERIFIED unless marked otherwise.

| Channel | Stock write mechanism | Documented write rate | Propagation to buyer | Order intake |
| --- | --- | --- | --- | --- |
| **Amazon.ae** | `patchListingsItem`, `merge` op on `fulfillment_availability` | 5 req/s, burst 5 | **1–5 min** to `getListingsItem`; notifications 0–15 min | `ORDER_CHANGE` via SQS |
| **noon.com** | `POST /v1/stock-update`, keyed on (warehouse, `partner_sku`) | **1,500 req / 60 s** | **Unknown — must be measured** (ASSUMPTION) | FBPI webhooks |
| **Voltix storefront** | Direct write inside the order transaction | n/a | Immediate | Same transaction |
| **Physical shop** | Direct write at point of sale | n/a | Immediate | Same transaction |
| *Carrefour UAE — deferred* | Probably Mirakl `OF24` | Max 1 call/min | 1–5\+ min, async `import_id` | Mirakl order API |
| *Dubizzle — descoped* | No API exists | — | — | — |

**Per\-channel notes.**

- **Amazon.ae** — marketplace ID `A2VIGQ35RCS4UG`, EU endpoint, `eu-west-1`. `LISTINGS_ITEM_MFN_QUANTITY_CHANGE` (EventBridge) gives closed\-loop write confirmation. **`searchOrders` is rated 0.0056 req/s — roughly one call every three minutes — so polling is not a viable primary order path.**
- **noon.com** — RS256 JWT service\-account auth. **noon order payloads carry no customer address or email**, because noon owns last\-mile delivery; that removes a whole class of PII surface on the primary channel.
- **Physical shop** — **zero propagation warning.** A counter sale is instantaneous and unannounced, which makes it the hardest channel to protect against.
- **Carrefour UAE** — the Mirakl basis is unconfirmed for the UAE entity (ASSUMPTION). It would be the slowest channel and need the largest buffer.
- **Dubizzle** — classifieds with no order lifecycle. Excluded from the sync engine entirely.

**Three consequences that shape the whole design:**

1. **Webhooks are a latency optimisation, never a correctness mechanism.** Amazon's own documentation instructs developers to "have a means to retrieve needed information in the event of an unexpected outage or delay in notification delivery." Reconciliation is mandatory, not optional.
2. **Feed and report freshness cannot be the drift detector.** Amazon's stock\-data report SLA is 3 hours, and repeat calls return data 1–6 hours old. Reconciling more often than \~6 hours against reports produces false alarms.
3. **Amazon sequences submissions by submission timestamp**, so mixing real\-time patches with bulk feeds is safe — a slow feed will not clobber a fresh patch.

### 3\.5 Where the research came up empty

Stated plainly, because a PRD that hides its gaps is worse than one that names them:

- **No UAE or GCC study quantifies overselling frequency, hours lost to manual reconciliation, or stock\-drift magnitude.** There is no MENA equivalent of the Jungle Scout or Marketplace Pulse seller surveys. The vendor\-blog figure "overselling causes over 20% of customer complaints" has no underlying study and **must not be cited as validation.**
- **No published seller counts for noon or Amazon.ae.** Amazon's "100,000 companies by 2026" was a 2023 aspiration, never confirmed as an outcome.
- **No UAE\-specific electronics return rate.** The global 5–10% electronics figure is the only usable proxy.
- **noon's stock\-propagation latency is undocumented.** It is the single most important unknown for buffer sizing on the primary channel.

**Every one of these gaps is answered by the same activity: instrumenting our own operation.** §11's metrics are designed so that after 60 days of production data, this business has better UAE multichannel\-operations data than anything purchasable.

* * *

## 4\. Problem statement

A UAE electronics retailer selling across a marketplace, a second marketplace, an own\-brand website and a physical counter maintains **four independent inventory numbers for the same physical box on the same shelf.** Every sale on any channel silently invalidates the other three, and the only correction mechanism is a person remembering to log into three portals.

The failure is not occasional. It is structural and continuous: the numbers diverge from the moment the first sale is made and never reconverge without manual work. The costs compound in three directions —

- **Direct financial:** noon charges a cancellation fee equal to the referral\-fee percentage on a sale that never happened, plus a return\-administration fee when a mis\-shipped item comes back (VERIFIED).
- **Existential:** stockout\-driven cancellations feed Amazon's Pre\-Fulfilment Cancel Rate, and a sustained breach of the \~2.5% threshold puts selling privileges at risk (REPORTED — verify in the AE account).
- **Strategic:** the fear of overselling is managed by under\-listing. Stock is held back from channels "just in case", which is invisible lost revenue and the reason single\-channel sellers stay single\-channel.

The merchant's own words describe it exactly: *"if I make a sale in Amazon then I have to manually decrease the inventory... in my physical shop, if I make a sale, then also I have to update my inventory in my website, in different e\-commerce platforms."*

**Not solving it means the multichannel strategy cannot execute.** Each new channel multiplies the manual burden rather than adding to it, so the business is capped at the number of channels one person can reconcile by hand — which, in practice, is one.

* * *

## 5\. Goals

Outcomes, not outputs. Each is measurable, with a defined baseline period.

| \# | Goal | Measure | Success | Stretch |
| --- | --- | --- | --- | --- |
| **G1** | **Eliminate overselling caused by stock drift** | Oversell events per 1,000 orders (an order accepted on any channel for a SKU whose true available stock was below the ordered quantity) | **\< 2** per 1,000, within 60 days of full rollout | 0 for 90 consecutive days |
| **G2** | **Remove manual inventory maintenance** | Minutes per week spent editing stock in any channel's own portal, self\-reported weekly, baselined for two weeks pre\-launch | **\< 15 min/week**, down from baseline | Zero portal logins for stock purposes |
| **G3** | **Make channel truth fast and measurable** | End\-to\-end p95 latency: system\-of\-record change → channel confirms the new quantity | **Amazon \< 5 min · noon \< 2 min · storefront \< 1 s** | p99 within 2× the p95 target |
| **G4** | **Make multichannel expansion cheap** | Engineering days to add a channel that has a documented API, after the second adapter ships | **\< 10 days** | \< 5 days |
| **G5** | **Unlock held\-back inventory** | Percentage of sellable stock published to two or more channels | **\> 85% of SKUs** | \> 95% |
| **G6** | **Know the true margin of every channel** | Percentage of orders with commission, fulfilment and return fees reconciled against the channel payout statement | **\> 95% within 7 days of payout** | Automated, same\-day |

**G1 and G3 are the product.** G2 is what the merchant will actually feel. G6 is the reason the merchant will keep using it after the novelty of G2 wears off — nobody else in the category reconciles marketplace payouts against fees.

* * *

## 6\. Non\-goals

Explicit, with rationale. Each of these is a real temptation and each would delay v1.

| Non\-goal | Why not now |
| --- | --- |
| **Listing creation and catalogue publishing to channels** | Creating a compliant noon or Amazon listing means per\-category attribute schemas, brand authorisation, image standards and ECAS/TDRA compliance data. It is a larger project than the sync engine and it is not the stated pain. Listings stay manual in v1; **the sync engine attaches to listings that already exist.** P1. |
| **Repricing and pricing automation** | Competitive repricing is a different product with a different risk profile (a bad rule loses money in minutes, unlike a bad stock rule which loses a sale). Price is pushed only where a human sets it. P2. |
| **Warehouse management (bin locations, pick paths, wave picking)** | The merchant has one warehouse and one shop. WMS depth is where Omniful and Anchanto are years ahead and where there is no advantage to be won. |
| **Shipping\-label rate arbitrage** | Veeqo gives this away free, funded by Amazon's negotiated US/UK carrier rates that do not apply in the UAE. Unwinnable and irrelevant here. |
| **Carrefour UAE and Dubizzle** | Carrefour's Mirakl basis is unconfirmed and its 1\-call/minute ceiling makes it the slowest and least valuable channel to build first. Dubizzle has no seller API at all — it is classifieds, not a marketplace. Carrefour is P2 behind verification; Dubizzle is out permanently. |
| **Any language\-model feature** | See §13. The forecasting already shipping is statistical and correct. Adding a model before the sync engine works would repeat the exact mistake this document exists to correct. |
| **Second\-tenant onboarding, self\-serve signup and billing** | The multi\-tenant foundation (RLS) is already built and should be preserved, but no SaaS go\-to\-market work happens until the engine has run this business for a quarter. P2 — see §14 Phase 4. |
| **Customer accounts, wishlists, reviews submission on the storefront** | Storefront feature depth is a separate initiative. It does not affect stock correctness. |

* * *

## 7\. Target users

**Caveat carried forward from the audit:** the personas in the previous document were inferred from the RBAC model, which the audit itself called "a confession, not a methodology." These are grounded in the actual operating business, but the secondary personas are still partly inferred and are flagged as such.

### 7\.1 Primary — the Owner\-Operator

Runs the trading company. Decides what to stock, what to list where, and at what price. Currently the only person who knows the true stock position, and holds a meaningful part of it in his head.

- **Context:** phone\-first, moving between the shop, suppliers and a laptop. Interrupted constantly.
- **Today's workflow:** a sale happens somewhere → he remembers, or does not → later, he opens noon Seller Lab, Amazon Seller Central and the Voltix admin in three tabs and edits the same number three times.
- **Jobs to be done:** *"Tell me the one number that is true." · "Stop me from selling something I do not have." · "Tell me which channel actually makes me money after their fees."*
- **Success feels like:** never logging into a marketplace portal to change a quantity again.
- **Failure feels like:** a sync system he does not trust, which means doing the manual work *anyway* plus checking the system. **A partially\-trusted sync tool is worse than no tool** — this is the sharpest design constraint in the document.

### 7\.2 Secondary — Counter Staff *(partly inferred)*

Sells over the counter, picks and packs online orders, answers "where is my order".

- **Context:** standing, busy, often serving a customer while doing it. Possibly not the person who cares about system hygiene.
- **Jobs to be done:** *"Sell this item in under 20 seconds without thinking about inventory." · "Tell me instantly whether we have it."*
- **Design consequence:** the counter\-sale flow must be **faster than not using it.** If recording a shop sale in Voltix takes longer than writing it in a notebook, the notebook wins and the entire stock pool is corrupted at the source. This is the highest\-risk adoption dependency in v1.

### 7\.3 Tertiary — the Marketplace Shopper *(inferred)*

Buys on noon or Amazon. Never sees Voltix. Their only relationship to this product is negative: they experience it when an order is cancelled after purchase.

- **What they need from us:** the item they bought to actually exist. That is the whole requirement.

### 7\.4 Deliberately not served in v1

B2B and corporate buyers; a second merchant tenant; suppliers (no portal); marketplace customer\-service agents.

* * *

## 8\. Product principles

Six rules that resolve arguments during implementation. When a requirement below is ambiguous, these decide.

1. **One number is true, and it lives in Postgres.** Every channel is a projection of the Voltix stock ledger. No channel is ever consulted to answer "how many do we have."
2. **Under\-sell before over\-sell.** When the system is uncertain — a channel is unreachable, a write is unconfirmed, a reconciliation disagrees — it publishes the *lower* number. A missed sale costs a margin; an oversell costs a fee, a rating and, eventually, an account.
3. **Webhooks are hints; reconciliation is truth.** Every inbound event is treated as "something changed, go look", never as data of record. Every channel is reconciled on a schedule regardless of how quiet it has been.
4. **Measure the latency, do not claim it.** No marketing word appears in the product. The dashboard shows a measured p50/p95/p99 per channel, and the buffer maths uses the p99.
5. **Silence is a failure state.** A channel that has not confirmed a write, an adapter that has not run, a queue that is not draining — each raises an alert. The most dangerous failure in an integration system is the one that looks like nothing happening.
6. **Copy the port pattern.** Channels get the same treatment payments already have: a narrow interface, one adapter per channel, a circuit breaker, and adapters that can be tested against a fake. This is why G4 (10 days per new channel) is achievable.

* * *

## 9\. Solution overview

### 9\.1 The concept model

Five concepts. Everything in §10 is built from them.

**Stock location.** A physical or virtual place stock sits: `WAREHOUSE`, `SHOP_FLOOR`, `NOON_FC` (stock sent into noon's fulfilment centre), `AMAZON_FBA`. Each holds `on_hand` per SKU.

**Shared pool.** The set of locations whose stock is sellable on *any* channel. In v1 that is `WAREHOUSE` only, by default. **`NOON_FC` and `AMAZON_FBA` stock is owned and counted by the marketplace and must never be published to another channel** — including it is a guaranteed oversell. `SHOP_FLOOR` is configurable per SKU and excluded by default, because display units and demo stock are not reliably sellable.

**Reservation.** A hold of `(sku, qty, holder, expires_at)`. A website cart, a marketplace order awaiting acceptance, and a counter transaction in progress are all the same primitive — the system already has this and it is already tested under concurrency.

**Buffer.** A per\-(SKU, channel) quantity withheld from what is published, sized to absorb the channel's propagation delay. **Dynamic, not a global constant.** A static global buffer is the category's most common anti\-pattern: it strands stock on slow movers and still oversells the fast ones.

**Published quantity** — the one formula in this document:

```
published(sku, channel)
  = max(0,
        Σ on_hand(sku, loc) for loc in shared_pool(sku)
      − Σ active reservations(sku)
      − buffer(sku, channel))
```

with a floor rule that overrides it: below the last\-units threshold, publish `0` everywhere except the single highest\-priority channel (see R\-05).

### 9\.2 Architecture

Follows the existing modular monolith. No new runtime, no microservices.

```
        INBOUND                    CORE                     OUTBOUND
  ┌──────────────────┐    ┌────────────────────┐    ┌────────────────────┐
  │ Amazon SQS /     │    │  Event ledger      │    │ Dirty-SKU set      │
  │ EventBridge      │───▶│  (dedupe by        │───▶│  (coalescing)      │
  │ ORDER_CHANGE     │    │   source+event_id) │    │        │           │
  │ MFN_QTY_CHANGE   │    │        │           │    │        ▼           │
  ├──────────────────┤    │        ▼           │    │ Per-SKU FIFO       │
  │ noon webhooks    │───▶│  Stock ledger      │    │  dispatch queue    │
  ├──────────────────┤    │  (Postgres,        │    │        │           │
  │ Storefront       │───▶│   append-only      │    │        ▼           │
  │  (same txn)      │    │   movements)       │    │ Channel Port       │
  ├──────────────────┤    │        │           │    │ ├─ AmazonAdapter   │
  │ Counter sale     │───▶│        ▼           │    │ ├─ NoonAdapter     │
  ├──────────────────┤    │  Reservations      │    │ └─ (fake, tests)   │
  │ Goods receipt    │───▶│  + buffer engine   │    │   rate limiter     │
  ├──────────────────┤    │                    │    │   circuit breaker  │
  │ Reconciler       │◀──▶│  Drift detector    │    │   DLQ + redrive    │
  │  (scheduled)     │    │                    │    │        │           │
  └──────────────────┘    └────────────────────┘    │        ▼           │
                                                     │ Write confirmation │
                                                     │  (closed loop)     │
                                                     └────────────────────┘
```

**Channel Port interface** — the contract every adapter implements:

| Method | Purpose | Required in v1 |
| --- | --- | --- |
| `pushQuantity(listings[])` | Write buffer\-adjusted quantities | Yes |
| `confirmQuantity(skus[])` | Read back what the channel believes | Yes |
| `fetchOrders(since)` | Pull orders, for reconciliation and cold start | Yes |
| `handleEvent(payload)` | Normalise an inbound webhook or notification into a domain event | Yes |
| `acknowledgeOrder(ref)` | Accept / confirm an order on the channel | Yes |
| `pushFulfilment(ref, tracking)` | Mark shipped with a tracking reference | Yes |
| `fetchStatement(period)` | Pull the payout/fee statement | P1 |
| `pushPrice(listings[])` | Write price | P1 |
| `pushListing(product)` | Create or update a listing | P2 |

### 9\.3 The three loops

**Loop 1 — Outbound stock (the core).** Any stock change marks the SKU dirty → a tick (per\-channel interval) flushes the dirty set, sending only the *latest* quantity per SKU → dispatch is partitioned per SKU so writes for one SKU are strictly ordered while different SKUs run in parallel → the adapter applies a client\-side rate limiter matching the channel's documented bucket → a write confirmation closes the loop.

Coalescing is what makes the rate limits survivable: a SKU that changes eight times in ten seconds produces one write, not eight.

**Loop 2 — Inbound orders.** Notification arrives → dedupe against the event ledger → fetch authoritative state from the channel API → create the order in Voltix and consume the reservation → the resulting stock change re\-enters Loop 1 for every *other* channel.

**Loop 3 — Reconciliation.** Four tiers, because one cadence cannot serve both a fast mover and a 3\-hour report SLA:

| Tier | Cadence | Mechanism | Catches |
| --- | --- | --- | --- |
| Write confirmation | Per write | Amazon `LISTINGS_ITEM_MFN_QUANTITY_CHANGE`; noon `/v1/stock-list` read\-back | The channel silently rejected our write |
| Hot SKUs (top movers, low stock) | 5–15 min | `getListingsItem`, noon stock\-list spot check | Drift on the SKUs where drift is expensive |
| Full catalogue | 6–12 h | Amazon `GET_MERCHANT_LISTINGS_ALL_DATA`; noon Reports API | Long\-tail drift, stale listings |
| Financial | Daily \+ per payout | Order counts and line totals per channel; fee statement match | Missed orders, unexpected fees |

* * *

## 10\. Requirements

Priority: **P0** \= v1 cannot ship without it · **P1** \= fast follow · **P2** \= design for it, do not build it.

### 10\.1 P0 — Foundation (blocks everything)

These are Phase 0 from the audit. **No channel adapter is written until all six are done.** A sync engine amplifies whatever it is built on.

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| **F\-01** | Database backups and point\-in\-time recovery | A restore to an arbitrary timestamp within the last 7 days is performed and documented as a drill, not a config setting |
| **F\-02** | Error tracking wired (Sentry DSN already in config) | A deliberately thrown exception in a Server Action appears in Sentry with a source\-mapped stack trace within 60 s |
| **F\-03** | Shared database credential rotated | Old credential proven revoked |
| **F\-04** | Outbound email working | An order placed on the storefront produces a delivered confirmation email |
| **F\-05** | `/healthz` and uptime monitoring | A deliberate outage pages a human within 5 minutes |
| **F\-06** | Rate limiting on public routes | Order\-tracking and search endpoints reject abusive volume; verified by a load script |

### 10\.2 P0 — Catalogue and stock control (prerequisite for sync)

You cannot sync a catalogue you cannot edit. This is the vertical slice the original build skipped.

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| **C\-01** | Product and variant create / edit / publish in the admin | Given a signed\-in user with `product:write`, when they create a product with at least one variant, a price and a stock figure, then it is listed, searchable on the storefront, and appears in the sync engine's SKU list within one tick |
| **C\-02** | Stock adjustment with a mandatory reason code | Given an adjustment of \+5 with reason `GOODS_RECEIPT`, then `stock_movements` records an append\-only entry with actor, timestamp, reason and before/after quantities, and the SKU is marked dirty |
| **C\-03** | Stocktake / cycle count | A count session can be opened for a location, counted quantities entered, and variances posted as adjustments with reason `STOCKTAKE`. Variance report shows value at cost |
| **C\-04** | Stock location model | Every quantity is held against a location. Locations are typed (`WAREHOUSE`, `SHOP_FLOOR`, `NOON_FC`, `AMAZON_FBA`) and each carries a flag for whether it participates in the shared pool |
| **C\-05** | Per\-SKU serial / IMEI capture | Given a serialised product, when it is received and when it is sold, the IMEI is recorded against the stock unit and the order line. **The storefront already promises "the IMEI recorded against your order" — this closes a live marketing claim the software does not honour.** Also required for warranty and for UAE electronics compliance traceability |

### 10\.3 P0 — The sync engine

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| **S\-01** | **Single system of record** | Given a stock change from any source, then the Voltix stock ledger is updated inside the originating transaction, and no channel is ever read to determine on\-hand quantity |
| **S\-02** | **Channel listing map** | Each internal SKU maps to zero or more channel listings, each holding: channel, channel SKU, channel listing ID (ASIN / noon `partner_sku`), external IDs, fulfilment model, warehouse code, status, buffer override, last pushed quantity \+ timestamp, last confirmed quantity \+ timestamp. **The internal SKU is the sole primary key; a channel identifier is never a primary key.** One internal SKU may have several listings on the same channel (new vs open\-box) |
| **S\-03** | **Buffer engine** | Buffer is computed per (SKU, channel) as `ceil(peak_velocity_per_min × channel_p99_propagation_min × safety_factor)`, floored at 0 and capped by a per\-SKU maximum. Every buffer is explainable in the UI: "3 units withheld from noon — 2.1 units/min peak × 1.2 min p99 × 1.2". A global static buffer is explicitly rejected |
| **S\-04** | **Published\-quantity calculation** | The formula in §9.1 is implemented as one pure, unit\-tested function. Marketplace\-held stock (`NOON_FC`, `AMAZON_FBA`) is excluded from the shared pool. Given `on_hand=10, reserved=2, buffer=3`, then `published=5` |
| **S\-05** | **Last\-units protection** | Given available stock at or below the threshold (default 2 for serialised electronics), then quantity is published only to the highest\-priority channel and `0` to all others, and the admin shows why. **Highest single\-rule ROI in the design** |
| **S\-06** | **Outbound coalescing and ordering** | Given eight changes to one SKU within a tick window, then exactly one write is dispatched carrying the latest quantity. Writes for one SKU are strictly ordered; different SKUs proceed in parallel |
| **S\-07** | **Client\-side rate limiting** | Each adapter enforces the channel's documented token bucket proactively (Amazon `patchListingsItem` 5/s burst 5; noon stock 1500/60 s). A 429 is treated as a bug in our limiter, alerted, and retried with exponential backoff plus **full jitter** |
| **S\-08** | **Circuit breaker per (channel, operation)** | After N consecutive failures the breaker opens; while open, deltas are **queued, never dropped**; on half\-open a single probe runs; on close, only the latest quantity per SKU is flushed. An Amazon outage must not stall noon writes |
| **S\-09** | **Dead\-letter queue with alerting and redrive** | Any message exceeding max retries lands in a DLQ. **DLQ depth \> 0 raises an alert**, and a documented one\-click redrive exists. A silent DLQ is a data\-loss mechanism |
| **S\-10** | **Write confirmation (closed loop)** | Every push is verified: Amazon via `LISTINGS_ITEM_MFN_QUANTITY_CHANGE`, noon via a `/v1/stock-list` read\-back. An unconfirmed write after the channel's SLA window raises drift, not silence |
| **S\-11** | **Error classification** | 429/500/502/503/504/timeout are retried; 400/403/404/413/415 are not — they are logged as defects and surfaced. Feed and batch responses are parsed per record: **a `DONE` feed status does not mean every SKU succeeded** |
| **S\-12** | **Reconciliation, four tiers** | Implemented per §9.3. Each tier records outcome, duration and SKUs\-diverged count. Reconciliation runs on schedule even when the channel has been quiet |
| **S\-13** | **Drift detection and auto\-heal** | Given a channel quantity differing from expected, then a drift record is created with both values, an auto\-correction write is issued, and the event is counted. Drift exceeding a per\-channel threshold pages a human instead of silently re\-writing |
| **S\-14** | **Event idempotency ledger** | `(source, event_id)` unique; insert\-on\-conflict\-do\-nothing. Given the same notification delivered three times, then it is processed once. Inbound events older than the last\-applied timestamp for that entity are discarded |
| **S\-15** | **Kill switch, global and per channel** | An operator can pause outbound writes to one channel or all channels in one click, without a deploy. Paused channels queue rather than drop, and the UI states how far behind each is |

### 10\.4 P0 — Order ingestion

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| **O\-01** | Amazon order ingestion via `ORDER_CHANGE` | Given an `ORDER_CHANGE` notification, then within 60 s the order exists in Voltix with items, quantities, channel reference and channel fees, and stock is consumed. **Polling `searchOrders` at 0.0056 req/s is not an acceptable primary path** |
| **O\-02** | noon order ingestion via FBPI webhooks | Same outcome, allowing that **noon order payloads contain no customer address or email** — the order model must accept a channel\-fulfilled order with no shipping address without failing validation |
| **O\-03** | Unified order queue | All channels' orders appear in one admin list, filterable by channel, with channel badge, channel reference and channel\-specific SLA clock |
| **O\-04** | Cold start and gap recovery | On first connection, or after any outage, orders are backfilled from the channel API for a configurable lookback, deduplicating against already\-ingested orders |
| **O\-05** | Fulfilment push\-back | When an order is marked shipped in Voltix, the tracking reference is written back to the originating channel within 5 minutes |
| **O\-06** | Marketplace cancellation and return handling | A cancellation or return on any channel restores stock to the correct location and marks the SKU dirty. **noon decides returns, not the merchant** — the model must accept externally\-determined return outcomes |

### 10\.5 P0 — The physical shop

The hardest channel, because a counter sale has **zero propagation warning**.

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| **P\-01** | Counter sale entry | A staff member records a sale — scan or search, quantity, payment method, optional customer — and completes it in **under 20 seconds on a phone or tablet**. Measured, not asserted. If it is slower than a notebook, it will not be used |
| **P\-02** | Sale decrements the shared pool inside the transaction | Given a counter sale of 1 unit, then available stock drops immediately and every channel is marked dirty in the same transaction |
| **P\-03** | Live availability lookup | A staff member can search a SKU and see: on hand by location, reserved, available, and what each channel currently shows |
| **P\-04** | Offline\-tolerant capture | If the device is offline, the sale is queued locally and posted on reconnect, with the delay visible. **Stock correctness is best\-effort during offline capture and this is stated in the UI** — a shop that cannot sell when the internet drops is not acceptable, and pretending the number is live when it is not is worse |
| **P\-05** | Shop\-floor stock is excluded from the online pool by default | Per\-SKU override available. Rationale: display units and demo stock are not reliably sellable, and high\-ASP electronics do not tolerate the error |
| **P\-06** | Tax invoice for a counter sale | A compliant UAE tax invoice is issued, carrying the TRN, sequential number and VAT breakdown (see §12) |

### 10\.6 P0 — Observability

Non\-negotiable, because principle 5 says silence is a failure state.

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| **V\-01** | Sync health dashboard | Per channel: last successful write, queue depth, p50/p95/p99 write→confirm latency, drift count, breaker state, DLQ depth. Loads in under 2 s |
| **V\-02** | Latency histogram per channel | Measured continuously and used as the input to the buffer engine. **This is the number the product markets on** |
| **V\-03** | Oversell register | Every oversell event recorded with channel, SKU, timestamp, quantity, root cause, and estimated cost in AED (referral fee × price for noon; cancellation\-rate impact for Amazon) |
| **V\-04** | Alerting | Pages a human on: DLQ depth \> 0 · breaker open \> 5 min · a channel with no successful write in 30 min · drift above threshold · any oversell event |
| **V\-05** | Product analytics events actually written | `analytics_events` has existed with no writer. The sync engine writes to it from day one — instrumentation is cheap now and never gets added later |

### 10\.7 P1 — Fast follow

| ID | Requirement |
| --- | --- |
| **N\-01** | **Payout and fee reconciliation** — pull noon and Amazon statements, match every line to an order, surface true per\-channel margin after commission, fulfilment, return and cancellation fees. **Nobody in the competitive set does this.** Serves G6 |
| **N\-02** | Price push to channels (human\-set, no automation) |
| **N\-03** | Purchase orders and supplier management — `purchase_orders` and `suppliers` tables already exist with no UI; feeds the existing replenishment forecaster |
| **N\-04** | Shipments and tracking as first\-class objects (orders currently jump confirmed → fulfilled with no tracking number) |
| **N\-05** | Bundles and kits — `available(bundle) = min over components of floor((available − buffer) / qty_per_bundle)`, with a reverse index so any component change re\-derives every bundle containing it. **A classic missed requirement and a direct oversell cause** |
| **N\-06** | Discounts admin (the pricing engine exists; there is no way to create a discount) |
| **N\-07** | Financial reporting: sales, margin, VAT summary, emirate\-wise breakdown |
| **N\-08** | Admin mobile layout — the primary persona is phone\-first and the admin is not |

### 10\.8 P2 — Design for, do not build

| ID | Consideration | What to preserve now |
| --- | --- | --- |
| **X\-01** | Carrefour UAE via a **generic Mirakl adapter** | Keep the Channel Port free of Amazon/noon\-specific assumptions, and support async write semantics (`import_id` then poll) — Mirakl confirms nothing synchronously |
| **X\-02** | Listing creation and catalogue publishing | Product model carries per\-channel attribute overrides and compliance fields (ECAS ref, TDRA ref, HS code, expiry dates) from the start |
| **X\-03** | Second\-tenant / SaaS | RLS is already forced and tested. **Do not regress it.** Every new table gets a policy on day one |
| **X\-04** | UAE e\-invoicing (Peppol PINT AE) | Invoice model carries all 51 mandatory PINT AE fields even while only B2C is transacted. See §12 |
| **X\-05** | Additional channels (TikTok Shop UAE, Sharaf DG, Amazon.sa) | Adapter pattern; no channel names in core |
| **X\-06** | AI features | See §13 |

* * *

## 11\. Success metrics

### 11\.1 Leading indicators (days to weeks)

| Metric | Definition | Target | Method |
| --- | --- | --- | --- |
| **Sync latency p95** | SoR change → channel confirms | Amazon \< 5 min · noon \< 2 min · storefront \< 1 s | Histogram from `V-02`, per channel, rolling 24 h |
| **Write success rate** | Confirmed writes ÷ attempted | \> 99.5% per channel per day | Adapter telemetry |
| **Drift rate** | SKUs where channel quantity ≠ expected, at each reconciliation | \< 0.5% of active listings | Reconciliation tiers |
| **Time to converge** | Drift detected → drift corrected | p95 \< 10 min | Drift register |
| **Stale SKU count** | Listings with no successful write in \> 24 h | 0 | Nightly sweep |
| **Counter sale duration** | Scan → sale complete | Median \< 20 s | Instrumented in the POS flow |
| **DLQ depth** | Messages awaiting redrive | 0, sustained | Queue metric |

### 11\.2 Lagging indicators (weeks to months)

| Metric | Target | Evaluate at |
| --- | --- | --- |
| **Oversell events per 1,000 orders** (G1) | \< 2 | 60 days |
| **AED lost to cancellation and return\-admin fees** | Down \> 80% vs baseline | 90 days |
| **Amazon Pre\-Fulfilment Cancel Rate** | Sustained below the policy threshold | 90 days |
| **Manual portal minutes per week** (G2) | \< 15 | 30 days |
| **SKUs published on 2\+ channels** (G5) | \> 85% | 90 days |
| **Revenue per SKU, multichannel vs single\-channel** | Positive lift, measured per cohort | 180 days |
| **Days to add channel \#3** (G4) | \< 10 | On first attempt |

### 11\.3 Baseline first

**Two weeks of baseline measurement before any adapter ships**, capturing: minutes per week in channel portals, cancellations caused by stockouts, AED in cancellation and return\-admin fees, and current stock accuracy at a cycle count. Without this, none of the lagging indicators can be evaluated — and because §3.5 established that no UAE benchmark exists, **our own baseline is the only benchmark that will ever be available.**

* * *

## 12\. Compliance requirements

UAE\-specific, and largely unserved by any competitor in §3.3.

**L\-01 · VAT at 5% on domestic supplies, correctly split per line.** VERIFIED. Already correct in the existing pricing engine — preserve it.

**L\-02 · Compliant tax invoice.** VERIFIED (Art. 59, VAT Executive Regulations). A full tax invoice — heading, supplier TRN, recipient TRN for B2B, sequential number, dates, per\-line description, quantity and unit price, per\-line VAT rate and amount, total payable — is required for B2B and for any supply above AED 10,000. A simplified invoice is permitted for B2C below that. Gapless numbering is already implemented via the `counters` table.

**L\-03 · Capture and persist the customer's emirate on every order.** VERIFIED (FTA / VATP033). Businesses whose e\-commerce taxable supplies exceed **AED 100m** in twelve months must report sales broken down by the emirate in which the supply is *received*. **Capture it from day one even though we are far below the threshold** — emirate attribution cannot be retrofitted onto historical orders.

**L\-04 · E\-invoicing readiness (Peppol PINT AE).** VERIFIED (Deloitte ME, guidelines v1.1, Jun 2026) — confirm on mof.gov.ae before committing dates. A 5\-corner model via an Accredited Service Provider, in which only structured XML is a valid e\-invoice. **Phase 1 go\-live 1 Jan 2027 for revenue ≥ AED 50m; Phase 2 go\-live 1 Jul 2027 for everyone else.** B2C is currently out of scope; B2B and B2G are in scope regardless of VAT registration status. Carry all 51 mandatory PINT AE fields in the invoice model now; ASP integration is P2.

**L\-05 · Consumer\-protection obligations.** VERIFIED (Federal Law 15/2020 as amended; Cabinet Decision 66/2023). Disclose the licensing entity; provide product information in Arabic; display price clearly and never charge above it; provide a dated invoice; honour warranty. **Price\-drop rule: if the same goods are discounted within one week of purchase, the consumer may claim the difference — so log price history per SKU per channel.**

**L\-06 · Return window.** REPORTED — **blocking for the returns copy, not for the sync engine.** A 14\-day cooling\-off right for online purchases is widely reported but was not stated in the primary sources reviewed. Make the window a configuration value, not a constant, and have counsel confirm the primary text.

**L\-07 · PDPL — data protection.** VERIFIED that the law exists; REPORTED on regulation status. Records of processing with lawful basis, DSAR handling, cross\-border transfer controls, breach notification. The Executive Regulations were still not confirmed as in force in 2026 — **build to the principles, not to a deadline.** Note that noon order payloads carry no buyer PII, which removes that surface on the primary channel.

**L\-08 · Amazon SP\-API Data Protection Policy.** VERIFIED — **the longest lead\-time item in the whole project. Start it in week 1.** If Amazon.ae orders are self\-shipped, buyer addresses require a PII\-bearing role, which triggers an enhanced data\-security assessment: 30\-day vulnerability scans, an annual penetration test, encryption in transit and at rest, a 30\-day PII deletion rule, 90\-day log retention and a 24\-hour incident\-response plan — as **evidence, not intentions**. Amazon closes cases if information requests go unanswered for five days.

**L\-09 · Product compliance fields on the product master.** REPORTED (industry source) — verify with the customs broker. ECAS/MoIAT certificate reference, TDRA type\-approval reference (mandatory for anything with WiFi, Bluetooth, cellular or GPS), HS code, and certificate expiry dates, with expiry alerting. As of Feb 2026, TDRA approval and a customs clearance permit must both be in place and aligned before a shipment arrives.

**L\-10 · Trade licence covers the activity.** VERIFIED (noon seller requirements). The licence must cover the traded activity and be valid for marketplace onboarding — noon requires at least 30 days of remaining validity. **The current licence expires 11 Nov 2026 and lists no e\-commerce activity.** This is a business\-blocking dependency, not a software one.

## 13\. The AI question, answered

The repository name promises AI. The software contains none. **This PRD resolves that by sequencing, not by pretending.**

**Position for the next 12 months:** Voltix competes on *correctness and measured latency*, not on machine intelligence. The name should change or the claim should be dropped from customer\-facing surfaces. Statistical forecasting already shipping — Croston's method for intermittent demand, Holt's smoothing for trend — is **the right tool and beats a language model at its job.** It should be kept, and described accurately as statistical forecasting.

**Where a model genuinely earns its place, in order of value, all P2 and all after the sync engine is stable:**

| Rank | Use case | Why it is real |
| --- | --- | --- |
| 1 | **Catalogue extraction from supplier sheets** | Every supplier sends a differently\-shaped spreadsheet or PDF. Turning those into structured products is exactly what language models are good at and what humans hate. Highest value, lowest risk — a human approves every row |
| 2 | **Channel listing content generation** | Per\-category attribute schemas, titles and bullets in English and Arabic, tuned per channel. Directly unblocks the P1 listing\-creation work |
| 3 | **Return\-reason classification** | UAE COD refusals arrive with no captured reason, leaving inventory in limbo. Classifying free\-text and image evidence into structured reasons has a clear operational payoff |
| 4 | **Semantic search** | `product_embeddings` exists with zero rows. Requires generating embeddings. Genuine improvement, but lexical `tsvector` search is adequate today |
| 5 | **WhatsApp ordering assistant** | Strong regional demand signal, but it is a new channel with a new failure surface. Not before the four in scope are solid |

**What does not get an LLM:** stock quantities, buffer decisions, pricing, and any path where a wrong answer costs money silently. Those stay deterministic and testable.

* * *

## 14\. Phasing and timeline

Estimates assume a small team. **The gate conditions are firm; the durations are estimates.**

| Phase | Duration | Content | Gate to exit |
| --- | --- | --- | --- |
| **Phase 0 — Make it safe** | 1–2 weeks | F\-01 … F\-06. In parallel and starting **week 1**\: Amazon developer registration and the DPP evidence pack (L\-08); noon API credentials; two\-week baseline measurement (§11.3) | A data\-loss event is recoverable, a production error reaches a human, a customer receives an email |
| **Phase 1 — Make it manageable** | 3–4 weeks | C\-01 … C\-05. Product CRUD, stock adjustment, stocktake, locations, serial capture | The merchant can run the catalogue with no developer |
| **Phase 2 — Make it sync** | 5–7 weeks | S\-01 … S\-15, O\-01 … O\-06, V\-01 … V\-05. **noon first** (higher rate limits, simpler PII surface, and it is the bigger UAE channel for this merchant), Amazon second | 14 consecutive days at zero oversells with both marketplaces live |
| **Phase 3 — Close the loop** | 2–3 weeks | P\-01 … P\-06. The shop counter | Counter staff use it for every sale for two weeks without reverting to the notebook |
| **Phase 4 — Make it pay** | 4–6 weeks | N\-01 … N\-08. Payout reconciliation first | True per\-channel margin visible for a full payout cycle |
| **Phase 5 — Strategic** | — | Carrefour (after Mirakl verification), listing creation, AI use case \#1, SaaS horizon | Deliberate decision, not drift |

### Hard dates and dependencies

| Date | Item | Impact |
| --- | --- | --- |
| **11 Nov 2026** | Trade licence expiry; no e\-commerce activity currently listed | **Business\-blocking.** Marketplace onboarding requires ≥30 days validity |
| **1 Jan 2027** | UAE e\-invoicing Phase 1 (revenue ≥ AED 50m) | Not applicable at current scale, but sets the model design |
| **1 Jul 2027** | UAE e\-invoicing Phase 2 (all remaining businesses) | Applicable. ASP appointment due 31 Mar 2027 |
| Ongoing | Amazon restricted\-role approval | Unknown duration, gated on evidence. **Longest lead time in the project** |
| Ongoing | noon API access and FBPI enablement | Requires account\-manager engagement |

* * *

## 15\. Risks

| ID | Risk | Prob. | Impact |
| --- | --- | --- | --- |
| R\-01 | noon's stock propagation turns out to be minutes, not seconds | Medium | High |
| R\-02 | Amazon restricted\-role approval is refused or slow | Medium | High |
| R\-03 | Counter staff do not use the POS flow | **High** | **High** |
| R\-04 | Sync engine built on the unstable Phase 0 foundation | Medium | High |
| R\-05 | Trade licence lapses or lacks e\-commerce activity | Medium | **Critical** |
| R\-06 | Partial trust — the merchant keeps doing manual work anyway | Medium | High |
| R\-07 | A silent adapter failure goes unnoticed | Medium | High |
| R\-08 | Marketplace\-held stock (FBA/FBN) leaks into the shared pool | Low | **Critical** |
| R\-09 | Amazon revives SP\-API developer fees | Low | Medium |
| R\-10 | Scope creep into listing creation | **High** | Medium |
| R\-11 | noon changes its API — it is new and expanded rapidly in 2026 | Medium | Medium |

**R\-01 · noon propagation latency.** Measure it empirically in the sandbox during Phase 0, before committing to buffer maths. *Contingency:* buffers scale with measured p99, and the design already accommodates a slow channel.

**R\-02 · Amazon role approval.** Start in week 1. Prepare the evidence pack — penetration test, scan cadence, data\-flow diagram, incident\-response runbook — rather than promises, and always respond to Amazon within five days. *Contingency:* use Amazon fulfilment (FBA) for Amazon orders, which removes the need for buyer addresses entirely.

**R\-03 · POS adoption.** The highest\-probability, highest\-impact risk in the document. Design for under 20 seconds and measure it; involve the counter staff member in Phase 3 design, not just testing. *Contingency:* if unused, exclude shop\-floor stock from the online pool permanently — this degrades G5 but protects G1.

**R\-04 · Building on sand.** Phase 0 is a hard gate, not a recommendation. *Contingency:* stop and fix. There is no partial version of "we have backups."

**R\-05 · Trade licence.** Amend and renew now, well before the 30\-day marketplace validity floor. *Contingency:* none — no software mitigation exists.

**R\-06 · Partial trust.** The drift dashboard and oversell register are trust instruments, not merely diagnostics; make correctness *visible*, not just true. *Contingency:* weekly review of drift events until the number is boring.

**R\-07 · Silent failure.** Principle 5. Alert on absence: no successful write in 30 minutes, DLQ depth above zero, breaker open beyond five minutes. *Contingency:* the reconciliation tiers catch it within 12 hours at worst.

**R\-08 · Pool contamination.** Location typing (C\-04) with shared\-pool participation as an explicit flag, plus a unit test asserting the exclusion. *Contingency:* immediate kill switch (S\-15).

**R\-09 · SP\-API fees.** Register as a **private** developer — exempt under the scheme Amazon cancelled in May 2026, whose cancellation was worded "at this time." *Contingency:* costs would be per\-call and modest at this volume.

**R\-10 · Scope creep.** It is a named non\-goal with a stated rationale; any addition requires an equivalent removal. *Contingency:* re\-scope explicitly and move the date, in writing.

**R\-11 · noon API churn.** Adapter isolation, contract tests against recorded fixtures, and an eye on the changelog. *Contingency:* adapter\-local fix, no core changes.

## 16\. Open questions

**Blocking — must be answered before the phase named.**

| \# | Question | Owner | Needed by |
| --- | --- | --- | --- |
| Q\-01 | **What is noon's actual stock\-update propagation latency?** Measure via `/v1/stock-update` → `/v1/stock-list` round trips in the sandbox and then production | Engineering | Phase 0 |
| Q\-02 | **What is noon's order API shape?** Endpoint paths, order state machine, event\-type enumeration, webhook retry policy, signature scheme — none of it was exposed in the public docs reviewed. Requires a noon solution\-architect conversation | Engineering \+ noon AM | Phase 2 start |
| Q\-03 | **Which fulfilment model per channel?** noon FBP vs FBPI vs FBN, and Amazon FBA vs MFN. **noon requires all of a SKU's stock in one framework — it cannot be split.** This decision determines whether L\-08 (Amazon PII role) is even needed | Owner (business) | Phase 0 |
| Q\-04 | **Is the Amazon Pre\-Fulfilment Cancel Rate threshold 2.5% in the AE account, and what is our current figure?** | Owner — check Seller Central AE | Phase 0 (it is the G1 baseline) |
| Q\-05 | **Trade licence: can e\-commerce activity be added, and when is renewal filed?** | Owner | Immediately |
| Q\-06 | **Is shop\-floor stock sellable online, per SKU or as a blanket rule?** Determines the default in P\-05 | Owner | Phase 3 |

**Non\-blocking — resolve during implementation.**

| \# | Question | Owner |
| --- | --- | --- |
| Q\-07 | Is Carrefour UAE actually on Mirakl? Verify from a seller's portal URL before scoping X\-01 | Product |
| Q\-08 | Confirm the 14\-day return window against the primary text of Cabinet Decision 66/2023 (L\-06) | Legal |
| Q\-09 | Amazon.ae payout cycle — global 14\-day / delivery\+7 terms are assumed, not confirmed for AE | Finance |
| Q\-10 | Is TikTok Shop live for UAE sellers? Sources directly contradict each other | Product |
| Q\-11 | Confirm the e\-invoicing ASP deadline on mof.gov.ae (30 Oct 2026 per Deloitte vs 31 Jul 2026 per a stale source) | Finance |
| Q\-12 | Does noon gate API access by seller tier or GMV, and what is the approval SLA? | Product |
| Q\-13 | What safety factor should the buffer engine use before real latency data exists? Proposed interim: 1.5, revised from measured p99 after 30 days | Engineering |

* * *

## Appendix A — Glossary

| Term | Meaning |
| --- | --- |
| **Available** | `on_hand − reservations`, before the buffer is applied |
| **Published** | What a channel is told, after buffer and last\-units rules |
| **Buffer** | Quantity deliberately withheld from a channel to absorb its propagation delay |
| **Drift** | A channel's believed quantity differing from what we last pushed |
| **Coalescing** | Collapsing many changes to one SKU into a single outbound write |
| **Closed loop** | Verifying a write landed, rather than assuming a 200 response means it did |
| **FBN / noon Express** | Fulfilled by noon — noon holds the stock |
| **FBP** | Fulfilled by Partner — the seller holds and ships the stock |
| **FBPI** | Fulfilled by Partner Integration — seller warehouse, systems integrated with noon |
| **FBA / MFN** | Fulfilled by Amazon / Merchant Fulfilled Network |
| **PINT AE** | Peppol International Invoice, UAE specialisation — the e\-invoicing XML schema |
| **RDT** | Restricted Data Token — Amazon's mechanism for accessing buyer PII |
| **SoR** | System of record — here, the Voltix Postgres stock ledger |

* * *

## Appendix B — Traceability

| Goal | Requirements | Metrics |
| --- | --- | --- |
| G1 Eliminate overselling | S\-01 … S\-14, P\-02, P\-05, O\-06 | Oversell events/1,000 orders; drift rate; AED in fees |
| G2 Remove manual maintenance | C\-01 … C\-03, S\-01, O\-01 … O\-03, P\-01 | Manual portal minutes/week |
| G3 Fast, measured truth | S\-06, S\-07, S\-10, V\-01, V\-02 | Latency p50/p95/p99 per channel |
| G4 Cheap channel expansion | S\-02, Channel Port (§9.2), X\-01 | Engineering days for channel \#3 |
| G5 Unlock held\-back stock | S\-03, S\-04, S\-05, C\-04 | % SKUs on 2\+ channels |
| G6 True channel margin | N\-01, V\-03, L\-02 | % orders reconciled to payout |

* * *

## Appendix C — Research sources

**Channel APIs (primary documentation)**

- [Amazon SP\-API — patchListingsItem](https://developer-docs.amazon.com/sp-api/reference/patchlistingsitem) · [Listings Items use\-case guide](https://developer-docs.amazon.com/sp-api/docs/listings-items-api-v2021-08-01-use-case-guide) · [Listings APIs FAQ](https://developer-docs.amazon.com/sp-api/docs/listings-apis-faq)
- [Amazon SP\-API — searchOrders (Orders v2026\-01\-01)](https://developer-docs.amazon.com/sp-api/reference/searchorders) · [Notification type values](https://developer-docs.amazon.com/sp-api/docs/notification-type-values) · [Usage plans and rate limits](https://developer-docs.amazon.com/sp-api/docs/usage-plans-and-rate-limits)
- [Amazon SP\-API — security and compliance overview](https://developer-docs.amazon.com/sp-api/docs/security-compliance-overview) · [Restricted Data Token](https://developer-docs.amazon.com/sp-api/docs/authorization-with-the-restricted-data-token) · [Marketplace IDs](https://developer-docs.amazon.com/sp-api/docs/marketplace-ids)
- [noon API Platform — introduction](https://noon-docs.noonpartners.dev/docs/getting-started/intro) · [quick start](https://noon-docs.noonpartners.dev/docs/getting-started/quick-start) · [Stock service — update stock](https://noon-docs.noonpartners.dev/docs/api-reference/stock/stock-service-update-stock) · [get stock](https://noon-docs.noonpartners.dev/docs/api-reference/stock/stock-service-get-stock)
- [noon — Fulfilled by Partner Integration guide](https://support.noon.partners/portal/en/kb/articles/fulfilled-by-partner-integration-a-comprehensive-guide) · [FBPI FAQs](https://support.noon.partners/portal/en/kb/articles/fulfilled-by-partner-integration-fbpi-faqs)
- [Mirakl — OF24 create/update/delete offers](https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3/offers/of24) · [Sellercloud — Carrefour via Mirakl](https://help.sellercloud.com/sellercloud-knowledge-base/integrations/channels/carrefour/carrefour-account-integration~7630870315600404626)
- [Shopify — about webhooks (delivery is not guaranteed)](https://shopify.dev/docs/apps/build/webhooks) · [WooCommerce webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v2/webhooks/)

**Marketplace economics**

- [noon — FBP fees in UAE (eff. 1 Sep 2025)](https://support.noon.partners/portal/en/kb/articles/fulfilled-by-partner-fbp-fees-in-uae) · [FBN fees in UAE](https://helpcenter.noon.partners/en/category/fulfilled-by-noon-fbn/fulfilled-by-noon-fbn-fees-in-uae) · [documents required to sell on noon](https://helpcenter.noon.partners/en/category/getting-started/documents-required-to-sell-on-noon)
- [Amazon.ae — selling fees](https://sell.amazon.ae/pricing) · [fulfilment options](https://sell.amazon.ae/fulfill)

**Market**

- [Gulf News — UAE as a cross\-border e\-commerce hub (Euromonitor × EZDubai, Mar 2026)](https://gulfnews.com/business/economy/bz3mqoo-uae-consolidates-its-position-global-hub-for-1.500467599) · [Mordor Intelligence — UAE e\-commerce market](https://www.mordorintelligence.com/industry-reports/united-arab-emirates-ecommerce-market) · [ECDB — UAE electronics e\-commerce](https://ecdb.com/resources/sample-data/market/ae/electronics)
- [Mirakl 2026 Seller Report — key insights](https://www.mirakl.com/blog/the-marketplace-revolution-key-insights-from-our-2026-seller-report)

**Competitive**

- [ChannelEngine — noon marketplace guide (15\-minute offer cadence)](https://support.channelengine.com/hc/en-us/articles/16319074295197-noon-marketplace-guide) · [ChannelEngine — noon](https://www.channelengine.com/en/all-marketplaces/noon)
- [Omniful — noon integration](https://www.omniful.ai/docs/integration/noon-integration-document) · [Omniful pricing & packages](https://docs.omniful.ai/partners/omniful-pricing-packages.pdf)
- [Veeqo — supported Amazon marketplaces](https://help.veeqo.com/en/articles/6348824-connecting-your-amazon-store) · [Linnworks integrations](https://www.linnworks.com/integrations/) · [Sellbrite pricing](https://www.sellbrite.com/pricing-pro/) · [Cin7 pricing](https://www.cin7.com/pricing/) · [Zentail pricing](https://www.zentail.com/pricing)
- [ChannelDock — inventory sync frequency: audit real\-time claims](https://channeldock.com/en/blogs/inventory-sync-frequency-audit/) · [Soluvide — UAE retail automation (bespoke noon \+ Amazon.ae \+ POS sync)](https://soluvide.com/industries/retail)

**Regulatory**

- [Deloitte Middle East — UAE e\-invoicing: ASP deadline extended, go\-live remains 1 Jan 2027](https://www.deloitte.com/middle-east/en/services/tax/perspectives/uae-e-invoicing-asp-appointment-deadline-extended-but-go-live-remains-01012027.html) · [ClearTax AE — e\-invoicing UAE](https://www.cleartax.com/ae/e-invoicing-uae)
- [UAE FTA — emirate\-specific VAT reporting for e\-commerce](https://tax.gov.ae/en/media.centre/News/the.federal.tax.authority.stresses.the.need.for.accurate.emiratespecific.vat.reporting.in.relation.to.ecommerce.aspx) · [BDO — new VAT reporting requirement for e\-commerce supplies](https://www.bdo.global/en-gb/insights/tax/indirect-tax/united-arab-emirates-new-vat-reporting-requirement-for-e-commerce-supplies-and-rules-for-reporting)
- [K&L Gates — UAE consumer protection and e\-commerce laws](https://www.klgates.com/Update-UAE-Consumer-Protection-and-E-Commerce-Laws-1-23-2024) · [u.ae — consumer protection](https://u.ae/en/information-and-services/justice-safety-and-the-law/consumer-protection)

**Sync engine patterns**

- [Hookdeck — webhook ordering: why it's hard and how to handle it](https://hookdeck.com/webhooks/guides/webhook-ordering-why-its-hard-and-how-to-handle-it) · [Celigo — automating buffer stock for marketplace inventory accuracy](https://www.celigo.com/blog/how-to-automate-buffer-stock-for-marketplace-inventory-accuracy/) · [AWS — using SQS dead\-letter queues to replay messages](https://aws.amazon.com/blogs/compute/using-amazon-sqs-dead-letter-queues-to-replay-messages)

* * *

*Research conducted 12 August 2026. Where this document and the 9 Aug 2026 reverse\-engineering audit disagree on what should be built next, this document governs; where they disagree on what currently exists, the audit governs.*
