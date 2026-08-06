# Security

## Threat model

Ranked by expected loss, not by how interesting the attack is.

| Threat | Impact | Primary control |
|---|---|---|
| Cross-tenant data access | Catastrophic — one breach ends the SaaS | Postgres RLS, forced on the owner role |
| Payment tampering (client-supplied prices) | Direct revenue loss | Server-authoritative pricing, recomputed before authorisation |
| Forged payment webhooks | Goods shipped for free | Signature verification + independent provider confirmation |
| Account takeover (staff) | Full store control | Argon2id, mandatory MFA above `staff`, session epoch invalidation |
| COD refusal abuse | Round-trip freight per incident, at scale | Explainable risk scoring, advance-payment gating |
| Card testing on checkout | Gateway penalties, chargebacks | Velocity limits, rate limiting, CAPTCHA escalation |
| Catalogue scraping | Competitive pricing loss | Rate limits, no exact stock counts above a ceiling |
| Prompt injection via product data | Wrong output, potential data exposure | AI inputs treated as untrusted data; grounding rules override input |
| PII exposure in logs | Regulatory and reputational | Field-level redaction, `customer:read_pii` as a separate permission |

## OWASP Top 10 coverage

**A01 Broken access control.** RBAC with `resource:action` permissions and a deny-by-default check.
`finance:read` and `customer:read_pii` are separate from the resource permissions, so a support agent
can work an order without seeing cost or phone numbers. Every authorisation check happens server-side;
the admin nav hides links the role cannot use, but hiding is presentation, not enforcement. Object
ownership is enforced by RLS, so an id from another tenant returns 404 rather than 403 — a 403 confirms
the row exists.

**A02 Cryptographic failures.** TLS 1.3 with HSTS preload. Argon2id for passwords (memory-hard;
bcrypt's 72-byte truncation and GPU profile make it the weaker choice today). Gateway credentials are
envelope-encrypted with AES-256-GCM, key in KMS, decrypted on use and never logged. API tokens stored
as SHA-256; gift card codes as hashes with only the last four retained.

**A03 Injection.** Parameterised queries throughout — Drizzle's `sql` template is parameterised, and
`sql.raw` appears in exactly one place (the migration runner, on files from the repository). Zod
validation at every boundary. React escapes by default; the one `dangerouslySetInnerHTML` is
JSON-LD built from a serialised object, never from user text.

**A04 Insecure design.** The controls that matter here are structural rather than added: money as
integers, ledgers instead of mutable balances, a state machine instead of free-form status writes,
reservations instead of decrement-on-add. Each removes a class of bug rather than mitigating an
instance.

**A05 Security misconfiguration.** `packages/config` refuses to boot production with a placeholder
auth secret, a missing CDN URL, or Stripe configured without a webhook secret. Security headers in
`next.config.ts`; CSP with a per-request nonce in middleware. Admin is `noindex, nofollow` and
`Referrer-Policy: no-referrer` — an admin URL can carry an order id, and leaking it to any external
link a staff member clicks is an avoidable disclosure.

**A06 Vulnerable components.** `npm audit --audit-level=high` fails CI. Dependabot weekly. The
dependency list is deliberately short: four runtime dependencies across all five packages.

**A07 Authentication failures.** Rate limit `10/min` on auth endpoints. Argon2id. TOTP MFA mandatory
for any role with `order:refund` or `settings:write` — enforced by a test that walks the role table,
so adding a money-moving role without MFA fails the build. Sessions are httpOnly, `SameSite=Lax`,
rotated on privilege change; `sessionEpoch` invalidates every live session on password change.

**A08 Data integrity failures.** Webhook signatures verified against raw bodies. `SRI` on any
external script (there are none by default). Lockfile committed; CI installs with `npm ci`.

**A09 Logging failures.** Structured JSON logs with a request id. Anything touching money, price,
stock, or permissions writes to `audit_logs`, which the application role cannot UPDATE or DELETE.
Redaction of phone, email, address and payment fields is applied at the logger, not at call sites.

**A10 SSRF.** No user-supplied URL is fetched server-side. Webhook targets for outbound merchant
subscriptions are validated against private IP ranges and resolved before connect.

## Payment security

- **PCI scope is minimised by never touching card data.** Redirect and hosted-field flows only; no
  PAN, CVV or expiry ever reaches this application. That keeps compliance at SAQ-A.
- **Idempotency keys on every money-moving request**, which is what makes the retry-with-backoff
  wrapper safe. Retrying a non-idempotent charge is how a customer gets billed twice.
- **Declines are never retried.** A declined card retried three times is three declines, three
  fraud-signal hits on the issuer, and three seconds of a shopper watching a spinner. Only transport
  failures and 5xx responses are retried.
- **Circuit breakers per gateway**, so one provider's outage does not become everyone's checkout
  latency.
- **Refunds are capped by the ledger** — `refunded_total <= paid_total` is a database constraint, not
  a code path.

## AI-specific security

**Prompt injection.** All product data, review text and customer messages are untrusted input. Every
system prompt states that instructions found in the input are to be ignored, and the grounding rules
explicitly override anything in the data. Structured output means a successful injection cannot
change the *shape* of what comes back — the schema is enforced at the tool layer.

**Data exfiltration.** The AI gateway sends only the fields a task needs. No task receives full
customer records; the shopping assistant sees catalogue candidates and the current message, never an
order history or a phone number.

**Cost as an attack surface.** Per-tenant daily budgets are enforced before the call, not after the
invoice. A tenant that exhausts its budget receives a typed refusal.

**Output safety.** Every customer-facing generation requires human approval before publishing. This
is the control that matters most: a model will confidently invent a battery capacity, and a stated
specification is a contractual claim.

## Backup and recovery

| Property | Target |
|---|---|
| RPO | 5 minutes (continuous WAL archiving) |
| RTO | 30 minutes (documented restore, rehearsed quarterly) |
| Backup retention | 30 days point-in-time, 12 months monthly snapshots |
| Restore verification | Automated weekly restore into a scratch environment with a row-count and checksum comparison |

A backup that has never been restored is a hypothesis. The weekly automated restore is what turns it
into a fact.

## Compliance posture — UAE

- **VAT and tax invoicing.** A compliant UAE tax invoice must carry the supplier's legal name,
  address and 15-digit TRN, the invoice number and date, the taxable amount, the VAT rate and the
  VAT amount separately, and the gross total. `TAX_INVOICE_REQUIRED_FIELDS` encodes that as a
  checklist so the template cannot silently drop one, and `packages/config` refuses to boot
  production without a format-valid TRN. Prices are stored and displayed VAT-inclusive as UAE law
  requires; the net/VAT split is computed at invoice time by `extractVat`.

- **Data residency** is configurable per tenant and the schema carries no assumption of a single
  region. UAE customers increasingly expect data held in-region; Neon, AWS and Azure all offer UAE
  regions, and the choice is a deployment decision rather than a code change.

- **Consumer protection.** UAE Federal Law No. 15 of 2020 gives buyers repair, replacement or refund
  rights on defective goods. It does not mandate a blanket cooling-off window for all e-commerce, so
  the 14-day change-of-mind window in `RETURN_POLICY` is merchant policy set deliberately generously
  — in this market return policy is a competitive signal — and stated plainly, because an ambiguous
  policy generates disputes. Not legal advice; the merchant's own terms govern.

- **Right to erasure**: customer PII is anonymised in place rather than deleted, because order rows
  are financial records with statutory retention (UAE VAT law requires records be kept for five
  years). `customers` retains a tombstone; name, phone, email and addresses are overwritten.

- **Consent** for email, SMS and WhatsApp marketing is stored as three separate booleans with
  timestamps, because they are three separate legal bases and a single "accepts marketing" flag
  cannot evidence which one was given. SMS sender IDs must additionally be registered with the TDRA
  before any message sends.

- **Automated decisions** (COD refusal, risk blocks, Tabby rejection) always carry a human-readable
  reason and a human override path, recorded in `risk_assessments.overriddenByUserId`. For Tabby
  specifically, the shopper is shown Tabby's own wording rather than ours — it is tuned not to imply
  a credit judgement.

- **PCI scope** stays at SAQ-A: no card data touches this application under any of the configured
  gateways. Network International and Stripe both use hosted or redirect flows.
