# Voltix Sync — Product Design Document

**Designing a system whose main job is to be invisible, for a user who has every reason not to trust it.**

|  |  |
| --- | --- |
| **Version** | 1\.0 |
| **Date** | 12 August 2026 |
| **Status** | Draft for review |
| **Implements** | Voltix Sync — Product Requirements Document v1.0 |
| **Inherits from** | Voltix Commerce reverse\-engineering audit, §9 (9 Aug 2026) |
| **Precedes** | Technical Requirements Document · Wireframing Document |

* * *

## How to read this document

The PRD said *what* to build and *why*. This document says *what it looks like, how it behaves, and what it says* — screen by screen, state by state.

It does not contain visual mockups. Those belong in the wireframing document that follows. What is here is the layer beneath the pixels: information architecture, screen specifications, interaction patterns, state coverage, copy rules and design\-system deltas. A wireframe drawn without this document would be decoration; a wireframe drawn from it can be checked for correctness.

**Layout sketches** appear as monospaced blocks. They indicate hierarchy and grouping only — not spacing, proportion or final wording.

Anything marked **INHERITED** already exists in the codebase and is being preserved deliberately.

* * *

## 1\. The central design problem

Every other screen in Voltix shows the user something they asked to see. Voltix Sync shows them something they hope never to think about.

That inverts the usual design goal. A sync engine that works perfectly is one the merchant never opens. But a merchant who never opens it has no evidence it is working — and the PRD identified the resulting failure mode as the highest\-probability risk in the project (R\-06): **the merchant keeps doing the manual work anyway, "just to be safe."** At that point the product has added work rather than removed it.

So the design has two jobs that pull against each other:

1. **Disappear.** Zero interaction required on a normal day. No dashboards to babysit, no queues to clear, no confirmations to click.
2. **Be provably right.** When the merchant does look — and in the first weeks he will look constantly — the answer to *"is it actually working?"* must be immediate, specific and honest. Not a green tick. A number, a timestamp, and a way to see the working.

**The resolution: build trust instruments, not dashboards.** A dashboard reports status. A trust instrument answers a doubt. Every screen in §9 is designed against a specific doubt the merchant will have, and that doubt is named in the spec.

The second design problem is smaller but harder to recover from. The counter\-sale flow (§9.8) must be **faster than not using it**. If recording a shop sale takes longer than scribbling it in a notebook, the notebook wins, the stock pool is corrupted at its source, and every other screen in this document becomes a well\-designed liar.

* * *

## 2\. Design goals

| \# | Goal | How it is judged |
| --- | --- | --- |
| **D1** | A merchant can answer "is my stock right everywhere?" in under 5 seconds | Time\-to\-answer, measured on the sync health screen from a cold open |
| **D2** | Every number the system shows can be traced to why it is that number | No quantity appears anywhere without an available explanation |
| **D3** | A counter sale takes under 20 seconds, on a phone, one\-handed | Instrumented in production; median and p90 both tracked |
| **D4** | Degradation is visible before it is harmful | Every screen shows the freshness of what it is displaying |
| **D5** | The admin is usable on a phone | The primary persona is phone\-first; today the admin collapses below 900px |
| **D6** | Nothing on screen is ever a fabrication | Inherited principle, extended to sync: unknown is "—", never 0 |

* * *

## 3\. Design principles

### 3\.1 Inherited — keep exactly as they are

The audit found six principles consistently applied in the existing code. They were never written down and they are good. They are now written down.

1. **Never fabricate a number.** A missing cost renders as `—`, not `0%`. No prior period renders as `—`, not `0.0%`.
2. **Colour follows required action, not enum order.** `refunded` is neutral. `failed` is red. A status is not coloured because it is late in a list.
3. **Explain absence.** Empty states say why the thing is empty and what to do about it. Never "No data".
4. **Honest copy.** A cash\-on\-delivery confirmation never says "paid".
5. **Server\-rendered by default.** Interactivity has to earn itself.
6. **Derive from the source of truth.** The delivery page computes charges using the same function checkout uses, so it cannot drift out of agreement with reality.

### 3\.2 New — specific to sync

7. **Show the working.** Any published quantity can be expanded into the arithmetic that produced it: on hand, minus reservations, minus buffer, and why the buffer is that size. A number the merchant cannot audit is a number he will re\-check by hand.
8. **Freshness is part of the data.** Every channel\-derived value carries "as of" information. A quantity from four hours ago and a quantity from four seconds ago must not look identical.
9. **Silence is rendered.** Nothing happening is a state with a visual treatment. "Last write 3 minutes ago" and "no write in 6 hours" are different screens, not the same screen with different data.
10. **Under\-sell visibly.** When the system withholds stock — buffer, last\-units rule, paused channel — it says so, in units, where the merchant is looking. Invisible conservatism reads as a bug.
11. **One primary action per screen.** The operator is interrupted constantly and phone\-first. Every screen has exactly one thing it wants him to do, and it is reachable with a thumb.
12. **Alarm honestly.** Red means *act now*. A warning that appears every day trains the user to ignore the one that matters.

* * *

## 4\. Users and contexts of use

Design decisions follow from context more than from persona. This table drives the responsive strategy in §12.

| Persona | Device | Posture | Attention | Frequency |
| --- | --- | --- | --- | --- |
| Owner\-Operator | Phone (primary), laptop (weekly) | Walking, driving, in a supplier meeting | Fragmented, 10–60 s bursts | Many times a day, briefly |
| Counter Staff | Shared tablet or phone at the counter | Standing, customer waiting | Zero — the customer has it | Every transaction |
| Owner, weekly review | Laptop | Seated, deliberate | Full | Weekly, 20–40 min |

**Consequences.**

- The default target is a **phone held in one hand**, not a desk. The laptop layout is the enhancement, not the baseline. This reverses how the existing admin was built.
- The counter flow must work **while someone is watching and waiting**. No modal dialogs, no confirmation steps that can be misread, no state that requires reading a sentence.
- The weekly review is the only context with attention to spare. Density, tables and detail belong there — and nowhere else.

* * *

## 5\. Information architecture

### 5\.1 Current admin navigation — INHERITED

```
SELL     Dashboard · Products · Customers
FULFIL   Orders · Shipments* · Returns
STOCK    Inventory · Purchase orders* · Suppliers*
GROW     Messages · Campaigns* · Discounts* · Reports*
                                  (* greyed "soon", not links)
```

Showing unbuilt sections as disabled labels rather than dead links is a deliberate and good decision. **Keep it.** It communicates roadmap honestly and sets expectations without shipping broken navigation.

### 5\.2 Proposed navigation

Sync is not a section inside STOCK. It is the spine of the product, and it gets top billing.

```
  ▸ Sync            Health · Channels · Listings · Drift

  SELL              Dashboard · Products · Customers
  FULFIL            Orders · Shipments · Returns
  STOCK             Inventory · Locations · Stocktake ·
                    Purchase orders* · Suppliers*
  GROW              Messages · Campaigns* · Discounts* · Reports*
  ─────────────────────────────────────────────────────
  Counter                      (separate, full-screen mode)
```

**Four changes, each with a reason:**

| Change | Reason |
| --- | --- |
| **Sync** promoted above the existing groups | It is the product. Burying it inside STOCK would frame it as a settings page |
| **Locations** and **Stocktake** added to STOCK | New concepts from PRD C\-03 and C\-04 that need their own surfaces |
| **Shipments** un\-greyed | PRD N\-04 makes it real; orders currently jump confirmed → fulfilled with no tracking number |
| **Counter** is a separate mode, not a nav item | Different user, different device, different posture. Mixing it into admin navigation would put a "Products" link next to a customer\-facing till |

### 5\.3 Entry points

| Context | Lands on |
| --- | --- |
| Operator opens the admin on a phone | **Sync Health** — the answer to the question he actually has |
| Operator opens the admin on a laptop | **Dashboard** — the existing commercial view, unchanged |
| Staff opens the counter app | **Counter sale**, keyboard or scanner focused, nothing else on screen |
| Alert notification tapped | Directly to the specific channel, drift record or order that raised it |

**Rationale for the phone/laptop split:** on a phone he is checking. On a laptop he is working. Different questions deserve different landings.

* * *

## 6\. Screen inventory

New and substantially changed screens. Existing screens not listed here are unchanged in v1.

| \# | Screen | Primary action | Persona | Priority |
| --- | --- | --- | --- | --- |
| 9\.1 | Sync Health | Confirm everything is fine | Operator | P0 |
| 9\.2 | Channel detail | Diagnose one channel | Operator | P0 |
| 9\.3 | Listing map | Map a SKU to a channel listing | Operator | P0 |
| 9\.4 | Product create / edit | Publish a product | Operator | P0 |
| 9\.5 | Stock adjustment | Record a receipt or correction | Operator / Staff | P0 |
| 9\.6 | Stocktake | Post a count variance | Operator | P0 |
| 9\.7 | Locations | Set pool participation | Operator | P0 |
| 9\.8 | **Counter sale** | **Sell an item** | **Staff** | **P0** |
| 9\.9 | Availability lookup | Answer "do we have it?" | Staff | P0 |
| 9\.10 | Unified order queue | Clear today's orders | Operator / Staff | P0 |
| 9\.11 | Order detail, channel\-aware | Fulfil an order | Operator / Staff | P0 |
| 9\.12 | Drift and oversell register | Understand a failure | Operator | P0 |
| 9\.13 | Payout reconciliation | See true channel margin | Operator | P1 |

* * *

## 7\. Screen specifications

Each spec names the **doubt** it answers — the specific question in the merchant's head when he opens it. A screen that does not answer a doubt is a screen that should not exist.

### 7\.1 Sync Health

> **Doubt: "Is my stock right everywhere, right now?"**

The most important screen in the product. It is the first thing the operator sees on a phone, and it must answer the doubt in under five seconds without scrolling.

```
┌────────────────────────────────────┐
│  All channels in sync              │
│  Last check 14 seconds ago         │
├────────────────────────────────────┤
│  noon              ✓  18 s ago     │
│  1,204 listings · p95 48 s         │
├────────────────────────────────────┤
│  Amazon.ae         ✓  2 min ago    │
│  1,180 listings · p95 3 m 10 s     │
├────────────────────────────────────┤
│  voltix.ae         ✓  live         │
│  1,240 listings · instant          │
├────────────────────────────────────┤
│  Shop counter      ✓  live         │
│  Last sale 41 min ago              │
├────────────────────────────────────┤
│  Withheld by buffer      34 units  │
│  Held at last-unit rule   6 SKUs   │
├────────────────────────────────────┤
│  Oversells, 30 days            0   │
│  Drift corrected, today        2   │
└────────────────────────────────────┘
```

**The headline is a sentence, not a gauge.** "All channels in sync" or "noon is 12 minutes behind" — a phrase the operator can read while walking. Gauges, dials and percentage rings all require interpretation, and interpretation takes longer than reading.

**Content rules.**

- Every channel row carries a **relative timestamp of the last confirmed write**, not of the last attempt. "18 s ago" means a channel confirmed it applied our number 18 seconds ago.
- The **p95 latency** figure is measured, per channel, rolling 24 hours. This is the number the product's promise rests on (PRD G3, D4). It is shown, not claimed.
- The **withheld** block implements principle 10. Buffer and last\-units suppression are conservative choices the system made on the merchant's behalf; hiding them makes the system look broken when a listing shows fewer units than the warehouse holds. Tapping it lists the SKUs and the reason for each.
- **Oversells over 30 days** is the product's own report card. It stays on screen even at zero — especially at zero.

**States.**

| State | Treatment |
| --- | --- |
| Healthy | Neutral surface. No green wash — green everywhere makes red less legible when it matters |
| One channel behind | That row only takes a warning treatment; headline changes to name the channel |
| Channel paused (kill switch) | Explicit "Paused by you, 12 min ago · 8 changes queued", with resume as the primary action |
| Channel breaker open | "noon is not responding. 14 changes queued, nothing lost." Reassurance about queueing is the whole point of the sentence |
| Drift above threshold | Red. Headline states the count and links to §7.12 |
| First run, nothing connected | "No channels connected yet" plus a single "Connect noon" action |
| Loading | Skeleton rows preserving layout. **Not a spinner** — a spinner on the trust screen reads as "we don't know" |
| Data stale (this page could not refresh) | The whole page dims slightly with "Showing data from 4 minutes ago — reconnecting." Principle 8: never present stale data as live |

**Interaction.** Pull to refresh. Auto\-refresh every 30 s while the page is visible; paused when backgrounded. Tapping any channel row opens §7.2.

* * *

### 7\.2 Channel detail

> **Doubt: "What exactly is wrong with this one channel?"**

```
┌────────────────────────────────────┐
│  ‹ noon                     Pause  │
├────────────────────────────────────┤
│  Connected · FBP · 1 warehouse     │
│  Last confirmed write   18 s ago   │
├────────────────────────────────────┤
│  LATENCY, LAST 24 H                │
│  p50   22 s                        │
│  p95   48 s                        │
│  p99   71 s   → buffer basis       │
│  [ ▁▂▃▂▁▁▂▅▃▂▁▁ sparkline ]        │
├────────────────────────────────────┤
│  Writes today       412 ✓   0 ✗    │
│  Queue depth                  0    │
│  Drift corrected today        1    │
│  Awaiting retry               0    │
├────────────────────────────────────┤
│  RECENT ACTIVITY                   │
│  18 s   SKU-4471  12 → 11  ✓       │
│  4 m    SKU-2210   3 → 2   ✓       │
│  6 m    SKU-9982   0 → 4   ✓       │
│  ...                    View all   │
├────────────────────────────────────┤
│  Settings · Credentials · Logs     │
└────────────────────────────────────┘
```

**Why p99 is labelled "buffer basis".** It closes the loop on principle 7. The merchant can see that the buffer withholding units from noon is derived from this measured number, not from a guess. This single label removes most of the "why is my listing showing less than I have?" support burden.

**The activity feed is the trust instrument.** Watching real quantities change, in real time, with confirmation ticks, is the fastest way to believe a sync engine works. It is deliberately verbose in the first weeks.

**States.** Connected · Degraded (writes succeeding but slow) · Breaker open · Paused by operator · Credentials expired · Never connected. Each has distinct copy; none of them is a bare error code.

* * *

### 7\.3 Listing map

> **Doubt: "Is this product actually connected to that marketplace listing?"**

A SKU\-by\-channel matrix. This is the screen where a mapping mistake gets caught before it becomes an oversell.

```
┌──────────────────────────────────────────────────┐
│  Listings                    Search  ⌕  Filter ▾ │
├──────────────────────────────────────────────────┤
│  SKU        Product        Avail  noon   Amazon  │
├──────────────────────────────────────────────────┤
│  SKU-4471   iPhone 15 …     11     11 ✓   11 ✓   │
│  SKU-2210   Galaxy Buds      2      2 ✓    0 ⓘ   │
│  SKU-9982   Anker 65W        4      — ⊘    4 ✓   │
│  SKU-1130   Sony WH-1000      0      0 ✓    0 ✓   │
└──────────────────────────────────────────────────┘

  ✓ confirmed   ⓘ held back   ⊘ not listed   ⚠ drift
```

**Reading the row for SKU\-2210:** available 2, noon shows 2, Amazon shows 0 with a "held back" marker. Tapping the marker explains: *"Last\-unit rule — 2 units left, published to noon only (higher priority)."* The merchant sees a deliberate decision, not a bug.

**Four glyphs, and no more.** Confirmed, held back, not listed, drift. Every additional symbol costs legibility on a phone.

**Filters:** unmapped SKUs · drift only · held back only · never confirmed · by channel. **Unmapped is the default filter after any bulk product import**, because an unmapped SKU is silent and dangerous.

**Bulk mapping.** Suggested matches by GTIN/EAN and by seller SKU equality, presented as a review list where each row is accepted or rejected. Never auto\-applied. A wrong mapping publishes one product's stock to another product's listing — the worst single failure this product can produce.

* * *

### 7\.4 Product create and edit

> **Doubt: "Can I add a product without calling a developer?"**

The gap that made the existing admin unusable. Design priority is **completion, not elegance** — the form must be finishable on a phone between customers.

**Progressive structure, one column, in this order:**

1. **Identity** — name, brand, category, internal SKU
2. **Variants** — the repeating unit: variant name, barcode/GTIN, price, cost, opening stock, location
3. **Compliance** — ECAS reference, TDRA reference, HS code, expiry dates *(PRD L\-09, X\-02)*
4. **Content** — description, images, Arabic name and description
5. **Channels** — which channels to list on, per\-channel SKU, buffer override

**Design decisions.**

- **Compliance sits at position 3, above content.** For UAE electronics these fields gate customs clearance; burying them below the description guarantees they are skipped. Their prominence is a deliberate statement about what matters.
- **Save is always available and always partial.** A product can be saved incomplete and appears as "Draft — 3 fields needed", each field linked. Forcing completion in one sitting is how phone\-first users abandon forms.
- **Publishing is a separate, explicit action** from saving. Save is safe; publish has consequences.
- **Arabic fields sit beside their English counterparts**, not in a separate tab. A separate tab is a tab nobody opens, and Arabic product content is a legal obligation (PRD L\-05).

* * *

### 7\.5 Stock adjustment

> **Doubt: "Will this change go everywhere?"**

Small screen, high frequency, and the most direct demonstration of the product's value.

```
┌────────────────────────────────────┐
│  Adjust stock                      │
│  SKU-4471 · iPhone 15 128GB Black  │
├────────────────────────────────────┤
│  On hand now              11       │
│  Location      [ Warehouse    ▾ ]  │
├────────────────────────────────────┤
│      [ − ]      + 5      [ + ]     │
│                                    │
│  New on hand              16       │
├────────────────────────────────────┤
│  Reason        [ Goods receipt ▾ ] │
│  Note (optional)                   │
├────────────────────────────────────┤
│  Will publish to                   │
│    noon        11 → 14  (buffer 2) │
│    Amazon.ae   11 → 14  (buffer 2) │
│    voltix.ae   11 → 16             │
├────────────────────────────────────┤
│           [  Adjust stock  ]       │
└────────────────────────────────────┘
```

**The "will publish to" preview is the most valuable component in this document.** It shows the consequence of the action before the action is taken, per channel, with the buffer visible. It answers the doubt pre\-emptively, and it teaches the buffer concept without a help article.

**Reason code is mandatory** — it writes to the append\-only movement ledger and is what makes a stocktake variance investigable three weeks later. The dropdown is short and concrete: Goods receipt · Damage · Loss · Found · Return to supplier · Correction · Stocktake.

**After submitting**, the confirmation is specific: *"Stock updated. Publishing to 3 channels."* Then the row updates in place as each channel confirms — a small tick appearing per channel over the following seconds. That few\-second animation is the product proving itself, and it should not be optimised away.

* * *

### 7\.6 Stocktake

> **Doubt: "Does the system match the shelf?"**

A session\-based flow, because a count is interrupted and resumed.

1. **Open a session** — pick a location, optionally scope to a category or a filtered SKU list
2. **Count** — one SKU at a time, scan\-first, expected quantity **hidden by default** with a "reveal" affordance
3. **Review variances** — only rows that disagree, with variance quantity and value at cost
4. **Post** — writes adjustments with reason `STOCKTAKE`, marks affected SKUs dirty, syncs

**Hiding the expected quantity is a deliberate integrity choice.** A counter who can see the expected number will, under time pressure, confirm it. The reveal affordance exists because sometimes you genuinely need to check whether you are looking at the right shelf — but it is logged when used.

**Sessions survive interruption.** Progress is saved per SKU. A count started on Tuesday and finished Wednesday is normal, and the review screen shows when each line was counted.

* * *

### 7\.7 Locations

> **Doubt: "Which stock is actually sellable online?"**

A short screen with disproportionate consequences. Getting this wrong causes the worst failure in the PRD's risk register (R\-08): marketplace\-held stock leaking into the shared pool and guaranteeing an oversell.

```
┌────────────────────────────────────────────┐
│  Locations                                 │
├────────────────────────────────────────────┤
│  Warehouse — Dubai            WAREHOUSE    │
│  In shared pool               ● Yes        │
│  1,204 SKUs · 3,318 units                  │
├────────────────────────────────────────────┤
│  Shop floor — Deira           SHOP_FLOOR   │
│  In shared pool               ○ No         │
│  Display and demo stock, not sold online   │
├────────────────────────────────────────────┤
│  noon fulfilment centre       NOON_FC      │
│  In shared pool     ⊘ Locked — noon owns   │
│  this stock and counts it separately       │
├────────────────────────────────────────────┤
│  Amazon FBA                   AMAZON_FBA   │
│  In shared pool     ⊘ Locked — Amazon owns │
│  this stock and counts it separately       │
└────────────────────────────────────────────┘
```

**Marketplace\-held locations are locked in the interface, not merely defaulted off.** The toggle does not exist; a sentence explains why. A setting that can be flipped will eventually be flipped, and the cost of flipping this one is systematic overselling across every channel.

**Shop floor defaults to excluded**, with a per\-SKU override available from the product screen. Rationale is stated in the interface, not just in this document: display units and demo stock are not reliably sellable, and high\-value electronics do not tolerate the error.

* * *

### 7\.8 Counter sale — the critical flow

> **Doubt (staff): "Can I just sell this thing?"**

**Design budget: under 20 seconds, median, on a phone, one\-handed, with a customer watching.** Every element below is justified against that budget. If a feature cannot fit inside it, it does not ship in v1.

```
┌────────────────────────────────┐
│  ⌕  Scan or type               │  ← focused on open
├────────────────────────────────┤
│                                │
│   iPhone 15 128GB Black        │
│   SKU-4471                     │
│   AED 2,899 · 11 in stock      │
│                                │
│   [ − ]    1    [ + ]          │
│                                │
├────────────────────────────────┤
│   Cash    Card    Link         │
├────────────────────────────────┤
│                                │
│      [   Complete sale   ]     │
│                                │
└────────────────────────────────┘
```

**The 20\-second budget, allocated:**

| Step | Budget | How it is met |
| --- | --- | --- |
| Open the app | 2 s | Persistent session, no login per sale, input focused on load |
| Find the item | 6 s | Barcode scan is the primary path. Typed search matches SKU, name and barcode, results after 2 characters, top result selectable with Enter |
| Confirm quantity | 1 s | Defaults to 1. Most electronics sales are single\-unit |
| Payment method | 2 s | Three large targets. No sub\-menu |
| Complete | 2 s | One button, thumb\-reachable, no confirmation dialog |
| System response | 1 s | Immediate success state; channel sync happens after |
| **Total** | **14 s** | 6 seconds of headroom for reality |

**Things deliberately excluded from v1, each of which would break the budget:** customer capture (optional, post\-sale), discounts, multi\-line baskets, split payment, printed receipts. **Multi\-line is the most likely to be requested and the most dangerous to add** — it converts a single\-decision screen into a basket\-management screen. If it becomes necessary, it belongs in a separate mode reached deliberately, not as an expansion of this one.

**Serialised items.** For a SKU flagged as serialised, one extra step appears: scan the IMEI. This cannot be skipped — it is a legal traceability requirement and it honours the storefront's existing promise that the IMEI is recorded (PRD C\-05). Budget impact is 4 seconds, absorbed by the headroom.

**Success state.** Full\-screen, unambiguous, auto\-dismissing after 2 seconds into a fresh scan field:

```
        ✓  Sold

    iPhone 15 128GB Black
    AED 2,899 · Cash

    10 left · syncing to 3 channels
```

The "syncing to 3 channels" line is for the owner, who will look over a shoulder at some point in the first fortnight. It costs nothing and it is the entire product in four words.

**Out\-of\-stock handling.** If available stock is zero, the sale is **not blocked** — a physical item in a hand outranks a database row. It completes with a flagged negative adjustment and appears in the drift register for the operator to resolve. Blocking a real sale to protect a number is the wrong trade, and staff who are blocked once will stop using the tool entirely.

**Offline.** A persistent banner: *"Offline — 3 sales will sync when you reconnect."* Sales queue locally and post on reconnect. **The banner must state plainly that stock accuracy is best\-effort while offline** (PRD P\-04). Principle 8 forbids showing a stale number as though it were live, even at the counter.

* * *

### 7\.9 Availability lookup

> **Doubt (staff, customer waiting): "Do we have it, and where?"**

A search field and a result. Nothing else.

```
┌────────────────────────────────────┐
│  ⌕  airpods pro                    │
├────────────────────────────────────┤
│  AirPods Pro 2nd gen               │
│  SKU-3390                          │
│                                    │
│  Available                    7    │
│                                    │
│  Warehouse                    7    │
│  Shop floor                   1    │
│    (display, not sold online)      │
│  Reserved                     0    │
│                                    │
│  noon shows 5 · Amazon shows 5     │
│  2 held back by buffer             │
│                                    │
│  AED 899                           │
└────────────────────────────────────┘
```

**Available is the largest element on the screen** because it is the only thing the customer's question requires. Everything below it exists to pre\-empt the follow\-up — *"but it says 5 online"* — which staff currently cannot answer at all.

* * *

### 7\.10 Unified order queue

> **Doubt: "What do I need to ship today?"**

One list, all channels, sorted by urgency rather than by time.

```
┌──────────────────────────────────────────────┐
│  Orders            All ▾   Needs action ▾    │
├──────────────────────────────────────────────┤
│  ⬤ noon      N-4471821      2 items          │
│    Ship by 14:00 today          ⏱ 3 h left   │
├──────────────────────────────────────────────┤
│  ⬤ Amazon    405-113-9982    1 item          │
│    Ship by 18:00 today          ⏱ 7 h left   │
├──────────────────────────────────────────────┤
│  ⬤ voltix.ae  VX-10442       3 items         │
│    COD · Dubai Marina                        │
├──────────────────────────────────────────────┤
│  ⬤ Counter    C-0881         1 item          │
│    Collected · 41 min ago                    │
└──────────────────────────────────────────────┘
```

**Channel is a coloured dot plus a word, not an icon alone.** Marketplace logos are trademarked, inconsistent in dark mode, and unreadable at small sizes.

**Sorting is by marketplace SLA clock, not by order time.** A noon order with three hours left outranks an older Amazon order with seven — because the penalty for missing a marketplace ship\-by window is an account\-health metric, which the PRD identifies as the real risk. The list encodes that priority so the operator does not have to.

**The SLA clock turns red inside one hour.** It is the only red on the screen under normal conditions, which is what makes it work (principle 12).

* * *

### 7\.11 Order detail, channel\-aware

> **Doubt: "What is different about this order because of where it came from?"**

The existing order detail screen is good and stays. Three additions:

**A channel context block** at the top: channel, channel reference, fulfilment model, ship\-by deadline, and the channel's own status if it differs from ours.

**Graceful absence of buyer PII.** noon orders contain no customer address or email, because noon owns last\-mile delivery. The design must render this as a normal, explained state — *"noon handles delivery. No customer address is shared."* — not as missing data or an empty field. Every layout that assumes an address exists must be checked against this.

**Fee transparency**, per line and per order: referral fee, fulfilment fee, expected net. This is the foundation of the payout reconciliation in §7.13 and the first time the merchant can see what a marketplace order is actually worth.

* * *

### 7\.12 Drift and oversell register

> **Doubt: "It went wrong once. Will it go wrong again?"**

The register is not an error log. It is the evidence file for the argument that the system is reliable.

**Each drift record shows:** timestamp, channel, SKU, what we expected, what the channel had, the difference, how it was detected, what corrected it, and how long correction took. **Written as a sentence, not a table row:**

> *"14:22 — noon showed 3 units for SKU\-2210; we expected 2. Detected by hot\-SKU reconciliation. Corrected in 31 seconds. Cause: an order webhook arrived out of order."*

**Each oversell record additionally shows the money**\: estimated cost in AED — referral fee times price for noon, plus the account\-health impact for Amazon. Naming the cost is what turns a technical event into a business fact, and it is what makes the count on the health screen meaningful.

**Empty state, which will be the usual state:** *"No drift in 30 days. Last correction was 12 July."* Never "No data" — an empty error log is the single best piece of news the product can deliver, and it should read like it.

* * *

### 7\.13 Payout reconciliation — P1

> **Doubt: "Which channel actually makes me money?"**

Not in v1, but designed for now because it is the reason the merchant keeps using the product after the novelty of automation wears off, and because nothing in the competitive set does it.

Per payout period, per channel: gross sales, referral fees, fulfilment fees, return administration, cancellation fees, net received, and — the number nobody else shows — **margin after all channel costs, per SKU**. Unmatched statement lines are surfaced for investigation rather than silently absorbed.

* * *

## 8\. Cross\-cutting patterns

Five patterns used repeatedly. Specifying them once keeps the system coherent and gives the wireframing document a component vocabulary.

### 8\.1 The explainer

**Any number the system computed can be expanded to show its derivation.** Trigger is a subtle marker on the number itself; the disclosure is inline, not a modal.

```
  noon shows 9   ⓘ
  ─────────────────────────────
  On hand            12
  Reserved          − 1
  Buffer            − 2
  ─────────────────────────────
  Published           9

  Buffer: 2 units
  2.1 sales/min peak × 1.2 min p99 × 1.2 safety
```

This single pattern implements design goal D2 and principle 7. It appears on the health screen, the listing map, availability lookup, product detail and the stock adjustment preview.

### 8\.2 The freshness stamp

Every channel\-derived value carries an age. Four visual tiers:

| Age | Treatment |
| --- | --- |
| Under 1 min | "live" — normal weight |
| 1–15 min | Relative time, normal weight |
| 15–60 min | Relative time, muted, with a small clock glyph |
| Over 60 min | Relative time, warning treatment, and the value itself is muted |

**The value is muted, not just the timestamp.** Ageing the number rather than a label beside it is what stops a stale figure from being read as current.

### 8\.3 The degraded banner

One pattern for every partial\-failure condition, always naming three things: **what is wrong, what it means for the merchant, and what is happening about it.**

> *"noon is not responding. Your stock is still correct here — 14 changes are queued and will send automatically. Retrying in 2 minutes."*

Never a bare error. Never a code without a sentence. The middle clause — *what it means for you* — is the one most often omitted and the most important.

### 8\.4 Optimistic versus confirmed

Actions the user takes locally (a stock adjustment, a counter sale) are **optimistic**\: the interface updates immediately, because the local write is the source of truth and it has already committed.

Actions that depend on a channel (publishing a quantity) are **confirmed**\: shown as pending until the channel acknowledges, then ticked. **These two must be visually distinct**, or the merchant learns to distrust the fast one.

### 8\.5 Number formatting

| Type | Rule |
| --- | --- |
| Currency | `AED 2,899` — code before value, thousands separated, no decimals unless fils are non\-zero |
| Quantities | Bare integers, no unit suffix |
| Unknown | `—` never `0` (inherited principle 1) |
| Zero | `0` when genuinely zero, and it is not a warning colour by itself |
| Latency under 60 s | `48 s` |
| Latency over 60 s | `3 m 10 s` |
| Relative time | `18 s ago` · `4 min ago` · `2 h ago` · then absolute |
| Percentages | One decimal maximum |

* * *

## 9\. State coverage

**Every screen must specify all eight.** The audit found that no admin screen has a loading skeleton and that several rely on RSC streaming alone, which makes the admin appear frozen on a slow connection. That gap does not get repeated here.

| State | Requirement |
| --- | --- |
| **Loading** | Skeleton that preserves final layout. Spinners only for sub\-second actions |
| **Empty** | Says why it is empty and what to do. Never "No data" |
| **Partial** | Some channels loaded, others not — render what is known, mark the rest |
| **Error** | What failed, what it means, what to do, and whether anything was lost |
| **Offline** | Explicit banner; queued actions counted; accuracy caveat stated |
| **Degraded** | Working but slow or behind. Distinct from error — this is the state most often missed |
| **Stale** | Data older than its freshness threshold. Value muted, age stated |
| **Success** | Specific about what happened and what follows. "Saved" is insufficient |

* * *

## 10\. Responsive strategy

**Reversal from the current build:** the admin is designed phone\-first and enhanced upward, not desktop\-first and collapsed. The audit rated the admin unusable below 900px, against a primary persona who is phone\-first — that is a direct mismatch between the design and the user.

| Breakpoint | Layout |
| --- | --- |
| **\< 480px** | Single column. Bottom navigation. Tables become card lists. One primary action, thumb\-zone anchored |
| **480–900px** | Single column, denser. Tables become two\-line rows |
| **900–1280px** | Sidebar navigation returns. Tables become real tables |
| **\> 1280px** | Two\-column detail views. Side\-by\-side comparison on the listing map |

**Tables become card lists below 900px — they do not scroll horizontally.** A horizontally scrolling table on a phone hides exactly the column the user needs and gives no indication it exists.

**Counter mode is phone and tablet only.** No desktop layout is designed for it, because it is not used at a desk. If opened on a desktop it renders at phone width, centred.

* * *

## 11\. Design system

### 11\.1 What exists — INHERITED, and correct

CSS custom properties in `packages/ui/src/tokens.css`\: `--colour-*`, `--space-1..8`, `--text-xs..3xl`, `--radius-*`, `--font-*`. Light and dark via `prefers-color-scheme` plus `[data-theme]`. Logical properties throughout for RTL. Hand\-rolled CSS classes, no component library, no CSS\-in\-JS, no Tailwind. System font stack. Inline SVG icons.

**This is a good system and it is not being replaced.** Zero runtime cost, no dependency risk, disciplined tokens. The changes below are additive.

### 11\.2 New tokens

| Token group | Purpose |
| --- | --- |
| `--sync-ok` / `--sync-pending` / `--sync-stale` / `--sync-error` | Four sync states, semantically named. **Not reused from the existing status palette** — an order status and a sync status must not share a colour, or the two meanings blur |
| `--freshness-live` / `-recent` / `-ageing` / `-stale` | The four tiers in §8.2, applied to value text |
| `--surface-degraded` | Background for the degraded banner |
| `--counter-*` | Larger type and touch\-target scale for counter mode only |

### 11\.3 New components

| Component | Used by |
| --- | --- |
| `ChannelRow` | Health screen, listing map |
| `LatencyStat` | Channel detail, health screen |
| `Explainer` | Everywhere a computed number appears (§8.1) |
| `FreshnessStamp` | Every channel\-derived value (§8.2) |
| `DegradedBanner` | Global |
| `QuantityStepper` | Stock adjustment, counter sale |
| `ScanField` | Counter sale, stocktake, availability lookup |
| `PublishPreview` | Stock adjustment, product edit |
| `ActivityFeed` | Channel detail |
| `TableToCards` | Every table below 900px |
| `Skeleton` | Every async surface — closes the audit's loading gap |

### 11\.4 Fixes carried over from the audit

| Issue | Action | Priority |
| --- | --- | --- |
| Admin unusable below 900px | Resolved by §10 | High |
| No loading skeletons | `Skeleton` component, applied to every table | Medium |
| `focus-visible` styling unverified | Keyboard audit before any counter\-mode work — the counter is scanner\-and\-keyboard driven | **High** |
| Component styles in two 1,000\+ line `globals.css` files | Split per component as each is touched. Not a separate project | Medium |
| No component inventory | The new components above are documented as they are built | Low |

* * *

## 12\. Motion

**Motion has one job in this product: showing that something is propagating.** Everywhere else, none.

| Where | What |
| --- | --- |
| Channel confirmation tick | 200 ms fade\-and\-scale as each channel confirms. **The one moment of delight in the product** — it is the system proving itself |
| Activity feed insertion | 150 ms slide, new row at top |
| Counter success | 250 ms, full\-screen, then auto\-dismiss at 2 s |
| Skeleton shimmer | Subtle, 1.2 s loop |
| Everything else | No animation |

All motion respects `prefers-reduced-motion`, degrading to instant state changes with no loss of information.

* * *

## 13\. Accessibility

Target: **WCAG 2.2 AA**. Three areas need specific attention beyond the baseline.

**Keyboard and scanner.** Counter mode is driven by a barcode scanner, which is a keyboard. The entire sale flow must be completable without a pointer: scan, Enter, Enter. The audit flagged `focus-visible` styling as unverified — that must be resolved before counter work begins, not after.

**Colour is never the only signal.** Sync state uses a glyph plus a word plus colour. The four listing\-map glyphs are distinguishable in greyscale.

**Touch targets.** 44px minimum everywhere; 56px in counter mode, where the user is standing, hurried, and may be holding a product in the other hand.

**Screen reader.** Live regions announce sync state changes and counter\-sale completion. The `Explainer` disclosure is a proper disclosure widget, not a tooltip — tooltips are unreachable by touch and inconsistently announced.

* * *

## 14\. Arabic and RTL

**Interface strings are already translated and the layout already uses logical properties** — INHERITED, and it means RTL largely works today.

Three areas still need design work:

1. **Product content in Arabic is a legal obligation** (PRD L\-05), and product data is currently English\-only. Arabic name and description fields sit beside their English counterparts in the product form, not behind a tab.
2. **Numbers stay Western\-Arabic numerals** (`0-9`) and currency stays `AED` in both directions. Mixed\-direction number rendering is a common source of transposition errors in commerce interfaces.
3. **The layout sketches in this document are LTR.** Every one must be mirrored, and the mirroring checked — particularly the counter flow, where the scan field and the primary action anchor to opposite edges.

* * *

## 15\. UX copy

The existing copy discipline is a real asset. The audit specifically praised that cash\-on\-delivery confirmations never claim payment. Sync copy holds the same line.

| Rule | Instead of | Write |
| --- | --- | --- |
| Never claim more certainty than you have | "Synced" | "noon confirmed, 18 s ago" |
| Never hide conservatism | *(silence)* | "2 units held back by buffer" |
| Name what was lost, or say nothing was | "Sync failed" | "Could not reach noon. 14 changes queued, nothing lost" |
| Say what happens next | "Saved" | "Stock updated. Publishing to 3 channels" |
| Avoid the word real\-time entirely | "Real\-time sync" | "p95 48 seconds" |
| Empty states are news, not absence | "No data" | "No drift in 30 days" |
| Address the merchant, describe the system | "You have an error" | "noon is not responding" |

**"Real\-time" is banned from the product.** It is the word every competitor uses and none of them quantifies. Voltix shows the measured number instead — that is the positioning, and the copy has to carry it.

* * *

## 16\. Design QA checklist

Applied to every screen before it is considered done.

- [ ] All eight states in §9 specified and built
- [ ] Usable at 375px width, one\-handed
- [ ] Exactly one primary action, in the thumb zone
- [ ] Every computed number has an explainer
- [ ] Every channel\-derived value has a freshness stamp
- [ ] Nothing rendered as `0` where the truth is unknown
- [ ] Colour is never the sole carrier of meaning
- [ ] Completable by keyboard alone
- [ ] Mirrored and checked in RTL
- [ ] Copy passes §15
- [ ] `prefers-reduced-motion` respected
- [ ] Skeleton preserves final layout, no shift on load

* * *

## 17\. Open design questions

**Blocking**

| \# | Question | Owner | Needed by |
| --- | --- | --- | --- |
| DQ\-01 | Is the counter a shared device with a shared login, or per\-staff? Determines whether a sale is attributable, and whether a login sits inside the 20\-second budget | Owner | Before §7.8 |
| DQ\-02 | Which barcode scanner hardware? Determines whether `ScanField` targets a keyboard\-wedge device or a camera\-based scan, which are different components | Owner | Before §7.8 |
| DQ\-03 | Should a counter sale be blocked at zero stock, or allowed with a flag? This document proposes **allowed with a flag** — confirm | Owner | Before §7.8 |

**Non\-blocking**

| \# | Question | Owner |
| --- | --- | --- |
| DQ\-04 | Does the operator want a push notification per oversell, or a daily digest? Proposal: push for oversell, digest for drift | Product |
| DQ\-05 | Is the sync health screen the right phone landing, or should it be a persistent banner above the existing dashboard? | Product |
| DQ\-06 | How much activity\-feed history is useful — 24 hours, or 7 days? | Product |
| DQ\-07 | Should the listing map support inline buffer editing, or only from product detail? Inline is faster and riskier | Product |
| DQ\-08 | Arabic product content: manual entry in v1, or machine translation with human approval? Ties to the AI sequencing in PRD §13 | Owner |

* * *

*This document specifies behaviour and structure. The wireframing document that follows specifies layout, spacing and visual hierarchy, and should be checked against §16 before review.*
