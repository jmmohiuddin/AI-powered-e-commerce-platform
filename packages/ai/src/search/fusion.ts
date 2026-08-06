/**
 * HYBRID SEARCH FUSION
 *
 * Product search has two failure modes that pull in opposite directions:
 *
 *   • Pure keyword search (BM25 / tsvector) nails exact model numbers —
 *     "SM-S928B", "A2846", "iPhone 15 Pro Max 256GB" — and returns nothing at
 *     all for "phone with a good camera under 40k".
 *   • Pure vector search understands intent but is embarrassing on identifiers:
 *     ask for the S24 Ultra and it will happily rank the S23 Ultra first,
 *     because they are semantically almost identical and lexically distinct.
 *
 * Electronics retail needs both, because both query shapes are common: shoppers
 * arrive either knowing the exact model or knowing only the job to be done.
 *
 * RECIPROCAL RANK FUSION merges the two ranked lists without needing their
 * scores to be comparable — and BM25 scores and cosine similarities are not
 * comparable, which is why score-normalisation approaches (min-max, z-score)
 * are brittle: a single outlier in either list distorts the whole blend.
 * RRF uses only *rank position*, so it is immune to that entirely.
 *
 *     score(d) = Σ over lists  weight_l / (k + rank_l(d))
 *
 * `k` (conventionally 60) damps the influence of the very top positions so a
 * document ranked #1 by one retriever cannot single-handedly win; a document
 * ranked well by *both* retrievers beats one ranked first by either alone.
 * That is precisely the behaviour we want: agreement between a lexical and a
 * semantic signal is strong evidence of relevance.
 *
 * Pure functions, no I/O — the SQL that produces the input lists lives in
 * ./query.ts, and this fusion logic is unit-tested without a database.
 */

export interface RankedResult {
  readonly id: string;
  readonly score: number;
}

export interface FusionInput {
  readonly results: readonly RankedResult[];
  /** Relative influence of this retriever. Defaults to 1. */
  readonly weight?: number;
  readonly label: string;
}

export interface FusedResult {
  readonly id: string;
  readonly score: number;
  /** Which retrievers found it, and at what rank. Drives search diagnostics. */
  readonly sources: ReadonlyArray<{ label: string; rank: number }>;
}

export interface FusionOptions {
  /** Rank-damping constant. 60 is the value from the original RRF paper. */
  readonly k?: number;
  readonly limit?: number;
}

export function reciprocalRankFusion(
  inputs: readonly FusionInput[],
  options: FusionOptions = {},
): FusedResult[] {
  const { k = 60, limit } = options;

  const scores = new Map<string, number>();
  const sources = new Map<string, Array<{ label: string; rank: number }>>();

  for (const input of inputs) {
    const weight = input.weight ?? 1;
    input.results.forEach((result, index) => {
      const rank = index + 1;
      scores.set(result.id, (scores.get(result.id) ?? 0) + weight / (k + rank));
      const existing = sources.get(result.id);
      if (existing) existing.push({ label: input.label, rank });
      else sources.set(result.id, [{ label: input.label, rank }]);
    });
  }

  const fused = [...scores.entries()]
    .map(([id, score]) => ({ id, score, sources: sources.get(id) ?? [] }))
    // Ties break on id so results are stable across identical queries —
    // a search page whose order flickers on refresh reads as broken.
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  return limit ? fused.slice(0, limit) : fused;
}

/**
 * Merchandising boosts, applied *after* fusion.
 *
 * Kept separate from relevance on purpose. Relevance answers "does this match
 * the query"; merchandising answers "which of the matches should we show
 * first". Folding a margin boost into the relevance score makes both
 * untunable and produces the failure everyone has experienced: searching for a
 * specific product and being shown something more profitable instead.
 *
 * Multiplicative and bounded, so a boost can reorder near-ties but cannot drag
 * an irrelevant product to the top of a specific-model search.
 */
export interface BoostSignals {
  readonly inStock?: boolean;
  readonly isFeatured?: boolean;
  /** 0–500, i.e. 4.5★ = 450. */
  readonly ratingAverage?: number | null;
  readonly ratingCount?: number;
  /** Units sold in the trailing window; drives popularity. */
  readonly recentSales?: number;
  readonly marginBps?: number | null;
}

export interface BoostWeights {
  readonly outOfStockPenalty?: number;
  readonly featuredBoost?: number;
  readonly maxRatingBoost?: number;
  readonly maxPopularityBoost?: number;
  readonly maxMarginBoost?: number;
}

export function applyBoosts(
  results: readonly FusedResult[],
  signals: ReadonlyMap<string, BoostSignals>,
  weights: BoostWeights = {},
): FusedResult[] {
  const {
    // Out-of-stock products are demoted, not hidden. Hiding them loses the
    // "notify me when back in stock" signal and makes the catalogue look
    // thinner than it is — but showing them above buyable stock wastes the
    // click.
    outOfStockPenalty = 0.45,
    featuredBoost = 1.15,
    maxRatingBoost = 1.12,
    maxPopularityBoost = 1.2,
    maxMarginBoost = 1.05,
  } = weights;

  return results
    .map((result) => {
      const signal = signals.get(result.id);
      if (!signal) return result;

      let multiplier = 1;
      if (signal.inStock === false) multiplier *= outOfStockPenalty;
      if (signal.isFeatured) multiplier *= featuredBoost;

      // Ratings only count once there are enough of them. Five 5★ reviews are
      // noise, and rewarding them is an open invitation to review fraud.
      if (signal.ratingAverage != null && (signal.ratingCount ?? 0) >= 5) {
        const normalised = Math.min(1, Math.max(0, (signal.ratingAverage - 300) / 200));
        multiplier *= 1 + (maxRatingBoost - 1) * normalised;
      }

      if (signal.recentSales && signal.recentSales > 0) {
        // Logarithmic: the difference between 0 and 10 sales is meaningful,
        // between 500 and 510 is not.
        const popularity = Math.min(1, Math.log10(1 + signal.recentSales) / 3);
        multiplier *= 1 + (maxPopularityBoost - 1) * popularity;
      }

      if (signal.marginBps != null && signal.marginBps > 0) {
        const normalised = Math.min(1, signal.marginBps / 4000);
        multiplier *= 1 + (maxMarginBoost - 1) * normalised;
      }

      return { ...result, score: result.score * multiplier };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/**
 * Query intent classification.
 *
 * Decides how much to trust each retriever *before* fusing. A query that is
 * obviously a model number or SKU should be answered lexically; loading it up
 * with semantic neighbours actively hurts. A natural-language question is the
 * reverse. Cheap heuristics beat a model call here — this runs on every
 * keystroke of type-ahead, where a 300 ms LLM round trip is not available.
 */
export type QueryIntent = 'identifier' | 'navigational' | 'exploratory';

export function classifyQuery(query: string): {
  intent: QueryIntent;
  lexicalWeight: number;
  semanticWeight: number;
} {
  const trimmed = query.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);

  // SKU / IMEI / model codes are a *single* token that mixes letters and
  // digits ("SM-S928B", "A2846"), or a long bare digit run (an IMEI).
  // Requiring a single token is what keeps "redmi note 13" out of this branch —
  // it contains a number but is a product name, not a part number.
  const isSingleToken = words.length === 1;
  const digitCount = (trimmed.match(/\d/g) ?? []).length;
  const looksLikeIdentifier =
    isSingleToken &&
    (/^\d{8,}$/.test(trimmed) ||
      (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed) && /[A-Za-z]/.test(trimmed) && digitCount >= 2));

  if (looksLikeIdentifier) {
    return { intent: 'identifier', lexicalWeight: 1, semanticWeight: 0.1 };
  }

  // Questions and descriptive phrases: intent, not a name.
  const isNaturalLanguage =
    words.length >= 5 ||
    /\b(best|good|cheap|under|for|with|that|which|does|can|how|what|vs|compare)\b/i.test(trimmed);

  if (isNaturalLanguage) {
    return { intent: 'exploratory', lexicalWeight: 0.4, semanticWeight: 1 };
  }

  // Short brand/model phrases — "redmi note 13", "usb c cable". Both signals
  // contribute, lexical slightly ahead.
  return { intent: 'navigational', lexicalWeight: 1, semanticWeight: 0.7 };
}
