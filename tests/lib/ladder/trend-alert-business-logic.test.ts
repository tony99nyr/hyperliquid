import { describe, it, expect } from 'vitest';
import { buildTrendLadderPlan, trendAlertMessage, TREND_TITLE_PREFIX, type TrendAlertContext } from '@/lib/ladder/trend-alert-business-logic';

const NOW = 1_700_000_000_000;

const ctx: TrendAlertContext = {
  coin: 'ETH', mark: 2000, atrFrac: 0.04, regime: 'bullish', regimeConfidence: 0.81,
};

describe('buildTrendLadderPlan', () => {
  it('live low-qty long pyramid: mode live, long-only, momentum-confirmed core, ≤2 adds', () => {
    const p = buildTrendLadderPlan(ctx, { now: NOW });
    expect(p.mode).toBe('live'); // NEVER paper
    expect(p.author).toBe('operator');
    expect(p.title).toContain(`ETH ${TREND_TITLE_PREFIX} long`); // the dedupe + ledger tag
    expect(p.rungs.every((r) => r.side === 'long')).toBe(true); // the signal system never shorts
    const open = p.rungs.find((r) => r.action === 'open')!;
    expect(open.triggerKind).toBe('price_above');
    expect(open.triggerPx).toBeGreaterThan(ctx.mark); // confirmation entry, not a chase-down
    expect(open.triggerMeta?.momentumConfirm).toBe(true);
    const adds = p.rungs.filter((r) => r.action === 'add');
    expect(adds.length).toBeLessThanOrEqual(2); // the handoff's hard cap
    expect(p.expiresAtMs).toBe(NOW + 120 * 60 * 60 * 1000);
  });

  it('risk-first sizing: decreasing rungs summing to the campaign budget', () => {
    const p = buildTrendLadderPlan(ctx, { now: NOW, campaignRiskUsd: 10 });
    const entries = p.rungs.filter((r) => r.action === 'open' || r.action === 'add');
    const risks = entries.map((r) => r.riskUsd!);
    expect(risks.reduce((a, b) => a + b, 0)).toBeCloseTo(10, 6); // Σ = budget, not per-rung
    for (let i = 1; i < risks.length; i++) expect(risks[i]!).toBeLessThan(risks[i - 1]!); // decreasing
  });

  it('stop is ATR-derived (2×ATR) and clamped to [5%, 15%]', () => {
    const open = (a: number) => buildTrendLadderPlan({ ...ctx, atrFrac: a }, { now: NOW }).rungs.find((r) => r.action === 'open')!;
    expect(open(0.04).stopFrac).toBeCloseTo(0.08, 6); // 2×ATR
    expect(open(0.01).stopFrac).toBe(0.05); // floored — never a tight stop
    expect(open(0.2).stopFrac).toBe(0.15); // capped
    expect(open(NaN).stopFrac).toBeCloseTo(0.08, 6); // garbage ATR → the 8% fallback, still bounded
  });

  it('loss cap clears the SLIPPED no-netting worst case (10% of price slippage)', () => {
    const p = buildTrendLadderPlan(ctx, { now: NOW, campaignRiskUsd: 10 });
    const stopFrac = p.rungs.find((r) => r.action === 'open')!.stopFrac!;
    const slipped = 10 * (1 + 0.1 / stopFrac);
    expect(p.maxTotalLossUsd!).toBeGreaterThanOrEqual(slipped); // never quote the clean stop as worst case
  });

  it('exit management rides the trend: breakeven at the first add level, trail + scale-outs above', () => {
    const p = buildTrendLadderPlan(ctx, { now: NOW });
    const be = p.rungs.find((r) => r.action === 'stop_move' && r.triggerMeta?.moveTo === 'breakeven')!;
    const add1 = p.rungs.filter((r) => r.action === 'add')[0]!;
    expect(be.triggerPx).toBe(add1.triggerPx);
    const trail = p.rungs.find((r) => r.action === 'stop_move' && r.triggerMeta?.moveTo === 'trail')!;
    expect(trail.triggerMeta?.trailDistancePx).toBeGreaterThan(0);
    const reduces = p.rungs.filter((r) => r.action === 'reduce');
    expect(reduces.length).toBe(2);
    expect(reduces.every((r) => (r.reduceFrac ?? 0) > 0 && (r.reduceFrac ?? 0) < 1)).toBe(true); // path-robust fractions
  });
});

describe('trendAlertMessage', () => {
  it('carries the ladder id, coin, and the review+arm instruction', () => {
    const m = trendAlertMessage(ctx, 'abcdef1234567890');
    expect(m).toContain('abcdef12');
    expect(m).toContain('ETH');
    expect(m.toLowerCase()).toContain('review + arm');
  });
});
