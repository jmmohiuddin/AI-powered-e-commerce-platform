# Voltix Sync — Technical Requirements Document

**How to build a sync engine on top of a codebase that is unusually correct and operationally unfinished.**

|  |  |
| --- | --- |
| **Version** | 1\.0 |
| **Date** | 12 August 2026 |
| **Status** | Draft for engineering review |
| **Implements** | PRD v1.0 · PDD v1.0 |
| **Grounded in** | Voltix Commerce reverse\-engineering audit, §10 and §12 (9 Aug 2026) |

* * *

## How to read this document

This is the engineering contract. It specifies architecture, data model, interfaces, failure semantics, deployment topology, test strategy and rollout — at the level where a competent engineer can start on Monday without asking what was meant.

Three labels:

- **EXISTS** — already in the codebase, being reused unchanged.
- **CHANGE** — an existing component that must be modified.
- **NEW** — does not exist.

Decisions that could reasonably have gone the other way are marked **▸ Decision** with the rationale and the rejected alternative. Where a decision depends on an unanswered question, it points at §19.

* * *

## 1\. Summary of the engineering problem

The correctness core is genuinely good — integer money, RLS enforced by the database, a three\-axis order state machine, append\-only stock movements, an oversell race tested under 8\-way concurrency, 273 passing tests. **None of that needs rewriting.**

The operational layer is not there at all. There are no backups, no error tracking, no rate limiting, and — the one that matters most here — **no HTTP webhook route of any kind.** Every payment adapter implements `verifyWebhook`; nothing routes to it. The only HTTP endpoint in either app is `/api/cron/tick`.

A sync engine is, structurally, three things the current deployment cannot do:

1. **Receive** inbound events continuously from external systems (no webhook ingress exists).
2. **Dispatch** outbound writes within seconds, continuously (the current scheduler is a GitHub Action every 5 minutes plus a daily Vercel cron).
3. **Long\-poll** an AWS queue, because Amazon SP\-API delivers notifications only to SQS or EventBridge (no persistent process exists).

**So the largest technical decision in this document is not about the sync algorithm. It is that Voltix acquires a persistent worker process for the first time** (§4). Everything else follows from the existing architecture and copies the pattern the payments package already established.

* * *

## 2\. What we are building on

### 2\.1 Stack — EXISTS, and stays

TypeScript strict with `exactOptionalPropertyTypes`. Next.js 16 App Router with RSC and Server Actions. Postgres 17/18 on Neon with pgvector. Drizzle for schema definition, with hand\-written SQL via `tx.execute` for aggregates. Argon2id auth with TOTP MFA and opaque revocable sessions. Vitest for unit and integration. No state library, no CSS framework, no API layer — all three correct for this product.

Eleven packages: `core` (pure domain), `db` (schema \+ RLS client), `commerce` (largest), `payments` (port \+ 4 adapters \+ circuit breaker), `auth`, `notifications`, `ai`, `ui`, `config`, plus `apps/storefront` and `apps/admin`.

### 2\.2 The pattern being copied

`packages/payments` is the template for `packages/channels`\: a narrow port interface, one adapter per provider, injectable `fetch` for testing, retry with backoff, and a circuit breaker. It is the strongest design in the codebase and the reason PRD goal G4 — a new channel in under 10 engineering days — is credible.

### 2\.3 Debt that Voltix Sync must retire, not inherit

| Debt | Why sync forces it |
| --- | --- |
| **T\-01** No webhook route | Sync is webhook\-driven. Building ingress once serves payments, noon and every future channel |
| **T\-02** No backups | The stock ledger becomes the single source of truth for four channels. Losing it is unrecoverable |
| **T\-03** No error tracking | A silent adapter failure is the PDD's named failure mode (R\-07) |
| **T\-04** Unrotated shared credential | Adding a worker process multiplies credential surface |
| **T\-05** No rate limiting | Redis gets provisioned for outbound token buckets anyway; the middleware limiter comes free |
| **T\-07** Redis unused | Now used for rate\-limit buckets and dispatch locks. Debt retired by use |
| **T\-11** `audit_logs` has no writer | Every buffer override, kill\-switch toggle and manual stock adjustment must be attributable |

Debt deliberately **not** retired in this project: T\-06 (hand\-written SQL), T\-12 (globals.css), T\-14 (untested payment adapters). Each is real and none is on this critical path.

* * *

## 3\. Target architecture

```
┌── Vercel (existing) ──────────────────────────────────┐
│  apps/storefront   Next.js 16 RSC                      │
│  apps/admin        Next.js 16 RSC + Server Actions     │
│  /api/webhooks/[provider]   NEW — signature-verified   │
│  /api/cron/tick             EXISTS                     │
└──────────────────┬─────────────────────────────────────┘
                   │ writes
                   ▼
┌── Postgres (Neon) ────────────────────────────────────┐
│  stock ledger · reservations · orders   EXISTS         │
│  sync_outbox · sync_events · channel_listings   NEW    │
│  drift_records · oversell_events · sync_writes  NEW    │
└──────────────────┬─────────────────────────────────────┘
                   │ claims work (FOR UPDATE SKIP LOCKED)
                   ▼
┌── apps/worker  NEW — persistent container ────────────┐
│  dispatcher      outbound stock writes                 │
│  sqs-consumer    Amazon notifications (long poll)      │
│  reconciler      4 scheduled tiers                     │
│  sweeper         reservation expiry, stale detection   │
└──────────────────┬─────────────────────────────────────┘
                   │
      ┌────────────┼─────────────┬──────────────┐
      ▼            ▼             ▼              ▼
   Amazon        noon         Redis          Sentry
   SP-API      partner API   buckets +      errors +
   + SQS       + webhooks     locks         traces
```

### 3\.1 ▸ Decision: a persistent worker process

**Chosen:** a new `apps/worker` deployed as an always\-on container, separate from Vercel.

**Rationale.** Three hard requirements make serverless unworkable: Amazon SQS requires long\-polling, which a request\-scoped function cannot do economically; the PRD's p95 dispatch target of 5 seconds cannot be met by a 5\-minute cron; and dispatch needs in\-process state — token buckets, circuit\-breaker state, and per\-SKU ordering — that dies with each invocation.

**Rejected alternatives.** *Vercel cron at higher frequency:* the Hobby plan caps at daily, and even a paid minute\-level cron misses the latency target by two orders of magnitude. *Lambda triggered by SQS:* solves Amazon ingress but not outbound dispatch or coalescing, and scatters breaker state. *Keep everything in `/api/cron/tick`\:* this is what exists, and it is why nothing can sync.

**Host.** Any always\-on container platform — Fly.io, Railway, or a small ECS task. Selection is §19 Q\-T3. The worker is a plain Node process; nothing in the design is host\-specific.

**Concurrency model.** A single worker instance at launch, with all four loops running as independent async tasks in one process. Horizontal scaling is possible later because work claiming uses `FOR UPDATE SKIP LOCKED` and is therefore safe with N workers — but **one instance is the launch configuration**, because a single process makes ordering and rate limiting trivially correct and this business does not have the volume to need more (§14).

### 3\.2 ▸ Decision: region alignment

**Problem.** Postgres is on Neon in `ap-southeast-1` (Singapore) and Vercel serves from `sin1`. The customers, the shop and both marketplaces are in the UAE. Amazon SP\-API for the AE marketplace is served from the European endpoint group with EventBridge in `eu-west-1`.

Every outbound write therefore crosses Singapore → Ireland, and every storefront request crosses UAE → Singapore. That is roughly 120–180 ms of avoidable round\-trip on the database path alone, and it eats directly into a 5\-second p95 budget that must also absorb Amazon's own 1–5 minute propagation.

**Chosen:** move Postgres and the worker to a European or Middle\-Eastern region before Phase 2, and keep the Vercel apps close to the database.

**Also a compliance input, not just latency.** PDPL cross\-border transfer controls apply to UAE residents' personal data. Singapore is not an obvious adequacy story; an EU region is a better\-understood one. Neither is a blocker today, but a region move is far cheaper before the sync engine exists than after.

**Measurement before commitment:** record the actual p50/p95 round\-trip from worker to Postgres, and from worker to each channel endpoint, in Phase 0. Do not move on theory.

### 3\.3 ▸ Decision: queue technology

**Chosen:** a Postgres table (`sync_outbox`) claimed with `FOR UPDATE SKIP LOCKED` as the primary work queue. SQS only where Amazon mandates it. Redis for token buckets and dispatch locks.

**Rationale — and this is the load\-bearing correctness argument in the document.** The outbox row must be written **inside the same database transaction as the stock change**. If a counter sale commits and the enqueue happens afterwards through a separate system, there is a window in which stock has moved and no channel will ever be told. A Postgres\-backed outbox makes that window structurally impossible: either both commit or neither does.

Every alternative reintroduces the window. *SQS as primary:* enqueue after commit, or a two\-phase dance with its own failure modes. *Redis lists:* same problem, plus a durability story nobody wants for the system of record. *Debezium/logical replication:* correct, and vastly more operational surface than this business can carry.

The volume argument is also decisive. §14 sizes the steady state at a few thousand writes per day. A Postgres queue handles that with no measurable load, and Neon is already provisioned, backed up (after T\-02) and inside the RLS boundary.

**Where SQS is unavoidable:** Amazon SP\-API delivers notifications only to an SQS queue or an EventBridge bus. The `sqs-consumer` loop long\-polls that queue and writes each notification into `sync_events` — after which it is ordinary Postgres work.

* * *

## 4\. Data model

All new tables carry `tenant_id` and a forced RLS policy from creation. The existing `admin_bypass` pattern applies. Money stays `bigint` minor units; quantities are `integer`.

### 4\.1 Channels and listings

```sql
CREATE TABLE channels (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  code          text NOT NULL,       -- 'noon' | 'amazon_ae'
                                     -- | 'storefront' | 'counter'
  display_name  text NOT NULL,
  adapter       text NOT NULL,
  status        text NOT NULL,       -- active | paused | disabled
  priority      integer NOT NULL,    -- last-units rule ordering
  config        jsonb NOT NULL DEFAULT '{}',
  paused_at     timestamptz,
  paused_by     uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE channel_listings (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  channel_id            uuid NOT NULL REFERENCES channels(id),
  variant_id            uuid NOT NULL REFERENCES variants(id),
  channel_sku           text NOT NULL,
  channel_listing_id    text,        -- ASIN, noon offer code
  external_ids          jsonb NOT NULL DEFAULT '{}',
  fulfilment_model      text NOT NULL, -- FBP|FBPI|FBN|MFN|FBA|OWN
  channel_warehouse     text,
  status                text NOT NULL, -- mapped|live|suppressed
                                       -- |error|unmapped
  buffer_override       integer,
  last_pushed_qty       integer,
  last_pushed_at        timestamptz,
  last_confirmed_qty    integer,
  last_confirmed_at     timestamptz,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel_id, channel_sku)
);

CREATE INDEX ON channel_listings (tenant_id, variant_id);
CREATE INDEX ON channel_listings (tenant_id, channel_id, status);
CREATE INDEX ON channel_listings (tenant_id, last_confirmed_at)
  WHERE status = 'live';
```

**The internal `variant_id` is the sole identity.** A channel identifier is never a primary or foreign key elsewhere. One variant may hold several listings on the same channel — new versus open\-box is a real case for electronics.

The partial index on `last_confirmed_at` serves the stale\-listing sweep, which is the query that runs most often and must not scan the table.

### 4\.2 Locations — CHANGE

`stock_levels` already keys on `(variant, warehouse)`. Warehouses gain a type and a pool flag:

```sql
ALTER TABLE warehouses
  ADD COLUMN location_type text NOT NULL DEFAULT 'WAREHOUSE',
      -- WAREHOUSE | SHOP_FLOOR | NOON_FC | AMAZON_FBA
  ADD COLUMN in_shared_pool boolean NOT NULL DEFAULT true;

-- Marketplace-held stock can never enter the shared pool.
ALTER TABLE warehouses ADD CONSTRAINT marketplace_stock_excluded
  CHECK (
    location_type NOT IN ('NOON_FC','AMAZON_FBA')
    OR in_shared_pool = false
  );
```

**The constraint is the point.** PDD §7.7 locks this in the interface; the check constraint makes it impossible at the storage layer too. This is the highest\-severity failure in the PRD risk register (R\-08) and it deserves defence in depth, not a code path that must be remembered.

### 4\.3 The outbox

```sql
CREATE TABLE sync_outbox (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  variant_id      uuid NOT NULL,
  channel_id      uuid,            -- NULL = all channels
  reason          text NOT NULL,   -- order|adjustment|counter_sale
                                   -- |return|reconcile|manual
  enqueued_at     timestamptz NOT NULL DEFAULT now(),
  claim_key       text NOT NULL,   -- tenant:variant:channel
  claimed_at      timestamptz,
  claimed_by      text,
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  state           text NOT NULL DEFAULT 'pending'
                  -- pending | in_flight | done | dead
);

CREATE INDEX ON sync_outbox (state, next_attempt_at)
  WHERE state = 'pending';
CREATE INDEX ON sync_outbox (claim_key) WHERE state = 'in_flight';
```

**This is a dirty\-marker table, not a payload queue.** A row says "this variant on this channel needs re\-publishing"; it does not carry a quantity. The quantity is computed at dispatch time from the current ledger.

That choice makes coalescing free and stale writes impossible. Eight changes to one SKU inside a tick window collapse to one dispatch carrying the *latest* number, because the number is read when the write is made rather than when the event occurred. A payload queue would require reasoning about which of eight stale quantities to trust.

### 4\.4 Write log and confirmation

```sql
CREATE TABLE sync_writes (
  id                 bigserial PRIMARY KEY,
  tenant_id          uuid NOT NULL,
  channel_listing_id uuid NOT NULL REFERENCES channel_listings(id),
  qty_pushed         integer NOT NULL,
  qty_available      integer NOT NULL,
  buffer_applied     integer NOT NULL,
  suppressed_reason  text,       -- last_units | paused | unmapped
  dispatched_at      timestamptz NOT NULL,
  responded_at       timestamptz,
  confirmed_at       timestamptz,
  outcome            text,       -- ok|rejected|timeout|throttled
  channel_ref        text,       -- feed id, import_id, request id
  error_code         text
);

CREATE INDEX ON sync_writes (tenant_id, channel_listing_id,
                             dispatched_at DESC);
CREATE INDEX ON sync_writes (tenant_id, confirmed_at)
  WHERE confirmed_at IS NULL;
```

`dispatched_at → confirmed_at` is the latency measurement that PRD G3 and the whole positioning depend on. It is computed from this table, not estimated.

The partial index on unconfirmed writes drives both the confirmation sweep and the "silence is a failure state" alerting.

### 4\.5 Inbound event ledger

```sql
CREATE TABLE sync_events (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  source        text NOT NULL,      -- amazon_ae | noon
  event_id      text NOT NULL,      -- provider dedupe key
  event_type    text NOT NULL,
  source_ts     timestamptz,        -- provider's own timestamp
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  payload       jsonb NOT NULL,
  outcome       text,
  UNIQUE (tenant_id, source, event_id)
);

CREATE INDEX ON sync_events (tenant_id, processed_at)
  WHERE processed_at IS NULL;
```

`INSERT ... ON CONFLICT DO NOTHING` gives idempotency for free. `source_ts` gives ordering: an event older than the last applied timestamp for that entity is recorded and discarded, which is the standard defence against out\-of\-order webhook delivery.

**Retention:** payloads are pruned at 90 days, keeping the metadata row. Amazon's Data Protection Policy requires a 30\-day PII deletion rule, so any event whose payload contains buyer PII is redacted in place at 30 days by the sweeper.

### 4\.6 Drift and oversell

```sql
CREATE TABLE drift_records (
  id                 bigserial PRIMARY KEY,
  tenant_id          uuid NOT NULL,
  channel_listing_id uuid NOT NULL,
  expected_qty       integer NOT NULL,
  channel_qty        integer NOT NULL,
  detected_by        text NOT NULL,   -- confirmation|hot|full|manual
  detected_at        timestamptz NOT NULL DEFAULT now(),
  corrected_at       timestamptz,
  correction_write   bigint REFERENCES sync_writes(id),
  probable_cause     text
);

CREATE TABLE oversell_events (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  channel_id      uuid NOT NULL,
  variant_id      uuid NOT NULL,
  order_ref       text,
  qty_ordered     integer NOT NULL,
  qty_available   integer NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  estimated_cost  bigint,        -- AED minor units
  root_cause      text,
  resolved_at     timestamptz
);
```

`estimated_cost` is computed at insert from the channel's referral\-fee schedule — noon charges its cancellation fee at the referral\-fee percentage, so the cost of an oversell is knowable at the moment it happens. This is what makes the register a business artefact rather than an error log.

### 4\.7 Velocity and buffers

```sql
CREATE TABLE variant_velocity (
  tenant_id        uuid NOT NULL,
  variant_id       uuid NOT NULL,
  window_days      integer NOT NULL,
  units_sold       integer NOT NULL,
  peak_units_min   numeric(8,3) NOT NULL,
  computed_at      timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, variant_id, window_days)
);

CREATE TABLE channel_latency_stats (
  tenant_id   uuid NOT NULL,
  channel_id  uuid NOT NULL,
  window_h    integer NOT NULL,
  p50_ms      integer NOT NULL,
  p95_ms      integer NOT NULL,
  p99_ms      integer NOT NULL,
  sample_n    integer NOT NULL,
  computed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, channel_id, window_h)
);
```

Both are recomputed by a scheduled job. **`channel_latency_stats.p99_ms` is the direct input to the buffer formula**, which is what makes the PDD's "buffer basis" label in the channel\-detail screen literally true rather than decorative.

### 4\.8 Counter sales

**▸ Decision: a counter sale is an `order` with `channel = 'counter'`, not a new entity.**

It reuses gapless numbering, the three\-axis state machine, the transaction ledger, VAT computation and tax\-invoice generation — all of which already exist and are tested. A parallel `counter_sales` table would duplicate every one of them and immediately drift.

Additions: `orders.channel_id`, `orders.channel_ref`, `orders.channel_fees jsonb`, and `orders.customer_emirate` (PRD L\-03 — capture from day one, because it cannot be retrofitted).

Offline capture gets a client\-generated idempotency key, so a sale posted twice on reconnect creates one order.

### 4\.9 Stocktake

`stocktake_sessions` (location, scope, opened\_by, opened\_at, closed\_at, status) and `stocktake_lines` (session, variant, expected\_qty, counted\_qty, counted\_at, counted\_by, revealed boolean). `revealed` records whether the counter looked at the expected number before entering theirs — the PDD makes hiding it the default and logs the exception.

* * *

## 5\. The Channel Port

`packages/channels` — NEW, modelled directly on `packages/payments`.

```ts
export interface ChannelAdapter {
  readonly code: string;
  readonly capabilities: ChannelCapabilities;

  pushQuantity(
    items: QuantityWrite[],
    ctx: AdapterContext,
  ): Promise<WriteResult[]>;

  confirmQuantity(
    listings: ListingRef[],
    ctx: AdapterContext,
  ): Promise<QuantityReading[]>;

  fetchOrders(
    since: Date,
    ctx: AdapterContext,
  ): Promise<ChannelOrder[]>;

  normaliseEvent(
    raw: unknown,
    ctx: AdapterContext,
  ): Promise<NormalisedEvent | null>;

  acknowledgeOrder(
    ref: string,
    ctx: AdapterContext,
  ): Promise<void>;

  pushFulfilment(
    ref: string,
    tracking: Tracking,
    ctx: AdapterContext,
  ): Promise<void>;

  // P1
  fetchStatement?(period: Period, ctx: AdapterContext)
    : Promise<StatementLine[]>;
  pushPrice?(items: PriceWrite[], ctx: AdapterContext)
    : Promise<WriteResult[]>;
}

export interface ChannelCapabilities {
  writeMode: 'sync' | 'async';        // noon sync, Mirakl async
  maxBatchSize: number;
  rateLimit: { rate: number; burst: number };
  confirmsWrites: boolean;
  deliversOrderPII: boolean;          // noon: false
  supportsWebhooks: boolean;
  ordersArePreAccepted: boolean;
}
```

**`AdapterContext` carries an injected `fetch`**, the credential accessor, a logger and a clock. Injected `fetch` is how the payments adapters are tested today and it is why contract tests against recorded fixtures are possible without a network.

**Capabilities are declarative, and the core reads them.** The dispatcher does not contain `if (channel === 'noon')`. It reads `writeMode`, `maxBatchSize` and `rateLimit`, which is what makes a new adapter a self\-contained unit of work and makes the 10\-day target real.

`deliversOrderPII: false` for noon is load\-bearing: the order projection must not treat a missing shipping address as a validation failure, and the PDD renders it as an explained normal state.

* * *

## 6\. Availability computation

A pure function in `packages/core`, with no I/O, unit\-tested exhaustively. It is the single place the published number is decided.

```ts
export function publishedQuantity(input: {
  onHandByLocation: Array<{
    locationId: string;
    inSharedPool: boolean;
    qty: number;
  }>;
  activeReservations: number;
  buffer: number;
  lastUnitsThreshold: number;
  channelPriority: number;
  isHighestPriorityChannel: boolean;
}): { qty: number; suppressedReason?: SuppressionReason } {

  const pool = input.onHandByLocation
    .filter(l => l.inSharedPool)
    .reduce((s, l) => s + l.qty, 0);

  const available = pool - input.activeReservations;

  if (available <= input.lastUnitsThreshold
      && !input.isHighestPriorityChannel) {
    return { qty: 0, suppressedReason: 'last_units' };
  }

  return { qty: Math.max(0, available - input.buffer) };
}
```

### 6\.1 Buffer

```
buffer = clamp(
  ceil(peak_units_per_min × (p99_latency_ms / 60000) × safety),
  0,
  max_buffer_for_sku
)
```

`peak_units_per_min` from `variant_velocity`. `p99_latency_ms` from `channel_latency_stats`. `safety` defaults to **1\.5** until 30 days of real latency data exist, then is reviewed (PRD Q\-13).

A per\-listing `buffer_override` wins when set, and setting one writes to `audit_logs`.

**Why not a global constant:** a static buffer over\-protects slow movers, stranding stock, while still under\-protecting fast ones. It is the most common failure in this category and it is a one\-line temptation.

### 6\.2 Concurrency

Three layers, each doing a different job — EXISTS for the first, which is why this is cheap:

1. **Conditional decrement** is what actually prevents overselling in our own systems. `UPDATE stock_levels SET qty = qty - :n WHERE variant_id = :v AND location_id = :l AND qty >= :n` — atomic, cannot go negative, single statement. Already implemented and already tested under 8\-way concurrency.
2. **Optimistic versioning** on `channel_listings` for the write path: a dispatch carrying a stale view loses and re\-reads.
3. **Per\-SKU\-per\-channel dispatch serialisation** via the `claim_key` on the outbox plus a Redis lock. Different SKUs run in parallel; the same SKU never has two writes in flight to one channel. This is the fix for the classic "stale quantity clobbers fresh quantity" race.

**The counter\-sale exception.** PDD §7.8 allows a sale to complete at zero stock, because a physical item in a customer's hand outranks a database row. The conditional decrement therefore has an explicit override path that records a negative adjustment with reason `COUNTER_OVERRIDE` and raises a drift record. It is the one place the system knowingly writes an inconsistent state, and it is logged as such.

* * *

## 7\. Outbound pipeline

```
stock change (any source)
   └─ same transaction ─▶ INSERT INTO sync_outbox
                              │
                    dispatcher tick (1 s)
                              │
   claim: UPDATE ... WHERE state='pending'
          AND next_attempt_at <= now()
          ORDER BY enqueued_at
          FOR UPDATE SKIP LOCKED LIMIT :n
                              │
   coalesce: group by (variant, channel), keep one
                              │
   compute: publishedQuantity() from current ledger
                              │
   gate: channel active? breaker closed? token available?
                              │
   dispatch: adapter.pushQuantity(batch)
                              │
   record: INSERT sync_writes (dispatched_at)
                              │
   confirm: inbound notification, or confirmQuantity poll
            └─ UPDATE sync_writes SET confirmed_at
```

**Tick interval is per channel**, derived from capabilities: 1 second for noon and Amazon, 60 seconds for any Mirakl\-class async channel whose ceiling is one call per minute. The dispatcher reads the interval; it is not hard\-coded per channel name.

**Rate limiting is proactive.** A client\-side token bucket in Redis matches each operation's documented limits — Amazon `patchListingsItem` at 5 req/s burst 5, noon stock at 1,500 per 60 s. **A 429 is treated as a bug in our limiter**, alerted, and retried with exponential backoff plus full jitter. Discovering limits by receiving 429s is not a strategy.

**Error classification, and this list is normative.** Retry: 429, 500, 502, 503, 504, network timeout. Do not retry: 400, 403, 404, 413, 415 — these are defects, and they surface on the listing as `status = 'error'` with the message. Retrying a 400 forever is how dead\-letter queues fill with garbage.

**Circuit breaker per `(channel, operation)`.** Opens after N consecutive failures or an error rate over a rolling window; half\-open admits one probe; on close, the outbox is flushed with coalescing so only the latest quantity per SKU is sent. **While open, deltas queue — they are never dropped.** Channels are isolated: an Amazon outage must not stall noon.

**Dead letters.** `state = 'dead'` after max attempts. **Depth above zero raises an alert**, and a documented one\-click redrive resets rows to `pending`. A dead\-letter queue without an alert and a runbook is a silent data\-loss mechanism; that is the single most common production failure in integration systems.

**Batch semantics.** Where a channel accepts batches, a `DONE` response does not mean every item succeeded. Amazon feed results and any per\-record error report must be parsed item by item, with failures re\-queued individually. This trips up most first\-time Amazon integrations and it is called out here so it is not discovered in production.

* * *

## 8\. Inbound pipeline

### 8\.1 Ingress — NEW, retires T\-01

`/api/webhooks/[provider]` in `apps/admin`. Responsibilities, in order, and nothing else:

1. Verify the signature (HMAC, per provider).
2. `INSERT ... ON CONFLICT DO NOTHING` into `sync_events`.
3. Return **200 immediately.**

**No business logic in the request path.** Shopify's 5\-second handler timeout is the reference constraint even though Shopify is not a channel here; the same discipline applies to every provider. The worker picks the row up within a second.

The same route serves payment webhooks, which retires T\-01 and unblocks card and BNPL payments — currently unable to reach a terminal state at all.

### 8\.2 Amazon notifications

Amazon delivers only to SQS or EventBridge. The `sqs-consumer` loop long\-polls, inserts into `sync_events`, and deletes on successful insert. Subscriptions needed at launch:

| Notification | Transport | Purpose |
| --- | --- | --- |
| `ORDER_CHANGE` | SQS | Primary order intake |
| `LISTINGS_ITEM_MFN_QUANTITY_CHANGE` | EventBridge | Closed\-loop write confirmation |
| `LISTINGS_ITEM_ISSUES_CHANGE` | EventBridge | Listing suppression, compliance blocks |
| `FBA_INVENTORY_AVAILABILITY_CHANGES` | SQS | Only if FBA is used |

`filterExpression` with CEL narrows delivery server\-side, which keeps volume and noise down.

**Polling `searchOrders` is not a viable primary path** at 0.0056 requests per second — roughly one call every three minutes. It is the cold\-start and gap\-recovery path only.

### 8\.3 Processing

```
claim unprocessed sync_events (SKIP LOCKED)
   └─ adapter.normaliseEvent()
        └─ discard if source_ts < last_applied_at for entity
             └─ treat as signal, not data:
                fetch authoritative state from the channel
                  └─ project into orders / stock / listing status
                       └─ enqueue affected variants to outbox
```

**The webhook is a cache\-invalidation signal, not a payload of record.** For anything where correctness matters — order totals, quantities — we read authoritative state after being told something changed. That costs an extra API call and removes an entire class of ordering bug.

**Cold start and gap recovery** use `fetchOrders(since)` with a configurable lookback, deduplicating on `(channel, channel_ref)`. Run on first connection, after any outage, and nightly as a backstop.

* * *

## 9\. Reconciliation

Four tiers, as separate scheduled loops in the worker.

| Tier | Cadence | Mechanism | Catches |
| --- | --- | --- | --- |
| Confirmation sweep | 30 s | `sync_writes` where `confirmed_at IS NULL` past SLA | Silently rejected writes |
| Hot SKUs | 10 min | `confirmQuantity` for top movers and low stock | Expensive drift, fast |
| Full catalogue | 8 h | Amazon `GET_MERCHANT_LISTINGS_ALL_DATA`; noon reports | Long\-tail drift |
| Financial | Daily | Order counts and line totals per channel | Missed orders |

**Cadence is bounded by report freshness, not by ambition.** Amazon's stock\-data report SLA is 3 hours, and repeat calls return data 1–6 hours old. Reconciling the full catalogue more often than roughly 6 hours compares today's truth against stale data and generates false drift alarms. The 8\-hour choice sits deliberately outside that window.

**Hot\-SKU selection:** any variant in the top 20% by 7\-day velocity, plus anything with available stock at or below the last\-units threshold, plus anything with drift in the last 24 hours.

**Auto\-heal with a ceiling.** Drift below a per\-channel threshold is corrected automatically and counted. Drift above it **pages a human instead of silently re\-writing** — because large drift usually means a mapping error, and auto\-correcting a mapping error publishes one product's stock onto another product's listing at machine speed.

* * *

## 10\. Adapter specifications

### 10\.1 Amazon.ae

| Item | Value |
| --- | --- |
| Marketplace ID | `A2VIGQ35RCS4UG` |
| Endpoint | `https://sellingpartnerapi-eu.amazon.com` |
| AWS region | `eu-west-1` (EventBridge bus placement) |
| Auth | LWA bearer tokens; buyer PII requires a Restricted Data Token |
| Developer registration | **Private** — sole use for our own organisation |

**Quantity write:** `patchListingsItem`, `merge` operation on the top\-level `fulfillment_availability` attribute. 5 req/s, burst 5. Only top\-level attributes are patchable.

**Bulk resync:** `JSON_LISTINGS_FEED`, 25,000 items per feed, 5 submissions per 5 minutes per region. Used for the full\-catalogue tier only. **Mixing feeds and patches is safe** — Amazon sequences submissions by submission timestamp, so a slow feed cannot clobber a fresh patch.

**Propagation:** `getListingsItem` reflects a change in 1–5 minutes; notifications carry a 0–15 minute delay. **Buffer sizing must assume worst case \~15 minutes to buyer\-visible propagation** until measured otherwise.

**Orders:** `ORDER_CHANGE` primary; Orders API v2026\-01\-01 `getOrder` for detail; `searchOrders` for recovery only.

**▸ Decision: register as a private developer.** The 2025 SP\-API fee scheme exempted sellers using the API solely for their own operations, and it was cancelled in May 2026 with the wording "at this time." Private registration is both the lighter approval path — no Appstore listing, no Solution Provider Agreement — and the lower\-risk posture if fees return.

**The long pole.** If Amazon.ae orders are self\-shipped, buyer addresses require a PII\-bearing role, which triggers the enhanced data\-security assessment: 30\-day vulnerability scans, an annual penetration test, encryption in transit and at rest, a 30\-day PII deletion rule, 90\-day log retention, and a 24\-hour incident\-response plan — **as evidence, not intentions.** Amazon closes cases when information requests go unanswered for five days. **Start in week 1.** Choosing FBA for Amazon fulfilment removes this requirement entirely, which makes PRD Q\-03 a technical decision as much as a commercial one.

### 10\.2 noon.com

| Item | Value |
| --- | --- |
| Docs | `noon-docs.noonpartners.dev` |
| Gateway | `noon-api-gateway.noon.partners` |
| Credentials | Service account JSON from the Access App |
| Auth | Sign a JWT with RS256 → `POST /identity/public/v1/api/login` → auth cookie |
| Required header | `User-Agent` identifying our application — **requests without it may be rejected** |

**Stock:** `POST /v1/stock-update` and `POST /v1/stock-list`, both 1,500 requests per 60 seconds, keyed on the `(warehouse code, partner_sku)` pair. Multi\-warehouse is first class. Rate is roughly five times Amazon's, so **noon is never the bottleneck.**

**Confirmation:** no equivalent of Amazon's quantity\-change notification is documented, so confirmation is a `stock-list` read\-back on a short delay. That read\-back doubles as the latency measurement for the buffer engine.

**Orders:** appear to live inside the ten FBPI endpoints. **Endpoint paths, order state machine, event\-type enumeration, webhook retry policy and signature scheme are all unverified** (PRD Q\-02). The adapter is written against an interface; the noon\-specific detail is filled in after a solution\-architect conversation. **Do not schedule the noon order workstream until Q\-02 is answered.**

**Two constraints that shape the model:** all of a SKU's stock must sit in one fulfilment framework — FBP and FBPI cannot be split — and **noon order payloads contain no customer address or email**, because noon owns last\-mile delivery.

### 10\.3 Storefront and counter

Both are internal adapters with `writeMode: 'sync'` and no network. They exist so the dispatcher has no special cases: the storefront "write" is a no\-op because the ledger *is* the storefront's truth, and the counter adapter exists to record confirmations for the health screen.

### 10\.4 The fake adapter

A first\-class deliverable, not test scaffolding. Configurable latency distribution, failure injection by error class, reordered and duplicated confirmations, and partial batch failures. Every core behaviour in §7 and §8 is tested against it, which means the pipeline is verified without touching a marketplace.

* * *

## 11\. Security

| Area | Requirement |
| --- | --- |
| Channel credentials | Encrypted at rest with AES\-256\-GCM using the existing key\-management approach from TOTP secrets. Never in `.env`. Rotatable without redeploy |
| Worker identity | Its own database role with its own credential — not the app role, and not the Neon owner. Retires T\-04 for the new surface |
| RLS | Every new table has a forced policy at creation. A test asserts another tenant reads nothing, following the existing adversarial RLS suite |
| Webhook verification | Signature checked before any parsing. Unsigned or invalid requests return 401 and are counted |
| PII minimisation | noon carries none. For Amazon, buyer PII is fetched via RDT, stored only where fulfilment requires it, and **deleted at 30 days** by the sweeper — a hard Amazon DPP requirement |
| Logging | Structured, with PII redaction at the logger, not at the call site. 90\-day retention with tested alerting, per Amazon's baseline controls |
| Audit | Every buffer override, kill\-switch toggle, credential change, mapping change and manual adjustment writes to `audit_logs`. **Retires T\-11**, which today has no writer at all |
| Rate limiting | Redis\-backed middleware on public routes. Retires T\-05 and T\-07 together |
| Secrets scanning | `gitleaks` already runs in CI. Extend the ruleset to channel credential shapes |

* * *

## 12\. Observability

**SLOs** — these are the numbers alerting is built against:

| SLO | Target |
| --- | --- |
| Outbox dispatch latency (enqueue → dispatch) | p95 \< 5 s |
| Write confirmation, noon | p95 \< 2 min |
| Write confirmation, Amazon | p95 \< 5 min |
| Write success rate | \> 99.5% per channel per day |
| Drift rate | \< 0.5% of live listings per reconciliation |
| Oversell events | \< 2 per 1,000 orders |
| Worker uptime | \> 99.5% |

**Metrics** are emitted per channel: dispatch latency, confirmation latency, write outcomes by class, queue depth, dead\-letter depth, breaker state, drift detected and corrected, tokens consumed against limit, reconciliation duration and divergence count.

**Traces** span the full path — event received → normalised → projected → outbox → dispatched → confirmed — with the variant and channel as attributes. Sentry is already in the config schema and unused; wiring it retires T\-03.

**Alerts, and each maps to a runbook in §16:** dead\-letter depth above zero · breaker open beyond 5 minutes · no successful write to a channel in 30 minutes · unconfirmed writes past SLA · drift above threshold · any oversell event · worker heartbeat missed.

**Alerting on absence is the design requirement here.** The dangerous failure in an integration system is not an error — it is nothing happening. Every "no activity" condition above is a first\-class alert, not a derived one.

* * *

## 13\. Testing

Extends the existing Vitest setup. The current suite is a genuine asset: \~180 unit tests, \~60 integration tests against real Postgres including RLS and an 8\-way concurrency oversell race, and CI that fails on skipped tests — a guard that has already caught a real regression.

| Layer | What is added |
| --- | --- |
| Unit | `publishedQuantity` exhaustively, including the pool\-exclusion and last\-units branches. Buffer formula. Error classification. Backoff with jitter |
| Integration | Outbox enqueued inside the stock transaction. Coalescing. `SKIP LOCKED` claiming under concurrency. Confirmation sweep. Drift detection and auto\-heal |
| Contract | Each adapter against recorded fixtures via injected `fetch` — the pattern the payment adapters already use |
| Chaos | Against the fake adapter: duplicate events, reordered events, dropped confirmations, partial batch failures, channel timeouts, breaker open/close cycles |
| Concurrency | Extend the existing oversell race to a four\-channel scenario: simultaneous marketplace order, website checkout, counter sale and stock adjustment on one SKU with 1 unit available. **Exactly one must win** |
| Load | 5,000 outbox rows drained within the dispatch SLO with rate limits respected |
| E2E | **First E2E tests in the codebase** — the three money paths plus the counter sale. Closes a documented\-but\-nonexistent gap |

**The four\-channel race is the acceptance test for the whole project.** If it passes consistently, the product works.

* * *

## 14\. Capacity

Sizing from the audit's figures: roughly 1,240 listings, one warehouse, one shop.

| Quantity | Estimate |
| --- | --- |
| Listings under management | \~1,240 × 2 marketplaces ≈ 2,500 |
| Stock changes per day (steady state) | 200–600 |
| Outbound writes per day after coalescing | 400–1,200 |
| Peak writes per minute | \~40 during a receipt or stocktake post |
| Amazon budget at 5 req/s | 432,000/day — **two orders of magnitude of headroom** |
| noon budget at 1,500/60 s | 2\.1m/day — irrelevant as a constraint |
| Full\-catalogue reconciliation | 2,500 reads per run, 3 runs/day |
| `sync_events` growth | \~2,000 rows/day, pruned at 90 days |

**Nothing here is near a limit**, which is why a single worker and a Postgres queue are the right answer and why any argument for more infrastructure needs to clear a high bar.

**The real constraint is connections, not throughput.** The audit already flags no PgBouncer and no connection budget for serverless (T\-10). Adding a worker adds a second connection consumer. Cap the worker pool explicitly, document the arithmetic, and revisit if a second worker instance is ever added.

* * *

## 15\. Rollout

Shipping a sync engine straight into production is how you learn about coalescing bugs by cancelling real marketplace orders. Four stages, each with an exit condition.

**Stage 1 — Shadow, 1 week.** The full pipeline runs, computes every published quantity, and writes `sync_writes` rows with `outcome = 'shadow'`. **No channel write is dispatched.** Compare what we would have published against what each channel actually holds. *Exit:* the shadow diff is stable and explainable for 3 consecutive days.

**Stage 2 — Canary, 1 week.** Ten deliberately chosen SKUs: slow movers, deep stock, low value. Writes are real. *Exit:* zero unexplained drift for 5 days, and measured latency within SLO.

**Stage 3 — Read\-confirm on the full catalogue, 3 days.** Every listing is reconciled and drift is recorded, but only canary SKUs are written. This finds mapping errors at scale without acting on them. *Exit:* fewer than 1% of listings show unexplained divergence.

**Stage 4 — Full.** All SKUs, all channels, kill switch armed and tested. *Exit:* PRD's 14 consecutive days at zero oversells.

**Feature flags** per channel and per stage, changeable without deploy. **The kill switch is tested in stage 2, not first used in an incident.**

* * *

## 16\. Failure modes and runbooks

| Failure | Detection | Immediate action | Recovery |
| --- | --- | --- | --- |
| Channel API down | Breaker opens | None — queueing is automatic | Breaker probes; flush is coalesced |
| Credentials expired | 403 cluster | Alert; channel auto\-pauses | Rotate; resume; full reconcile |
| Worker dies | Heartbeat missed | Host restarts | In\-flight claims expire and are re\-claimed after the lease timeout |
| Postgres unavailable | Connection failures | Worker backs off; apps degrade | Nothing lost — the outbox is in the database that is down |
| Dead letters accumulating | Depth \> 0 | Inspect `last_error` | Fix, then redrive |
| Drift above threshold | Reconciler | **Page. Do not auto\-correct** | Usually a mapping error; verify before writing |
| Oversell occurred | Order accepted below available | Alert; register with cost | Cancel or source; review the buffer |
| Mapping error published | Drift, or a customer complaint | **Kill switch on that channel** | Correct mapping, full reconcile, then resume |
| Duplicate order ingested | Unique violation on `(channel, ref)` | None — idempotency held | Investigate the source |
| Clock skew | Ordering anomalies | Alert | NTP; ordering is by source timestamp with a tolerance window |

**The mapping\-error row is the one to rehearse.** It is the only failure where the correct first action is to stop the system rather than let it heal, because a wrong mapping propagates one product's stock onto another product's listing at machine speed.

* * *

## 17\. Package structure

```
packages/
  channels/            NEW
    src/
      port.ts              ChannelAdapter interface
      registry.ts          code → adapter
      dispatcher.ts        claim, coalesce, gate, dispatch
      confirmation.ts      closed-loop sweep
      reconciler.ts        four tiers
      buffer.ts            buffer formula
      rate-limiter.ts      Redis token bucket
      breaker.ts           reuses payments' breaker
      adapters/
        amazon/  noon/  storefront/  counter/  fake/
  core/                CHANGE  publishedQuantity, suppression
  db/                  CHANGE  new tables, RLS, migrations
  commerce/            CHANGE  enqueue outbox in stock txn
  config/              CHANGE  worker + channel env schema

apps/
  worker/              NEW  dispatcher · sqs-consumer
                            · reconciler · sweeper
  admin/               CHANGE  /api/webhooks/[provider],
                            sync screens, counter mode
  storefront/          unchanged in v1
```

**`publishedQuantity` lives in `core`, not in `channels`** — it is pure domain logic, it must be callable from the storefront and the admin without importing an adapter registry, and `core` is the package with the strongest test discipline.

* * *

## 18\. Build sequence

Aligned to the PRD phases. Durations assume a small team and are estimates; the gates are not.

| Phase | Weeks | Engineering content |
| --- | --- | --- |
| **0 — Safe** | 1–2 | Backups \+ restore drill · Sentry · credential rotation · SMTP · `/healthz` · rate limiting. **In parallel from week 1:** Amazon developer registration and DPP evidence, noon credentials, region\-latency measurement |
| **1 — Manageable** | 3–4 | Product CRUD · stock adjustment · stocktake · location typing and the check constraint · serial/IMEI capture |
| **2 — Sync** | 5–7 | `packages/channels` · `apps/worker` · webhook ingress · outbox · dispatcher · confirmation · reconciler · **noon adapter first**, Amazon second · sync screens · shadow → canary → full |
| **3 — Counter** | 2–3 | Counter mode · offline queue · availability lookup · counter\-sale override path |
| **4 — Money** | 4–6 | Statement ingestion · fee reconciliation · shipments · purchase orders · bundles |

**noon before Amazon.** Higher rate limits, no buyer PII to handle, no restricted\-role approval blocking the start, and it is the larger UAE channel for this merchant. Amazon's approval clock runs in the background while noon is built.

* * *

## 19\. Open technical questions

**Blocking**

| \# | Question | Blocks |
| --- | --- | --- |
| **Q\-T1** | noon order API shape — endpoints, state machine, event types, webhook retry policy, signature scheme (PRD Q\-02) | noon order workstream, Phase 2 |
| **Q\-T2** | Measured noon stock propagation latency, via `stock-update` → `stock-list` round trips (PRD Q\-01) | Buffer engine calibration |
| **Q\-T3** | Worker host — Fly.io, Railway, or ECS | Phase 2 start |
| **Q\-T4** | Region move for Postgres and worker, and when | Phase 2 planning |
| **Q\-T5** | FBA or MFN for Amazon (PRD Q\-03) — decides whether the restricted\-role assessment is needed at all | Week 1, because approval is the long pole |

**Non\-blocking**

| \# | Question |
| --- | --- |
| Q\-T6 | Does noon's stock endpoint accept a batch array, and what is the cap? Affects `maxBatchSize` only |
| Q\-T7 | Redis provider — Upstash, or the existing provisioned instance |
| Q\-T8 | Keep Drizzle\-typed queries for new tables, or continue hand\-written SQL? Recommendation: **typed for all new tables**, since T\-06 exists precisely because that was not done |
| Q\-T9 | `sync_events` payload retention — 90 days proposed, with PII redaction at 30 |
| Q\-T10 | Should the worker expose a small internal HTTP surface for the admin to read live queue state, or should the admin read Postgres directly? Postgres is simpler and probably right |

* * *

*Where this document and the PRD disagree on scope, the PRD governs. Where it and the audit disagree on what currently exists, the audit governs. Everything marked ▸ Decision is open to challenge before Phase 2 begins and settled after it.*
