import { describe, expect, it } from 'vitest';
import {
  classifyInventory,
  forecastDemand,
  recommendReplenishment,
  type DemandPoint,
} from './forecast';

function series(units: number[]): DemandPoint[] {
  return units.map((u, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    units: u,
  }));
}

describe('forecastDemand', () => {
  it('refuses to pretend confidence with too little history', () => {
    const forecast = forecastDemand(series([3, 4, 2]), 30);
    expect(forecast.method).toBe('insufficient_data');
    expect(forecast.backtestMapeBps).toBeNull();
  });

  it('picks Croston for intermittent demand', () => {
    // The phone-case pattern: mostly zeros with occasional sales.
    const forecast = forecastDemand(
      series([0, 0, 2, 0, 0, 0, 1, 0, 0, 3, 0, 0, 0, 1, 0, 0, 2, 0, 0, 0]),
      30,
    );
    expect(forecast.method).toBe('croston');
    // Must not smear the zeros into a smooth positive trend.
    expect(forecast.dailyRate).toBeGreaterThan(0);
    expect(forecast.dailyRate).toBeLessThan(1);
  });

  it('picks a smoothing method for steady demand', () => {
    const forecast = forecastDemand(series(Array.from({ length: 30 }, () => 10)), 7);
    expect(['holt', 'seasonal_naive']).toContain(forecast.method);
    expect(forecast.predictedUnits).toBeGreaterThanOrEqual(60);
    expect(forecast.predictedUnits).toBeLessThanOrEqual(80);
  });

  it('detects weekly seasonality', () => {
    // Strong weekend spike repeated over five weeks.
    const week = [2, 2, 2, 2, 12, 14, 10];
    const forecast = forecastDemand(series([...week, ...week, ...week, ...week, ...week]), 7);
    expect(forecast.method).toBe('seasonal_naive');
  });

  it('produces an interval that brackets the point estimate', () => {
    const forecast = forecastDemand(series([5, 8, 3, 9, 4, 7, 6, 5, 8, 3, 9, 4, 7, 6, 5, 8]), 14);
    expect(forecast.lowerBound).toBeLessThanOrEqual(forecast.predictedUnits);
    expect(forecast.upperBound).toBeGreaterThanOrEqual(forecast.predictedUnits);
    expect(forecast.lowerBound).toBeGreaterThanOrEqual(0);
  });

  it('never forecasts negative demand from a declining trend', () => {
    const forecast = forecastDemand(series([20, 18, 16, 14, 12, 10, 8, 6, 4, 3, 2, 1, 1, 1, 1, 1]), 30);
    expect(forecast.predictedUnits).toBeGreaterThanOrEqual(0);
    expect(forecast.dailyRate).toBeGreaterThanOrEqual(0);
  });

  it('reports a backtest error so the number can be trusted or not', () => {
    const forecast = forecastDemand(series(Array.from({ length: 40 }, () => 10)), 7);
    expect(forecast.backtestMapeBps).not.toBeNull();
    // A constant series should backtest near-perfectly.
    expect(forecast.backtestMapeBps!).toBeLessThan(500);
  });
});

describe('recommendReplenishment', () => {
  const steady = forecastDemand(series(Array.from({ length: 30 }, () => 10)), 30);

  it('does not reorder when cover comfortably exceeds the reorder point', () => {
    const advice = recommendReplenishment({
      forecast: steady,
      onHand: 500,
      incoming: 0,
      leadTimeDays: 7,
    });
    expect(advice.shouldReorder).toBe(false);
    expect(advice.recommendedQuantity).toBe(0);
  });

  it('reorders and flags urgency when cover is below half the lead time', () => {
    const advice = recommendReplenishment({
      forecast: steady,
      onHand: 20,
      incoming: 0,
      leadTimeDays: 14,
    });
    expect(advice.shouldReorder).toBe(true);
    expect(advice.urgency).toBe('urgent');
    expect(advice.recommendedQuantity).toBeGreaterThan(0);
  });

  it('counts incoming stock so a placed order is not duplicated', () => {
    const withIncoming = recommendReplenishment({
      forecast: steady,
      onHand: 20,
      incoming: 400,
      leadTimeDays: 7,
    });
    expect(withIncoming.shouldReorder).toBe(false);
  });

  it('rounds up to the supplier minimum order quantity', () => {
    const advice = recommendReplenishment({
      forecast: steady,
      onHand: 0,
      incoming: 0,
      leadTimeDays: 7,
      minOrderQuantity: 50,
    });
    expect(advice.recommendedQuantity % 50).toBe(0);
    expect(advice.recommendedQuantity).toBeGreaterThan(0);
  });

  it('holds a larger safety stock at a higher service level', () => {
    const lumpy = forecastDemand(series([0, 20, 0, 0, 15, 0, 30, 0, 0, 10, 0, 25, 0, 0, 18, 0]), 30);
    const at90 = recommendReplenishment({
      forecast: lumpy,
      onHand: 0,
      incoming: 0,
      leadTimeDays: 10,
      serviceLevel: 0.9,
    });
    const at99 = recommendReplenishment({
      forecast: lumpy,
      onHand: 0,
      incoming: 0,
      leadTimeDays: 10,
      serviceLevel: 0.99,
    });
    expect(at99.safetyStock).toBeGreaterThanOrEqual(at90.safetyStock);
  });

  it('says nothing useful is needed when demand is zero', () => {
    const dead = forecastDemand(series(Array.from({ length: 20 }, () => 0)), 30);
    const advice = recommendReplenishment({
      forecast: dead,
      onHand: 10,
      incoming: 0,
      leadTimeDays: 7,
    });
    expect(advice.shouldReorder).toBe(false);
    expect(advice.urgency).toBe('none');
  });
});

describe('classifyInventory', () => {
  it('calls a quarter without a sale dead stock and suggests a real markdown', () => {
    const result = classifyInventory({ daysOfCover: 300, daysSinceLastSale: 120, unitsOnHand: 40 });
    expect(result.classification).toBe('dead_stock');
    expect(result.suggestedMarkdownBps).toBeGreaterThanOrEqual(2000);
  });

  it('flags stockout risk before it happens', () => {
    const result = classifyInventory({ daysOfCover: 3, daysSinceLastSale: 1, unitsOnHand: 5 });
    expect(result.classification).toBe('stockout_risk');
  });

  it('flags overstock without treating it as dead', () => {
    const result = classifyInventory({ daysOfCover: 200, daysSinceLastSale: 2, unitsOnHand: 900 });
    expect(result.classification).toBe('overstock');
  });

  it('leaves healthy stock alone', () => {
    const result = classifyInventory({ daysOfCover: 30, daysSinceLastSale: 1, unitsOnHand: 100 });
    expect(result.classification).toBe('healthy');
    expect(result.suggestedMarkdownBps).toBe(0);
  });
});
