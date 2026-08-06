import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { currency, money, tenantId, timestamps } from './_shared';

/**
 * AI OPERATIONS SCHEMA
 *
 * Two principles drive this design:
 *
 * 1. **Every AI output is auditable.** Model, prompt version, inputs, cost and
 *    the human who approved it are recorded. When a generated description
 *    claims a phone has a feature it does not, "which prompt did that?" must be
 *    a one-query answer, not an archaeology project.
 *
 * 2. **Spend is metered like any other resource.** An unbounded LLM feature in
 *    a multi-tenant product is an unbounded bill. `aiUsage` is the meter;
 *    @voltix/ai refuses work once a tenant crosses its daily cap.
 */

export const aiJobStatus = pgEnum('ai_job_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'awaiting_review',
]);

/**
 * A unit of AI work. Long-running and bulk operations (describe 400 products,
 * regenerate all meta descriptions) run here rather than inside a request, so
 * the admin UI stays responsive and failures are retryable.
 */
export const aiJobs = pgTable(
  'ai_jobs',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    /** Registry key, e.g. 'product.describe', 'seo.meta', 'review.summarise'. */
    task: varchar('task', { length: 64 }).notNull(),
    status: aiJobStatus('status').notNull().default('queued'),

    entityType: varchar('entity_type', { length: 32 }),
    entityId: uuid('entity_id'),

    input: jsonb('input').notNull().default({}),
    output: jsonb('output'),

    model: varchar('model', { length: 64 }),
    promptVersion: varchar('prompt_version', { length: 32 }),

    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cachedTokens: integer('cached_tokens'),
    /** Micro-USD (1e-6 USD) — LLM calls are routinely sub-cent. */
    costMicroUsd: integer('cost_micro_usd'),
    latencyMs: integer('latency_ms'),

    /** Human-in-the-loop gate. Set when a merchant accepts or rejects output. */
    reviewedByUserId: uuid('reviewed_by_user_id'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
    reviewDecision: varchar('review_decision', { length: 16 }),

    error: text('error'),
    attempts: smallint('attempts').notNull().default(0),
    requestedByUserId: uuid('requested_by_user_id'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    index('ai_jobs_tenant_status_idx').on(t.tenantId, t.status),
    index('ai_jobs_task_idx').on(t.tenantId, t.task, t.createdAt),
    index('ai_jobs_entity_idx').on(t.entityType, t.entityId),
  ],
);

/** Daily per-tenant, per-task spend meter. Enforces the budget ceiling. */
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    /** Date in the tenant's timezone, not UTC — budgets reset on their clock. */
    day: varchar('day', { length: 10 }).notNull(),
    task: varchar('task', { length: 64 }).notNull(),
    model: varchar('model', { length: 64 }).notNull(),
    requestCount: integer('request_count').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cachedTokens: integer('cached_tokens').notNull().default(0),
    costMicroUsd: integer('cost_micro_usd').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('ai_usage_key').on(t.tenantId, t.day, t.task, t.model),
    index('ai_usage_tenant_day_idx').on(t.tenantId, t.day),
  ],
);

/**
 * Demand forecast per (variant, warehouse, horizon).
 *
 * Deliberately *not* an LLM output. Forecasting is a statistical problem with a
 * measurable error metric, and a seasonal-naive/ETS baseline beats a language
 * model at it while costing nothing per prediction. The LLM's job is to explain
 * the forecast and draft the purchase order — the numbers come from statistics.
 * `modelKind` records which estimator produced the row so we can compare MAPE
 * across methods rather than assume.
 */
export const demandForecasts = pgTable(
  'demand_forecasts',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    variantId: uuid('variant_id').notNull(),
    warehouseId: uuid('warehouse_id'),

    horizonDays: smallint('horizon_days').notNull(),
    /** 'seasonal_naive' | 'ets' | 'croston' | 'gbm' */
    modelKind: varchar('model_kind', { length: 32 }).notNull(),

    predictedUnits: integer('predicted_units').notNull(),
    /** 80% prediction interval — a point estimate alone is not decision-grade. */
    lowerBound: integer('lower_bound'),
    upperBound: integer('upper_bound'),

    /** Units to hold against demand variance during supplier lead time. */
    safetyStock: integer('safety_stock'),
    reorderRecommendation: integer('reorder_recommendation'),
    recommendedSupplierId: uuid('recommended_supplier_id'),

    /** Backtested mean absolute percentage error, 0–10000 bps. */
    backtestMapeBps: integer('backtest_mape_bps'),
    features: jsonb('features'),

    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('demand_forecasts_key').on(t.variantId, t.warehouseId, t.horizonDays, t.computedAt),
    index('demand_forecasts_tenant_idx').on(t.tenantId, t.computedAt),
    index('demand_forecasts_reorder_idx').on(t.tenantId, t.reorderRecommendation),
  ],
);

/** Slow-moving / dead-stock classification, refreshed nightly. */
export const inventoryHealth = pgTable(
  'inventory_health',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    variantId: uuid('variant_id').notNull(),
    /** 'healthy' | 'slow_moving' | 'dead_stock' | 'stockout_risk' | 'overstock' */
    classification: varchar('classification', { length: 24 }).notNull(),
    daysOfCover: integer('days_of_cover'),
    daysSinceLastSale: integer('days_since_last_sale'),
    unitsOnHand: integer('units_on_hand').notNull().default(0),
    /** Working capital frozen in this SKU — the number that gets attention. */
    tiedUpCapital: money('tied_up_capital'),
    currency: currency().default('AED'),
    /** Suggested markdown in basis points to clear the position. */
    suggestedMarkdownBps: integer('suggested_markdown_bps'),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('inventory_health_variant_key').on(t.variantId),
    index('inventory_health_class_idx').on(t.tenantId, t.classification),
  ],
);

/**
 * Fraud / risk assessment for an order or customer.
 *
 * Scores are advisory and always explainable — `signals` lists the individual
 * contributing rules with their weights. A model that says "risk 87" with no
 * reason cannot be appealed by the customer or defended by the merchant, and in
 * several jurisdictions an unexplained automated decision is not lawful.
 */
export const riskAssessments = pgTable(
  'risk_assessments',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    entityType: varchar('entity_type', { length: 16 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    score: smallint('score').notNull(),
    /** 'allow' | 'review' | 'require_advance_payment' | 'block' */
    decision: varchar('decision', { length: 32 }).notNull(),
    signals: jsonb('signals').notNull().default([]),
    modelVersion: varchar('model_version', { length: 32 }),
    /** Set when a human overrides — the label that trains the next model. */
    overriddenByUserId: uuid('overridden_by_user_id'),
    overrideDecision: varchar('override_decision', { length: 32 }),
    outcome: varchar('outcome', { length: 32 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('risk_assessments_entity_idx').on(t.entityType, t.entityId),
    index('risk_assessments_tenant_created_idx').on(t.tenantId, t.createdAt),
  ],
);

/**
 * Competitor price observations. Populated by scheduled scrapers/feeds with
 * explicit per-source consent configuration — scraping without checking terms
 * is a legal problem, not just a technical one, so `sourceType` distinguishes
 * an authorised feed from a public listing.
 */
export const competitorPrices = pgTable(
  'competitor_prices',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    variantId: uuid('variant_id'),
    matchedByMpn: varchar('matched_by_mpn', { length: 64 }),
    competitorName: text('competitor_name').notNull(),
    /** 'partner_feed' | 'public_listing' | 'manual_entry' */
    sourceType: varchar('source_type', { length: 24 }).notNull(),
    sourceUrl: text('source_url'),
    price: money('price').notNull(),
    currency: currency().notNull().default('AED'),
    inStock: boolean('in_stock'),
    observedAt: timestamp('observed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('competitor_prices_variant_idx').on(t.variantId, t.observedAt),
    index('competitor_prices_tenant_idx').on(t.tenantId, t.observedAt),
  ],
);

/** Price change proposals, always human-approved before taking effect. */
export const priceRecommendations = pgTable(
  'price_recommendations',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    variantId: uuid('variant_id').notNull(),
    currentPrice: money('current_price').notNull(),
    recommendedPrice: money('recommended_price').notNull(),
    currency: currency().notNull().default('AED'),
    /** Expected effect, so the merchant sees the trade-off not just a number. */
    projectedMarginBps: integer('projected_margin_bps'),
    projectedUnitsDelta: integer('projected_units_delta'),
    rationale: text('rationale'),
    signals: jsonb('signals').notNull().default({}),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    appliedByUserId: uuid('applied_by_user_id'),
    appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [index('price_recommendations_tenant_status_idx').on(t.tenantId, t.status)],
);

/**
 * Conversation memory for the shopping assistant and support bot. Retained on a
 * short TTL and scrubbed of PII before any use as evaluation data.
 */
export const assistantConversations = pgTable(
  'assistant_conversations',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    sessionId: varchar('session_id', { length: 64 }).notNull(),
    customerId: uuid('customer_id'),
    /** 'shopping' | 'support' */
    kind: varchar('kind', { length: 16 }).notNull().default('shopping'),
    /** [{role, content, toolCalls, at}] — trimmed to a rolling window. */
    messages: jsonb('messages').notNull().default([]),
    /** Escalation flag: true when the bot handed off to a human. */
    escalated: boolean('escalated').notNull().default(false),
    resultingOrderId: uuid('resulting_order_id'),
    /** −1 / 0 / +1 thumb rating, the cheapest useful quality signal we have. */
    satisfaction: smallint('satisfaction'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    index('assistant_conversations_session_idx').on(t.sessionId),
    index('assistant_conversations_tenant_idx').on(t.tenantId, t.createdAt),
  ],
);
