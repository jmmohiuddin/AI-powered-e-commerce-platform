# `@voltix/noon` — noon Marketplace integration

Keeps a noon seller account in step with Voltix: stock and prices are pushed out,
orders are pulled in, and the two channels share one inventory pool.

Voltix is the system of record. noon is a projection of it.

---

## What is verified, and what is not

Every endpoint below was taken from noon's published API reference, not inferred.

| Concern | Endpoint | Status |
|---|---|---|
| Login | `POST /identity/public/v1/api/login` | Verified against noon's own code sample |
| Stock write | `POST /stock/v1/stock-update` | Verified (Stock quickstart) |
| Stock read | `POST /stock/v1/stock-list` | Path from the API reference |
| Price write | `POST /pricing/v1/pricing/upsert` | Verified (Pricing quickstart) |
| Product upsert | `POST /content/v1/product/upsert` | Verified (Content quickstart prefix) |
| Category schema | `POST /content/v1/categories/attributes/list` | Verified |
| Orders | `POST /fbpi/v1/fbpi-orders/list` | Verified (FBPI webhook guide prefix) |
| Shipment | `POST /fbpi/v1/shipment/create` | Path from the API reference |
| Warehouses | `POST /warehouse-platform/v1/warehouses/list` | **Path prefix inferred** |

The warehouse prefix is the one guess. noon's docs never show it in a worked
example, and the pattern (`/<service>/v1/…`) is inferred from the five that are
shown. If `setup warehouses` returns a 404, that prefix is why — it is a
one-line change in `SERVICE` at the top of `src/client.ts`.

**Nothing here has run against a live noon account.** The client is covered by
51 unit tests against a stubbed gateway, which proves the request shapes and
the error handling, and proves nothing about whether noon accepts them.

---

## Credentials

noon does **not** issue an API key and secret. A service account of type
`apijwt` produces a JSON file with three fields:

```json
{ "key_id": "…", "private_key": "-----BEGIN PRIVATE KEY-----…", "project_code": "…" }
```

`private_key` signs a short-lived RS256 assertion; it is never sent. Login
returns session cookies, which the client carries and silently re-establishes
on a 401.

A browser session from being logged in to noon.partners is not a substitute.
It expires in hours and is scoped to a person, not an integration.

Get one: **Partner Portal → User & Access → Project users → +Add new →
Service account**, type `apijwt`, role `Project Owner`, then download the JSON.

Then either point `NOON_CREDENTIALS_FILE` at it, or set `NOON_KEY_ID`,
`NOON_PRIVATE_KEY` and `NOON_PROJECT_CODE`. See `.env.example`.

---

## Turning it on

```bash
# 0. Apply the migration that creates the mapping tables.
npm run db:migrate

# 1. Point at the sandbox first.
#    NOON_API_BASE_URL=https://sandbox-api-gateway.noon.partners

# 2. Prove the credentials work.
npm run setup --workspace=@voltix/noon -- whoami

# 3. Map a warehouse. Nothing syncs until at least one is mapped, because
#    every stock write and order read is scoped to a noon warehouse code.
npm run setup --workspace=@voltix/noon -- warehouses
npm run setup --workspace=@voltix/noon -- map DXB-01 WH-DXB-01 ae

# 4. Opt variants in. Drafts by default — see below.
npm run setup --workspace=@voltix/noon -- link --sku PHONE-X --sku PHONE-Y
#   …or, once you trust it:
npm run setup --workspace=@voltix/noon -- link --all

# 5. See what the sync would do, without doing it.
npm run setup --workspace=@voltix/noon -- status

# 6. Run it.
npm run worker
```

`link` creates listings as `draft`. Only `live` listings receive stock and
price updates. If the products already exist on noon — created in Seller Lab
rather than through this system — mark them live directly with `link --live`;
otherwise the catalogue push submits them for approval first.

---

## How the sync decides what to send

There is no "on stock change, enqueue a job" trigger, and that is deliberate.

An enqueue-on-write design is only as complete as its call sites. Stock moves
in checkout, returns, purchase-order receipt, stocktake, admin edits, the
reservation sweep and the noon order import — every one of them would have to
remember to enqueue, forever, including the ones written next year. One missed
call site is a listing that is silently wrong until someone reconciles it,
which is the exact failure this integration exists to prevent.

Instead the sweep diffs desired state against what noon last accepted:

```
available = max(0, on_hand − reserved)      per mapped warehouse
send if   available ≠ noon_listings.pushed_qty
```

No call sites to miss. Any change made by any code path shows up in the next
tick's diff, because the diff reads the resulting state rather than trusting a
notification about it. `pushed_qty` is written only after noon confirms the
item — never optimistically.

**Reserved stock is withheld on purpose.** A reservation is a unit a Voltix
shopper has at checkout and has not paid for. Publishing it offers the same
physical unit to two marketplaces, and the loser is a noon order that cannot be
fulfilled — which costs a cancellation against the seller's fulfilment rate,
not merely a refund.

**Backorderable variants are excluded entirely.** "How many can I promise"
is a purchasing question this module cannot answer, so it declines to guess.

---

## The three failure modes it is built around

**A 200 is not a success.** noon's batch endpoints return per-item `status`
objects inside a 200 response. Some SKUs are accepted and some are rejected in
the same call. Treating `response.ok` as success is how a listing sits at the
wrong quantity for a week while the dashboard shows green. `NoonBatchResult`
forces the caller to look at both, and rejections land in
`noon_listings.last_error`.

**Units.** Voltix stores integer minor units; noon takes major-unit doubles.
Every price crossing this boundary is one missing division away from being
100× wrong, and noon will accept it. `guardPrice` applies an absolute bound
and — for anything published before — refuses a change of more than 20×, which
is what catches the AED 49 accessory sent as 4,900.

**Drift.** The diff trusts `pushed_qty`, which is correct until someone edits
a quantity in Seller Lab by hand. The reconcile job reads noon's own figures,
and where they disagree it clears `pushed_qty` so the next push re-sends the
authoritative local number. It deliberately does not push: repair belongs to
one code path, the one already tested for partial rejection.

---

## Transaction shape

The sync takes a `Database`, not a `Tx`, and opens several short transactions
rather than one long one — the same rule the notification dispatcher follows.
Holding a Postgres transaction open across a multi-second call to noon would
pin a pooled connection and turn one slow marketplace response into
database-wide contention.

A crash between the call and the record leaves noon updated and `pushed_qty`
stale. That is the safe direction: the next sweep re-sends an identical
absolute quantity, which is a no-op on noon's side.

---

## What is not built

- **noon orders do not become Voltix `orders` rows.** They get a link row in
  `noon_order_links` and a `stock_movements` entry, so the inventory pool is
  shared and the audit trail is intact. A synthetic order record would put rows
  into revenue and VAT reporting for a sale noon invoices, not us.
- **Shipment confirmation is not automated.** `createShipment` exists on the
  client and as an MCP tool; nothing calls it on a schedule yet.
- **Content push is per-product and manual.** `pushProduct` validates and
  submits; there is no sweep that walks the catalogue submitting drafts.
- **Event-notification webhooks are unused.** noon can push order events to an
  HTTPS destination, which would replace the 5-minute order poll. The endpoint
  is mapped in the API surface but no subscription is created.
- **`pushed_qty` is one column across warehouses.** Correct for the
  single-warehouse case; the reconcile sweep covers the multi-warehouse case
  because it compares against noon's figures rather than that column.

---

## Operating it

```sql
-- Listings that noon keeps rejecting.
SELECT partner_sku, status, consecutive_failures, last_error, last_error_at
  FROM noon_listings
 WHERE consecutive_failures > 0
 ORDER BY last_error_at DESC;
```

A listing stops being retried after 10 consecutive failures, so a permanently
malformed SKU does not consume a slot in every batch forever. Fix the cause,
then `UPDATE noon_listings SET consecutive_failures = 0 WHERE …`.

To pause one listing without archiving it — a price being managed by hand on
noon, say — set `sync_enabled = false`.
