# Voltix Commerce

A commerce platform for electronics and mobile retail in the **United Arab Emirates** — an online
store for one merchant, built on foundations that could serve many without a rewrite: every table
is tenant-scoped and enforced by row-level security, and every payment gateway sits behind one port.

Two things worth knowing before reading further, because both have been claimed loosely elsewhere.
**No language model runs in this product.** The search ranking, demand forecasting and risk scoring
are deterministic algorithms, and they are described as such below. And while the schema and
policies are genuinely multi-tenant, it is **deployed for exactly one tenant** and the SaaS
programme is parked — so the isolation is tested but unexercised in production.

---

## What is actually here

**Phases 1–2 are complete and Phase 3 is under way: guest checkout, staff authentication, admin
order management and customer notifications all work end to end.** That is stated precisely rather
than buried, because "production-ready enterprise platform" is a claim that takes a team months to
earn and a paragraph to falsely assert.

**Implemented, typechecked, and covered by 461 passing tests** (unit + integration against real Postgres)**:**

| Area | What works |
|---|---|
| Database | 71 tables, 67 with row-level security, plus money-integrity constraints. Runs on Postgres 17 (Docker) or 18 (Neon) with pgvector; migrations generated, applied and idempotently re-runnable. The app connects as a **restricted role** — a superuser silently bypasses every policy, so isolation is verified by test, not assumed |
| Checkout | Cart → server-authoritative pricing → row-locked stock reservation → order → payment → commit or release. Idempotent, transactional, gap-free order numbering |
| Job runner | Postgres-backed queue with `SKIP LOCKED`, exponential backoff and dead-lettering. Reservation sweep, abandoned-cart detection, payment reconciliation |
| UAE market rules | 5% VAT extracted from inclusive prices, TRN validation, emirate/Makani addressing with no postal code, Sat–Sun weekend delivery estimates, `+9715…` phone normalisation |
| Pricing engine | Discounts, stacking rules, BXGY, inclusive VAT, allocation without rounding drift, stored-value tender. Pure and deterministic |
| Money | Integer minor units, GCC three-decimal currencies handled, largest-remainder allocation fuzz-tested to never lose or invent a fils |
| Order lifecycle | Three-axis state machine (lifecycle / payment / fulfilment) with guarded transitions |
| Inventory | Availability, multi-warehouse allocation, reservation TTLs, oversell prevention |
| Payments | Gateway port + adapters for Stripe, Network International (N-Genius), Tabby BNPL and Cash on Delivery. Circuit breakers, idempotency, and signed webhooks that are actually **received** — `/api/webhooks/[provider]` verifies the raw body, dedupes on a database constraint and settles in a job, so a redirect payment can reach a terminal state. COD supports a risk-gated advance deposit, split across two payment intents |
| Decisioning | Hybrid-search fusion (RRF with query classification), statistical demand forecasting (Croston / seasonal-naive / Holt, selected by series shape), and explainable card-and-COD risk scoring wired into checkout. **All deterministic — no language model is invoked anywhere in the running product.** `packages/ai` also contains an Anthropic client and a 7-task registry; both are complete, tested and **currently have no call sites**. They are scaffolding for later, not a shipped capability |
| RBAC | 8 seeded roles, wildcard permissions, MFA required of any role that can move money |
| Staff auth | Argon2id passwords, opaque DB-backed sessions (instant revocation), per-account and per-IP lockout, TOTP two-factor verified against RFC 6238 vectors, AES-GCM-encrypted secrets, one-time recovery codes. `npm run db:create-user` creates the first owner |
| Storefront | Next.js 16 — homepage, indexable category pages with crawlable pagination, faceted search, product detail with image gallery and Product + FAQ structured data, Tabby instalment display, WhatsApp ordering, cart, checkout with redirect-gateway return handling, guest order tracking, downloadable tax invoice, delivery/returns/contact pages, sitemap and robots. English and Arabic with full RTL |
| Storefront security | Nonce-based Content-Security-Policy enforced by default (verified against a production build, not just `next dev`), rate limiting on order lookup and search — fail-closed and fail-open respectively — and a demo catalogue that cannot be served in production |
| Analytics | `checkout_started` / `checkout_failed` (with reason and step) / `cod_refused` / `order_placed` (with emirate, which cannot be backfilled), plus `product_viewed`, `search_performed` and a zero-result search log. Written outside the order transaction, so a reporting failure can never cost a sale |
| Tax documents | Full and simplified UAE invoices selected by the AED 10,000 threshold, sequential gap-free numbering, supplier and recipient TRN, per-line VAT. A document is never labelled a tax invoice unless it legally is one |
| Admin | Login + MFA enrolment, dashboard/orders/inventory driven by real database reads, order detail with state-machine-gated actions (confirm / fulfil / cancel with stock return), PII behind its own permission, message outbox with human approval of marketing drafts |
| Payments (admin) | Record cash-on-delivery collection and issue full or partial refunds through the gateway that took the payment. Every movement is a ledger row and the payment status is recomputed from it — never written directly. Over-refunding is blocked in the domain and again by a database CHECK; a failed gateway refund rolls back whole |
| Notifications | Transactional outbox written atomically with the order, dispatched outside transactions over SMTP (Mailpit in dev) and WhatsApp Cloud API. Bilingual templates; COD wording never claims payment; marketing held as drafts until approved; consent enforced per channel |
| noon marketplace | Stock and price push, catalogue content upsert with per-category attribute validation, order import into the shared inventory pool, and a drift reconcile against noon's own figures — driven by the worker outside any transaction. Built on noon's real Partner API (RS256 service-account assertion → session cookies), and it treats a 200 carrying per-item rejections as the partial failure it is. **Never run against a live noon account**; `packages/noon/README.md` states which endpoint paths are verified and which one is inferred |

**Specified in `docs/` but not yet built:** customer accounts (guest checkout is a deliberate
decision, and wishlist and review submission are deferred behind it), the campaign builder,
courier integration and shipments, partial per-line fulfilment, serial/IMEI capture, Arabic
product *content* as opposed to Arabic UI, and the customer-facing shopping assistant.
`docs/07-roadmap.md` sequences these.

**Nothing here has run against real money.** No gateway adapter has been tested against a live
merchant account, and no load test has been run. Those are the largest remaining risks.

---

## Live deployment

| App | URL |
|---|---|
| Storefront | https://voltix-storefront.vercel.app |
| Admin | https://voltix-admin-eosin.vercel.app |

Both run on Vercel (Singapore region, `sin1` — closest to the Neon database) against the Neon
Postgres instance, and auto-deploy from `main`.

**Background jobs.** A serverless platform has nowhere to run a long-lived queue poller, so the
worker loop is also exposed as one HTTP call at `/api/cron/tick` on the storefront. It runs the
same three steps `npm run worker` does, calling the identical functions so the two cannot drift,
and is authenticated with a bearer `CRON_SECRET` (it refuses to run at all if that is unset — an
open job runner is a free denial-of-service). Two schedules drive it: Vercel's own cron once a
day as a safety net, and a GitHub Actions workflow every five minutes as the real cadence,
because Vercel's Hobby plan only fires cron daily and a shopper should not wait a day for a
receipt. On Vercel Pro the native cron supports minute-level schedules and the workflow can go.

`npm run worker` is still the right thing to run on an always-on host (Railway, Fly.io, a VPS) if
you would rather not depend on an external scheduler — both paths are supported and equivalent.

---

## Quickstart

### With the database (recommended — this is the real path)

```bash
npm install
npm run infra:up                 # Postgres 17 + pgvector on :5433, Redis, MinIO, Mailpit
cp .env.example .env
npm run db:generate              # generate migrations from the Drizzle schema
npm run db:migrate               # extensions, migrations, RLS policies, integrity constraints
npm run db:seed                  # a realistic UAE catalogue in AED
npm run dev                      # storefront on http://localhost:3000
```

Postgres binds host port **5433**, not 5432 — a locally installed Postgres usually holds 5432, and
the clash produces a confusing "database exists but has no tables" failure.

### With a cloud database (Neon, RDS, Cloud SQL)

Skip `npm run infra:up` for Postgres and point the two connection strings at the provider —
`.env.example` documents the three steps (migrate as the owner, set the `voltix_app` password,
connect the app as `voltix_app`). Two things the migration handles that are easy to miss on
managed Postgres: the owner role usually cannot have `BYPASSRLS`, so `policies.sql` creates an
explicit `admin_bypass` policy for it; and connection strings should use `sslmode=verify-full`,
which the pool enforces as full certificate verification. Redis, MinIO and Mailpit still come
from `npm run infra:up` (or their own cloud equivalents).

### Without a database

```bash
npm install && npm run dev
```

The storefront falls back to an in-memory UAE catalogue, so a fresh clone serves a working store in
under a minute. The fallback is for evaluation only — `packages/config` refuses to boot production
without a real `DATABASE_URL`.

### Everything else

```bash
npm test                         # 243 tests (integration suites skip without Postgres)
npm run worker                   # job runner + notification dispatcher (sends the emails)
npm run db:create-user -- --email you@store.ae --role owner   # first staff account
npm run typecheck                # all 9 packages
npm run dev:admin                # admin on http://localhost:3001 (sign in, enrol MFA)
npm run infra:reset              # wipe and recreate the database volumes
```

Mailpit catches every development email at http://localhost:8025 — place an order and watch the
confirmation arrive without a real mailbox.

---

## Layout

```
apps/
  storefront/     Next.js 16 customer storefront (en-AE / ar-AE)
  admin/          Next.js 16 merchant dashboard
packages/
  db/             Drizzle schema, migrations, RLS policies, UUIDv7, seed
  commerce/       Cart, reservations, checkout, orders, job queue, notification jobs
  core/           Money, pricing engine, order state machine, inventory, RBAC, UAE region rules
  payments/       Gateway port + Stripe / Network International / Tabby / COD adapters
  auth/           Argon2id passwords, sessions, login throttling, TOTP MFA, create-user CLI
  notifications/  Transport port + SMTP / WhatsApp adapters, bilingual templates, outbox dispatch
  ai/             Anthropic gateway, task registry, search fusion, forecasting, risk
  ui/             Design tokens, locale-aware formatting
  config/         Boot-time environment validation
infra/            docker-compose + Postgres init
docs/             Architecture, product, data model, API, security, roadmap
```

---

## Documentation

| Document | What it covers |
|---|---|
| [docs/00-decisions.md](docs/00-decisions.md) | Every significant technology choice, the alternatives rejected, and why |
| [docs/01-product.md](docs/01-product.md) | Personas, user stories with acceptance criteria, information architecture, key flows |
| [docs/02-architecture.md](docs/02-architecture.md) | System and sequence diagrams, request lifecycle, multi-tenancy model |
| [docs/03-data-model.md](docs/03-data-model.md) | Entity relationships and the reasoning behind the non-obvious modelling |
| [docs/04-api.md](docs/04-api.md) | Endpoint surface, conventions, idempotency, error contract |
| [docs/05-security.md](docs/05-security.md) | Threat model, OWASP coverage, tenant isolation, payment and PII handling |
| [docs/06-quality.md](docs/06-quality.md) | Performance budgets, testing strategy, deployment and rollback |
| [docs/07-roadmap.md](docs/07-roadmap.md) | Phased plan from here to a commercial SaaS, with honest estimates |

---

## Three decisions worth knowing up front

**UAE localisation is structural, not a translation layer.** Four rules break a store that gets them
wrong, and each is invisible until it is expensive: VAT is 5% and consumer prices must be displayed
*inclusive* of it (so tax is extracted, never added at checkout); there is no postal-code system, so
addresses use emirate + community + building or a Makani number; a tax invoice without a TRN is not
valid and a business customer will reject it; and the weekend is Saturday–Sunday, which every
delivery promise computes against. See `packages/core/src/regions/uae.ts` and ADR-0013.

**Payment ordering is a conversion lever.** Cards and wallets lead, Tabby sits directly beneath them
because "AED 1,175 today" converts shoppers who abandon at AED 4,699, and cash on delivery is
offered last — genuinely available, deliberately not the default. Tabby also underwrites the shopper
*before* checkout, which is why the registry pre-scores eligibility rather than letting someone
select it and then be turned away. See ADR-0005.

**Forecasting is statistics, not a language model.** "AI inventory forecasting" is usually sold as an
LLM feature and should not be one: it has a measurable error metric, and a seasonal-naive or
Croston baseline beats a language model at it for free while producing the same answer twice and
being backtestable. The language model's job is explaining the numbers and drafting the purchase
order. See `packages/ai/src/forecast.ts` and ADR-0007.
