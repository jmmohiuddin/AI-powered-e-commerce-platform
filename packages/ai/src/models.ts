/**
 * MODEL REGISTRY & COST ACCOUNTING
 *
 * Every AI call in this platform is metered. In a single-merchant store an
 * unbounded LLM bill is an annoyance; in a SaaS serving thousands of merchants
 * it is an existential cost risk, because one tenant bulk-generating
 * descriptions for a 40,000-SKU catalogue can outspend the entire month's
 * subscription revenue in an afternoon.
 *
 * So pricing lives here as data, cost is computed on every call, and the
 * budget gate in ./client.ts refuses work past a tenant's ceiling.
 *
 * Prices are USD per million tokens, as published for the Claude API.
 * Cached reads bill at ~0.1× input; cache writes at ~1.25× (5-minute TTL).
 */

export type ModelId = 'claude-opus-5' | 'claude-sonnet-5' | 'claude-haiku-4-5-20251001';

export interface ModelPricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

export const MODEL_PRICING: Record<ModelId, ModelPricing> = {
  'claude-opus-5': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
  },
  'claude-sonnet-5': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
  },
  'claude-haiku-4-5-20251001': {
    inputPerMTok: 1,
    outputPerMTok: 5,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
  },
};

/**
 * Model tiers, not model names, at the call site.
 *
 * Tasks declare the *kind* of thinking they need; the merchant's configuration
 * decides which model serves that tier. That indirection is what lets a
 * high-volume merchant opt a bulk task down to a cheaper model without editing
 * any task code, and lets the platform adopt a new model release by changing
 * one mapping.
 *
 * The default for every tier is the strongest model. Downgrading is a
 * deliberate, merchant-visible cost decision — never a silent default.
 */
export type ModelTier = 'deep' | 'balanced' | 'fast';

export function resolveModel(tier: ModelTier, overrides: Partial<Record<ModelTier, string>> = {}): string {
  const configured = overrides[tier];
  if (configured) return configured;
  return 'claude-opus-5';
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
}

/**
 * Cost in micro-USD (1e-6 USD).
 *
 * Integer micro-dollars rather than floating-point dollars: individual calls
 * routinely cost fractions of a cent, and summing millions of floats to produce
 * a monthly invoice accumulates error in exactly the column a merchant checks.
 */
export function costMicroUsd(model: string, usage: TokenUsage): number {
  const pricing = MODEL_PRICING[model as ModelId] ?? MODEL_PRICING['claude-opus-5'];

  const cachedRead = usage.cacheReadInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  const freshInput = usage.inputTokens;

  const dollars =
    (freshInput * pricing.inputPerMTok) / 1_000_000 +
    // Cache reads bill at ~10% of the input rate — the reason the system prompt
    // for every AI task is written once and cached.
    (cachedRead * pricing.inputPerMTok * 0.1) / 1_000_000 +
    (cacheWrite * pricing.inputPerMTok * 1.25) / 1_000_000 +
    (usage.outputTokens * pricing.outputPerMTok) / 1_000_000;

  return Math.round(dollars * 1_000_000);
}

export function formatMicroUsd(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(4)}`;
}

/**
 * Rough token estimate for pre-flight budget checks.
 *
 * Deliberately approximate and deliberately *over*-estimating: it exists to
 * decide "is this bulk job plausibly affordable before we start", not to bill.
 * Actual accounting always uses the `usage` block the API returns. English
 * averages ~3.6 chars/token; 3.5 keeps the estimate conservative.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
