/**
 * DEMAND FORECASTING & REPLENISHMENT
 *
 * Deliberately statistics, not a language model.
 *
 * "AI inventory forecasting" is usually sold as an LLM feature. It should not
 * be one. Forecasting is a numeric problem with a measurable error metric
 * (MAPE), and a seasonal-naive or exponential-smoothing baseline beats a
 * language model at it while costing nothing per prediction and producing the
 * same answer twice. An LLM asked "how many units will I sell" produces a
 * plausible number with no error bars and no way to backtest — which is worse
 * than useless when the output becomes a purchase order.
 *
 * The LLM's real job here is downstream: explaining the forecast in the daily
 * briefing and drafting the supplier email. The numbers come from here.
 *
 * METHOD SELECTION is automatic, because retail demand is not one distribution:
 *   • Fast movers with weekly rhythm  → seasonal naive (weekday effects are
 *     strong in retail; Friday ≠ Tuesday)
 *   • Steady sellers, no seasonality  → Holt exponential smoothing with trend
 *   • Intermittent demand (most SKUs) → Croston's method
 *
 * That last case is the one generic forecasters get wrong and it is the
 * majority of an electronics catalogue: a specific phone case sells 0,0,0,2,0,
 * 0,1,0. Fitting a trend line to that predicts a smooth 0.4 units/day and
 * orders accordingly; Croston separates "how big is a sale when it happens"
 * from "how often does one happen", which is the question actually being asked.
 */

export interface DemandPoint {
  /** ISO date (YYYY-MM-DD). */
  readonly date: string;
  readonly units: number;
}

export type ForecastMethod = 'seasonal_naive' | 'holt' | 'croston' | 'insufficient_data';

export interface Forecast {
  readonly method: ForecastMethod;
  readonly horizonDays: number;
  readonly predictedUnits: number;
  /** 80% prediction interval. A point estimate alone is not decision-grade. */
  readonly lowerBound: number;
  readonly upperBound: number;
  /** Backtested mean absolute percentage error, in basis points. */
  readonly backtestMapeBps: number | null;
  readonly dailyRate: number;
}

const MIN_HISTORY_DAYS = 14;

export function forecastDemand(history: readonly DemandPoint[], horizonDays: number): Forecast {
  const series = [...history].sort((a, b) => a.date.localeCompare(b.date)).map((p) => p.units);

  if (series.length < MIN_HISTORY_DAYS) {
    // Not enough signal to forecast honestly. Returning a confident number from
    // five data points is how a system loses a merchant's trust permanently.
    const mean = series.length ? series.reduce((a, b) => a + b, 0) / series.length : 0;
    return {
      method: 'insufficient_data',
      horizonDays,
      predictedUnits: Math.round(mean * horizonDays),
      lowerBound: 0,
      upperBound: Math.round(mean * horizonDays * 2),
      backtestMapeBps: null,
      dailyRate: mean,
    };
  }

  const method = selectMethod(series);
  const dailyRate =
    method === 'croston'
      ? crostonRate(series)
      : method === 'seasonal_naive'
        ? seasonalNaiveRate(series)
        : holtRate(series);

  const predicted = Math.max(0, dailyRate * horizonDays);
  // Interval from residual dispersion rather than a fixed percentage: a steady
  // seller and a lumpy one need very different safety margins.
  const sigma = residualStdDev(series, dailyRate);
  const margin = 1.28 * sigma * Math.sqrt(horizonDays); // 80% two-sided

  return {
    method,
    horizonDays,
    predictedUnits: Math.round(predicted),
    lowerBound: Math.max(0, Math.round(predicted - margin)),
    upperBound: Math.round(predicted + margin),
    backtestMapeBps: backtest(series, method),
    dailyRate,
  };
}

/**
 * Intermittency ratio decides the method. More than ~30% zero days means the
 * series is intermittent and the smoothing methods will mislead.
 */
function selectMethod(series: readonly number[]): ForecastMethod {
  const zeroFraction = series.filter((v) => v === 0).length / series.length;
  if (zeroFraction > 0.3) return 'croston';
  if (series.length >= 28 && hasWeeklySeasonality(series)) return 'seasonal_naive';
  return 'holt';
}

/**
 * Weekly seasonality test: compare within-weekday variance against overall
 * variance. If knowing the weekday explains a meaningful share of the variance,
 * the series has a weekly rhythm worth modelling.
 */
function hasWeeklySeasonality(series: readonly number[]): boolean {
  const overallMean = mean(series);
  const overallVar = variance(series, overallMean);
  if (overallVar === 0) return false;

  const buckets: number[][] = Array.from({ length: 7 }, () => []);
  series.forEach((value, i) => buckets[i % 7]!.push(value));

  const withinVar =
    buckets.reduce((acc, bucket) => {
      if (bucket.length < 2) return acc;
      return acc + variance(bucket, mean(bucket)) * bucket.length;
    }, 0) / series.length;

  // Weekday explains >25% of variance.
  return 1 - withinVar / overallVar > 0.25;
}

function seasonalNaiveRate(series: readonly number[]): number {
  // Average of the same weekday over the trailing four weeks, then averaged
  // across weekdays to get a daily rate.
  const weeks = Math.min(4, Math.floor(series.length / 7));
  const recent = series.slice(-weeks * 7);
  return mean(recent);
}

/** Holt's linear trend: level + trend, both exponentially smoothed. */
function holtRate(series: readonly number[], alpha = 0.3, beta = 0.1): number {
  let level = series[0]!;
  let trend = series.length > 1 ? series[1]! - series[0]! : 0;

  for (let i = 1; i < series.length; i += 1) {
    const previousLevel = level;
    level = alpha * series[i]! + (1 - alpha) * (level + trend);
    trend = beta * (level - previousLevel) + (1 - beta) * trend;
  }
  // Trend is damped: extrapolating an unconstrained trend across a 30-day
  // horizon is how forecasts order 400 units of a phone case.
  return Math.max(0, level + trend * 0.5);
}

/**
 * Croston's method for intermittent demand.
 *
 * Smooths two series separately — the size of a non-zero demand, and the
 * interval between non-zero demands — then divides. The result is a demand
 * *rate* that does not pretend the zeros are small sales.
 */
function crostonRate(series: readonly number[], alpha = 0.2): number {
  const nonZeroIndices: number[] = [];
  series.forEach((value, i) => {
    if (value > 0) nonZeroIndices.push(i);
  });
  if (nonZeroIndices.length === 0) return 0;
  if (nonZeroIndices.length === 1) return series[nonZeroIndices[0]!]! / series.length;

  let size = series[nonZeroIndices[0]!]!;
  let interval = nonZeroIndices[0]! + 1;

  for (let i = 1; i < nonZeroIndices.length; i += 1) {
    const index = nonZeroIndices[i]!;
    size = alpha * series[index]! + (1 - alpha) * size;
    interval = alpha * (index - nonZeroIndices[i - 1]!) + (1 - alpha) * interval;
  }

  return interval > 0 ? size / interval : 0;
}

function residualStdDev(series: readonly number[], rate: number): number {
  const residuals = series.map((v) => v - rate);
  return Math.sqrt(variance(residuals, mean(residuals)));
}

/**
 * Walk-forward backtest over the final 25% of history. Reported so a merchant
 * can see how much to trust the number — an unvalidated forecast is a guess
 * wearing a lab coat.
 */
function backtest(series: readonly number[], method: ForecastMethod): number | null {
  const holdout = Math.floor(series.length * 0.25);
  if (holdout < 3) return null;

  const trainEnd = series.length - holdout;
  let errorSum = 0;
  let counted = 0;

  for (let i = trainEnd; i < series.length; i += 1) {
    const train = series.slice(0, i);
    const predicted =
      method === 'croston'
        ? crostonRate(train)
        : method === 'seasonal_naive'
          ? seasonalNaiveRate(train)
          : holtRate(train);
    const actual = series[i]!;
    // Skip zero actuals: percentage error is undefined against zero, and
    // including them as 100% error makes intermittent series look terrible
    // regardless of how good the rate estimate is.
    if (actual === 0) continue;
    errorSum += Math.abs(actual - predicted) / actual;
    counted += 1;
  }

  return counted === 0 ? null : Math.round((errorSum / counted) * 10_000);
}

/* ────────────────────────── Replenishment ───────────────────────────── */

export interface ReplenishmentInput {
  readonly forecast: Forecast;
  readonly onHand: number;
  readonly incoming: number;
  readonly leadTimeDays: number;
  /** Days of stock to hold beyond lead-time demand. */
  readonly reviewPeriodDays?: number;
  readonly minOrderQuantity?: number;
  /** 0.90 / 0.95 / 0.99 — how often you intend not to stock out. */
  readonly serviceLevel?: number;
}

export interface ReplenishmentAdvice {
  readonly shouldReorder: boolean;
  readonly recommendedQuantity: number;
  readonly reorderPoint: number;
  readonly safetyStock: number;
  readonly daysOfCover: number;
  readonly urgency: 'none' | 'plan' | 'soon' | 'urgent';
  readonly rationale: string;
}

const Z_SCORES: Record<string, number> = { '0.9': 1.28, '0.95': 1.65, '0.99': 2.33 };

/**
 * Classic (s, S) replenishment with a service-level-driven safety stock.
 *
 * The safety-stock term is where forecast *uncertainty* earns its keep: two
 * SKUs with the same average demand but different volatility need different
 * buffers, and a system that ignores that either stocks out on the lumpy one or
 * ties up capital on the steady one.
 */
export function recommendReplenishment(input: ReplenishmentInput): ReplenishmentAdvice {
  const {
    forecast,
    onHand,
    incoming,
    leadTimeDays,
    reviewPeriodDays = 7,
    minOrderQuantity = 1,
    serviceLevel = 0.95,
  } = input;

  const z = Z_SCORES[String(serviceLevel)] ?? 1.65;
  const available = onHand + incoming;
  const daily = forecast.dailyRate;

  if (daily <= 0) {
    return {
      shouldReorder: false,
      recommendedQuantity: 0,
      reorderPoint: 0,
      safetyStock: 0,
      daysOfCover: available > 0 ? Number.POSITIVE_INFINITY : 0,
      urgency: 'none',
      rationale: 'No demand recorded in the forecast window.',
    };
  }

  // Demand variability over the protection period, derived from the forecast's
  // own interval rather than assumed.
  const intervalWidth = Math.max(0, forecast.upperBound - forecast.predictedUnits);
  const sigmaDaily = forecast.horizonDays > 0 ? intervalWidth / (1.28 * Math.sqrt(forecast.horizonDays)) : 0;
  const protectionDays = leadTimeDays + reviewPeriodDays;

  const safetyStock = Math.ceil(z * sigmaDaily * Math.sqrt(protectionDays));
  const reorderPoint = Math.ceil(daily * leadTimeDays + safetyStock);
  const targetLevel = Math.ceil(daily * protectionDays + safetyStock);

  const daysOfCover = available / daily;
  const shouldReorder = available <= reorderPoint;
  const rawQuantity = Math.max(0, targetLevel - available);
  const recommendedQuantity = shouldReorder
    ? Math.max(minOrderQuantity, Math.ceil(rawQuantity / minOrderQuantity) * minOrderQuantity)
    : 0;

  const urgency: ReplenishmentAdvice['urgency'] = !shouldReorder
    ? 'plan'
    : daysOfCover <= leadTimeDays * 0.5
      ? 'urgent'
      : daysOfCover <= leadTimeDays
        ? 'soon'
        : 'plan';

  return {
    shouldReorder,
    recommendedQuantity,
    reorderPoint,
    safetyStock,
    daysOfCover: Math.round(daysOfCover * 10) / 10,
    urgency,
    rationale: shouldReorder
      ? `${available} available covers ${daysOfCover.toFixed(1)} days against a ${leadTimeDays}-day lead time; reorder point is ${reorderPoint}.`
      : `${available} available covers ${daysOfCover.toFixed(1)} days, above the reorder point of ${reorderPoint}.`,
  };
}

/* ──────────────────────── Inventory health ──────────────────────────── */

export type InventoryClassification =
  | 'healthy'
  | 'stockout_risk'
  | 'overstock'
  | 'slow_moving'
  | 'dead_stock';

export function classifyInventory(input: {
  daysOfCover: number;
  daysSinceLastSale: number | null;
  unitsOnHand: number;
}): { classification: InventoryClassification; suggestedMarkdownBps: number } {
  const { daysOfCover, daysSinceLastSale, unitsOnHand } = input;

  if (unitsOnHand <= 0) return { classification: 'stockout_risk', suggestedMarkdownBps: 0 };

  // In electronics, stock that has not moved in a quarter is not slow — it is
  // depreciating. Handsets lose value every time a successor launches, so
  // holding out for full margin costs more than the discount would.
  if (daysSinceLastSale != null && daysSinceLastSale >= 90) {
    return { classification: 'dead_stock', suggestedMarkdownBps: 3000 };
  }
  if (daysSinceLastSale != null && daysSinceLastSale >= 45) {
    return { classification: 'slow_moving', suggestedMarkdownBps: 1500 };
  }
  if (daysOfCover < 7) return { classification: 'stockout_risk', suggestedMarkdownBps: 0 };
  if (daysOfCover > 120) return { classification: 'overstock', suggestedMarkdownBps: 1000 };
  return { classification: 'healthy', suggestedMarkdownBps: 0 };
}

/* ───────────────────────────── Helpers ──────────────────────────────── */

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function variance(values: readonly number[], m: number): number {
  return values.length ? values.reduce((acc, v) => acc + (v - m) ** 2, 0) / values.length : 0;
}
