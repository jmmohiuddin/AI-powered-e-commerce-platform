import type { Metadata } from 'next';
import { formatPrice } from '@voltix/ui';
import { requirePermission, tenantContextFor } from '../../lib/auth';
import { analyseInventory } from '../../lib/inventory';

export const metadata: Metadata = { title: 'Inventory' };
export const dynamic = 'force-dynamic';

const HEALTH_PILL: Record<string, string> = {
  healthy: 'pill--success',
  stockout_risk: 'pill--danger',
  overstock: 'pill--warn',
  slow_moving: 'pill--warn',
  dead_stock: 'pill--danger',
};

/**
 * Inventory screen.
 *
 * The columns are chosen to answer "what do I order and when", in that order —
 * days of cover before quantity on hand, because cover is the decision-relevant
 * number and a raw count is not (40 units is comfortable for one SKU and a
 * crisis for another).
 *
 * The forecast method and its backtested error are shown rather than hidden.
 * A merchant asked to spend real money on a purchase order deserves to know
 * whether the number came from a seasonal pattern with 8% historical error or
 * from a sparse intermittent series with 60% — and to override it either way.
 * Every recommendation on this page is a draft; nothing orders itself.
 */
export default async function InventoryPage() {
  const session = await requirePermission('inventory:read');
  const ctx = tenantContextFor(session);
  const rows = await analyseInventory(session.tenantId);
  const totalCapital = rows.reduce((sum, r) => sum + r.tiedUpCapital, 0);
  const atRisk = rows.filter((r) => r.advice.shouldReorder);
  const frozen = rows
    .filter((r) => r.health.classification === 'dead_stock' || r.health.classification === 'slow_moving')
    .reduce((sum, r) => sum + r.tiedUpCapital, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Inventory</h1>
          <p>Forecasts and reorder points computed from 90 days of real sales history.</p>
        </div>
      </div>

      <div className="kpi-grid">
        <div className="card">
          <p className="kpi__label">Stock at cost</p>
          <p className="kpi__value">{formatPrice(totalCapital, ctx.currency)}</p>
          <p className="kpi__note">across {rows.length} tracked SKUs</p>
        </div>
        <div className="card">
          <p className="kpi__label">Needs reordering</p>
          <p className="kpi__value">{atRisk.length}</p>
          <p className="kpi__note">below the calculated reorder point</p>
        </div>
        <div className="card">
          <p className="kpi__label">Capital not moving</p>
          <p className="kpi__value">{formatPrice(frozen, ctx.currency)}</p>
          <p className="kpi__note">slow-moving and dead stock</p>
        </div>
      </div>

      <div className="banner">
        Every quantity below is a recommendation, not an order. Purchase orders are created by a
        person, from this screen, after review.
      </div>

      {rows.length === 0 ? (
        <div className="card">
          <p className="muted">
            No tracked variants yet. Products with inventory tracking enabled appear here once the
            catalogue is loaded — run <code>npm run db:seed</code> for a sample UAE catalogue.
          </p>
        </div>
      ) : (
      <div className="card table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Status</th>
              <th className="numeric">Cover</th>
              <th className="numeric">On hand</th>
              <th className="numeric">Incoming</th>
              <th className="numeric">Reorder at</th>
              <th className="numeric">Suggested order</th>
              <th>Forecast</th>
              <th className="numeric">Margin</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const { forecast, advice, health, marginBps } = row;
              return (
              <tr key={row.variantId}>
                <td>
                  <div className="cell-title">{row.title}</div>
                  <div className="kpi__note">{row.sku}</div>
                </td>
                <td>
                  <span className={`pill ${HEALTH_PILL[health.classification] ?? 'pill--neutral'}`}>
                    {health.classification.replace('_', ' ')}
                  </span>
                  {health.suggestedMarkdownBps > 0 && (
                    <div className="kpi__note">
                      suggest −{(health.suggestedMarkdownBps / 100).toFixed(0)}%
                    </div>
                  )}
                </td>
                <td className="numeric">
                  {Number.isFinite(advice.daysOfCover) ? `${advice.daysOfCover}d` : '—'}
                  <div className="kpi__note">{row.leadTimeDays}d lead</div>
                </td>
                <td className="numeric">{row.onHand}</td>
                <td className="numeric">{row.incoming || '—'}</td>
                <td className="numeric">
                  {advice.reorderPoint}
                  <div className="kpi__note">+{advice.safetyStock} safety</div>
                </td>
                <td className="numeric">
                  {advice.shouldReorder ? (
                    <span
                      className={`pill ${advice.urgency === 'urgent' ? 'pill--danger' : 'pill--warn'}`}
                    >
                      {advice.recommendedQuantity} · {advice.urgency}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <div>{forecast.method.replace('_', ' ')}</div>
                  <div className="kpi__note">
                    {forecast.predictedUnits}/30d
                    {forecast.backtestMapeBps != null &&
                      ` · ±${(forecast.backtestMapeBps / 100).toFixed(0)}% error`}
                  </div>
                </td>
                {/* An em dash where cost is unknown. A margin computed against
                    a missing cost reads as 100% and is worse than a blank. */}
                <td className="numeric">
                  {marginBps === null ? <span className="muted">—</span> : `${(marginBps / 100).toFixed(1)}%`}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}

      <h2 className="section-title">How these numbers are produced</h2>
      <div className="card stack-md">
        <p className="muted">
          Demand is forecast per SKU by an estimator chosen from the shape of its own sales history:
          Croston&rsquo;s method for intermittent demand (most accessories), seasonal naive where a
          weekly rhythm is detectable, and Holt&rsquo;s exponential smoothing otherwise. Each
          forecast is walk-forward backtested against the last quarter of its history, and that
          error is shown next to the number.
        </p>
        <p className="muted">
          Safety stock is derived from each SKU&rsquo;s own demand variability at a 95% service
          level, not a flat percentage — two products selling ten a week need different buffers if
          one sells two a day and the other sells ten on Friday.
        </p>
        <p className="muted">
          No language model is involved in any number on this page. Forecasting has a measurable
          error metric and a statistical baseline that beats an LLM at it for free; the language
          model&rsquo;s job is explaining these figures in the daily briefing and drafting the
          supplier email, not producing them.
        </p>
      </div>
    </>
  );
}
