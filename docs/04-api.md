# API Specification

> ⚠️ **This document has drifted from the implementation.** See
> [`PRODUCT-TECHNICAL-MASTER.md`](./PRODUCT-TECHNICAL-MASTER.md) for the audited
> current state. Specific inaccuracies are listed there.

> **Known inaccuracy:** The REST API described here was never built. Only /api/cron/tick exists.


## Shape

Three surfaces, chosen per use case rather than uniformly:

| Surface | Used for | Why |
|---|---|---|
| **Server Actions / RSC** | Storefront and admin UI mutations | No client-side API layer to keep in sync, no serialisation boilerplate, and the auth check is inherently server-side |
| **REST under `/api/v1`** | Mobile apps, POS, third-party integrations, merchant scripts | A public API needs versioning, keys and documentation. Server Actions cannot be any of those. |
| **Webhooks in/out** | Gateways, couriers, WhatsApp; merchant subscriptions | — |

GraphQL was considered and rejected: the client set is known and small, the flexibility mostly buys
query-cost problems, and REST plus RSC covers it without a schema-stitching layer to operate.

## Conventions

**Auth.** Session cookie (httpOnly, `SameSite=Lax`, `Secure`) for browsers.
`Authorization: Bearer vx_live_…` for API keys; only the SHA-256 hash is stored, the plaintext is
shown once.

**Tenant.** Resolved from the host or the API key. Never from a request body or query parameter — a
tenant id the client can set is not an isolation boundary.

**Idempotency.** Every non-GET that moves money or stock requires `Idempotency-Key`. The key is
stored with the response for 24 hours; a replay returns the original response rather than acting
twice. A double-tapped Pay button on a flaky mobile connection must not create two charges.

**Money.** Always `{ "amount": 469900, "currency": "AED" }` — integer minor units (fils),
VAT-inclusive. Never a decimal string, never a float.

**Pagination.** Cursor-based. Offset pagination on an order list that is being written to skips and
duplicates rows.

**Errors.** One envelope. `message` is customer-safe; the internal detail goes to logs and the
`requestId` correlates them.

```json
{
  "error": {
    "code": "OUT_OF_STOCK",
    "message": "Only 2 left — please reduce the quantity.",
    "details": { "variantId": "…", "requested": 5, "available": 2 },
    "requestId": "req_01J…"
  }
}
```

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 422 | no |
| `UNAUTHORISED` / `FORBIDDEN` | 401 / 403 | no |
| `NOT_FOUND` | 404 | no |
| `CONFLICT` / `OUT_OF_STOCK` / `PRICE_CHANGED` | 409 | no — refresh and retry |
| `PAYMENT_DECLINED` / `PAYMENT_FAILED` | 402 | no |
| `RATE_LIMITED` | 429 | yes, after `Retry-After` |
| `GATEWAY_UNAVAILABLE` / `AI_UNAVAILABLE` | 503 | yes, with backoff |
| `AI_BUDGET_EXCEEDED` | 429 | not today |

**Rate limits.** Per tenant and per IP, sliding window. Read `600/min`, write `120/min`, auth
`10/min`, AI `30/min`. Headers: `X-RateLimit-{Limit,Remaining,Reset}`.

## Endpoints

### Catalogue — public

```http
GET  /api/v1/products?category=&brand=&minPrice=&maxPrice=&inStock=&sort=&cursor=
GET  /api/v1/products/:slug
GET  /api/v1/products/:id/related
GET  /api/v1/categories
GET  /api/v1/search?q=&…            # hybrid retrieval; ≤300 ms p95
GET  /api/v1/search/suggest?q=      # type-ahead, ≤80 ms p95
```

`GET /search` returns the retrieval strategy used (`identifier` / `navigational` / `exploratory`)
alongside results. It is not a debug leak: it is the first thing a merchant needs when a search
looks wrong.

### Cart & checkout

```http
POST   /api/v1/carts
GET    /api/v1/carts/:id
POST   /api/v1/carts/:id/items            { variantId, quantity }
PATCH  /api/v1/carts/:id/items/:itemId    { quantity }
DELETE /api/v1/carts/:id/items/:itemId
POST   /api/v1/carts/:id/coupons          { code }

POST   /api/v1/checkout/session           → totals + available/unavailable methods with reasons
POST   /api/v1/checkout/complete          Idempotency-Key required
GET    /api/v1/checkout/:id/status
```

Every cart mutation returns freshly computed totals. The client never adds up line items itself —
the number it would produce is not trusted anyway, so producing it is wasted work and a source of
disagreement.

`POST /checkout/complete` recomputes pricing before authorising. If anything changed it returns
`409` naming the specific change, rather than charging an amount the shopper did not agree to.

### Orders

```http
GET   /api/v1/orders?status=&paymentStatus=&fulfilmentStatus=&cursor=
GET   /api/v1/orders/:id
GET   /api/v1/orders/lookup?number=&phone=     # guest order tracking
POST  /api/v1/orders/:id/cancel                { reason }
POST  /api/v1/orders/:id/refunds               { amount, lineItems[], reason }
POST  /api/v1/orders/:id/shipments             { warehouseId, items[], carrier }
GET   /api/v1/orders/:id/actions               # exactly what is legal right now
```

`GET /actions` exists so the UI and the API cannot disagree about what is possible — a disagreement
the user always experiences as a bug.

### Inventory & purchasing

```http
GET   /api/v1/inventory?warehouseId=&lowStock=true
POST  /api/v1/inventory/adjustments      { variantId, delta, reason, note }
GET   /api/v1/inventory/forecast/:variantId
GET   /api/v1/inventory/replenishment    # suggested orders, ranked by urgency
POST  /api/v1/purchase-orders
POST  /api/v1/purchase-orders/:id/receive
```

Adjustments require a `reason` from a fixed enum. "Someone changed it" is not an audit trail.

### AI

```http
POST  /api/v1/ai/tasks/:taskId/run       { entityId, input }  → 202 + jobId
GET   /api/v1/ai/jobs/:id
POST  /api/v1/ai/jobs/:id/review         { decision: approve|reject, edits? }
GET   /api/v1/ai/usage?from=&to=         # spend per task, per model
POST  /api/v1/ai/assistant/message       { sessionId, message }  → streamed
```

Every task runs asynchronously; the merchant is never blocked on a model call. Tasks with
`requiresReview` land in `awaiting_review` and cannot publish without an explicit decision, which is
recorded as a labelled signal for prompt evaluation.

### Webhooks — inbound

```http
POST /api/webhooks/stripe         # Stripe-Signature: HMAC over `${timestamp}.${rawBody}`
POST /api/webhooks/network        # N-Genius return; order state confirmed by pull, not by the redirect
POST /api/webhooks/tabby          # X-Tabby-Signature, then independently confirm via the payments API
POST /api/webhooks/courier/:code
POST /api/webhooks/whatsapp
```

Rules that apply to every one:

1. **Verify the signature against the raw body before parsing.** Re-serialising JSON changes bytes
   and invalidates the MAC. An unverified webhook is an unauthenticated request claiming a payment
   succeeded — the cheapest possible way to rob a store.
2. **Check the timestamp.** Without it, a signature captured from a legitimate old event replays
   forever.
3. **Persist first, process second.** Store the envelope with a unique constraint on the provider's
   event id, then process. Gateways retry aggressively and deliver out of order.
4. **Never trust the payload's claim of success.** A Network International return arrives on a
   browser redirect that is fully under the shopper's control, and a Tabby callback is a hint — both
   are independently confirmed by querying the provider before money is recorded as received.
5. **Return 2xx fast.** Processing happens on the queue. A handler that does work inline gets
   retried into a thundering herd.

### Webhooks — outbound

Merchants subscribe to `order.created`, `order.paid`, `order.fulfilled`, `order.cancelled`,
`inventory.low_stock`, `return.requested`. Signed with HMAC-SHA256 over `${timestamp}.${body}`,
retried with exponential backoff for 24 hours, then parked in a dead-letter queue with an alert.

## Versioning

The path carries the major version. Additive changes ship without a bump; removals and semantic
changes require a new version, six months of parallel operation, and deprecation headers
(`Sunset`, `Deprecation`, `Link`) on the old one from day one of the overlap.
