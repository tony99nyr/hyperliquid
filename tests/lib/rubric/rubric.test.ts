/**
 * Pins the PURE rubric engine: scorers, gates, the composer (gates → regime
 * MULTIPLIER → additive envelope → NO-TRADE), the portfolio crypto-beta cap, the
 * position-review classifier, and per-coin config resolution. Fixture-driven, no
 * mocks. The keystone assertions: a hostile regime CRUSHES a high envelope (not
 * averages it), NO-TRADE is first-class, and the same inputs are deterministic.
 */

import { describe, it, expect } from 'vitest';
import type { HealthTimeframe, HealthResult } from '@/lib/health/health-engine-types';
import type { MarketRegimeSignal } from '@/lib/strategy/analysis/market-regime-detector-cached';
import type { L2Book } from '@/lib/hyperliquid/orderbook-match';
import type { RubricConfig } from '@/lib/rubric/rubric-config-types';
import type { RubricInputs, Side } from '@/lib/rubric/rubric-types';
import { loadRubricConfig, resolveCoinConfig, deepMerge } from '@/lib/rubric/rubric-config';
import {
  freshness, aggregateLeaderConsensus, scoreLeadersPillar, scoreCarryPillar,
  scoreBookImbalance, scoreMicroPillar, scoreRegimePillar, regimeMultiplier, fundingApr,
} from '@/lib/rubric/rubric-scorers-business-logic';
import { deriveLevels, againstConfirmedHtf, evaluateGates, firstFailingGate } from '@/lib/rubric/rubric-gates-business-logic';
import { computeRubric } from '@/lib/rubric/rubric-composer-business-logic';
import { directionExposure, applyPortfolioCaps } from '@/lib/rubric/rubric-portfolio-business-logic';
import { reviewPosition } from '@/lib/rubric/rubric-position-review-business-logic';
import { rubricInputsHash, buildRubricScoreRows } from '@/lib/rubric/rubric-rows-business-logic';

const CFG: RubricConfig = loadRubricConfig();

function reg(regime: 'bullish' | 'bearish' | 'neutral', confidence = 0.8): MarketRegimeSignal {
  return { regime, confidence, indicators: { trend: 0, momentum: 0, volatility: 0.3 } } as MarketRegimeSignal;
}
function tfAll(regime: 'bullish' | 'bearish' | 'neutral', conf = 0.8): Partial<Record<HealthTimeframe, MarketRegimeSignal>> {
  return { '1d': reg(regime, conf), '8h': reg(regime, conf), '1h': reg(regime, conf), '15m': reg(regime, conf) };
}
/** Deep, balanced book around `mid` with `notionalPerSide` each side. */
function book(mid: number, bidNotional: number, askNotional: number): L2Book {
  const bidSz = bidNotional / mid;
  const askSz = askNotional / mid;
  return { coin: 'ETH', bids: [{ px: mid - 0.5, sz: bidSz }], asks: [{ px: mid + 0.5, sz: askSz }] };
}
function inputs(over: Partial<RubricInputs> = {}): RubricInputs {
  return {
    coin: 'ETH', asOf: 1_000, markPx: 1700, atr: 20,
    regimeByTf: tfAll('neutral'), atrPctile: 0.6, bbBandwidthPctile: 0.6,
    book: book(1700, 5_000_000, 5_000_000),
  takerFlow: null,
    consensus: { coin: 'ETH', net: 0, longCount: 0, shortCount: 0, topN: 0 },
    ctx: null,
    ...over,
  };
}

describe('scorers — freshness / consensus / carry', () => {
  it('freshness decays exp(−dt/τ)', () => {
    expect(freshness(0, 12)).toBeCloseTo(1, 6);
    expect(freshness(12, 12)).toBeCloseTo(Math.exp(-1), 6);
  });
  it('aggregateLeaderConsensus signs net + counts, respects topN', () => {
    const c = aggregateLeaderConsensus('ETH', [
      { side: 'short', conviction: 2, freshnessHours: 0, cleanBook: true },
      { side: 'short', conviction: 1, freshnessHours: 0, cleanBook: true },
      { side: 'long', conviction: 0.5, freshnessHours: 0, cleanBook: true },
    ], CFG);
    expect(c.net).toBeLessThan(0); // net short
    expect(c.shortCount).toBe(2);
    expect(c.longCount).toBe(1);
  });
  it('leaders pillar: net short → high for short, low for long', () => {
    const c = { coin: 'ETH', net: -3, longCount: 0, shortCount: 3, topN: 3 };
    expect(scoreLeadersPillar(c, 'short', CFG)).toBeGreaterThan(80);
    expect(scoreLeadersPillar(c, 'long', CFG)).toBeLessThan(20);
  });
  it('carry: +funding credits SHORT, penalizes LONG; null → neutral 50', () => {
    const ctx = { coin: 'ETH', fundingHourly: 0.0000125, openInterest: 0, premium: 0, markPx: 1700, oraclePx: 1700 };
    expect(fundingApr(0.0000125)).toBeCloseTo(10.95, 1);
    expect(scoreCarryPillar(ctx, 'short', CFG)).toBeGreaterThan(50);
    expect(scoreCarryPillar(ctx, 'long', CFG)).toBeLessThan(50);
    expect(scoreCarryPillar(null, 'long', CFG)).toBe(50);
  });
});

describe('scorers — microstructure', () => {
  it('bid-heavy book → positive imbalance → favors long', () => {
    const { imbalance } = scoreBookImbalance(book(1700, 8_000_000, 2_000_000), 0.01);
    expect(imbalance).toBeGreaterThan(0);
    expect(scoreMicroPillar(book(1700, 8_000_000, 2_000_000), 'long', CFG)).toBeGreaterThan(50);
    expect(scoreMicroPillar(book(1700, 8_000_000, 2_000_000), 'short', CFG)).toBeLessThan(50);
  });
});

describe('scorers — regime pillar + multiplier (the crush)', () => {
  it('aligned regime → pillar high + multiplier ~1', () => {
    expect(scoreRegimePillar(tfAll('bearish'), 'short')).toBeGreaterThan(85);
    expect(regimeMultiplier(tfAll('bearish'), 'short', CFG)).toBeGreaterThan(0.9);
  });
  it('opposed regime → pillar low + multiplier near floor', () => {
    expect(scoreRegimePillar(tfAll('bullish'), 'short')).toBeLessThan(15);
    expect(regimeMultiplier(tfAll('bullish'), 'short', CFG)).toBeLessThan(0.25);
  });
  it('neutral → midpoint', () => {
    expect(scoreRegimePillar(tfAll('neutral'), 'long')).toBe(50);
  });
});

describe('gates + levels', () => {
  it('deriveLevels: long stop below / target above; short inverted; roomToTarget = target/stop mult', () => {
    const L = deriveLevels(1700, 20, 'long', CFG);
    expect(L.invalidation).toBeLessThan(1700);
    expect(L.target).toBeGreaterThan(1700);
    expect(L.roomToTarget).toBeCloseTo(CFG.levels.targetAtrMult / CFG.levels.stopAtrMult, 6);
    const S = deriveLevels(1700, 20, 'short', CFG);
    expect(S.invalidation).toBeGreaterThan(1700);
    expect(S.target).toBeLessThan(1700);
  });
  it('againstConfirmedHtf: both 8h+1d confirmed opposed → true; one neutral → false', () => {
    expect(againstConfirmedHtf(tfAll('bullish'), 'short', CFG)).toBe(true);
    expect(againstConfirmedHtf({ '8h': reg('bullish'), '1d': reg('neutral') }, 'short', CFG)).toBe(false);
    expect(againstConfirmedHtf({ '8h': reg('bullish', 0.4), '1d': reg('bullish', 0.4) }, 'short', CFG)).toBe(false); // low conf
  });
  it('evaluateGates: thin book / vol-contraction fire; firstFailingGate order', () => {
    const thin = evaluateGates(inputs({ book: book(1700, 1000, 1000) }), deriveLevels(1700, 20, 'long', CFG), 'long', CFG);
    expect(thin.bookTooThin).toBe(true);
    expect(firstFailingGate(thin)).toBe('book-too-thin');
    const chop = evaluateGates(inputs({ atrPctile: 0.1, bbBandwidthPctile: 0.1 }), deriveLevels(1700, 20, 'long', CFG), 'long', CFG);
    expect(chop.volContraction).toBe(true);
  });

  it('leader-derisk veto: OFF by default; when enabled vetoes LONG only above threshold', () => {
    const lvl = deriveLevels(1700, 20, 'long', CFG);
    // Default config: veto disabled → never fires even at high de-risk.
    expect(evaluateGates(inputs({ derisk: 0.95 }), lvl, 'long', CFG).leaderDeriskVeto).toBe(false);

    const onCfg = deepMerge(CFG, { gates: { leaderDeriskVeto: { enabled: true, threshold: 0.7 } } }) as RubricConfig;
    // Enabled + LONG + de-risk above threshold → veto fires (the kill reason).
    const vetoed = evaluateGates(inputs({ derisk: 0.95 }), lvl, 'long', onCfg);
    expect(vetoed.leaderDeriskVeto).toBe(true);
    expect(firstFailingGate(vetoed)).toBe('leader-derisk-veto');
    // Below threshold → no veto.
    expect(evaluateGates(inputs({ derisk: 0.5 }), lvl, 'long', onCfg).leaderDeriskVeto).toBe(false);
    // SHORT is never vetoed (risk-off helps shorts).
    expect(evaluateGates(inputs({ derisk: 0.95 }), deriveLevels(1700, 20, 'short', CFG), 'short', onCfg).leaderDeriskVeto).toBe(false);
  });
});

describe('composer — the keystone', () => {
  it('hostile regime CRUSHES a high envelope (not averages it)', () => {
    // Great leaders + carry + micro for SHORT, but regime confirmed BULLISH (opposed).
    const inp = inputs({
      regimeByTf: tfAll('bullish'),
      consensus: { coin: 'ETH', net: -5, longCount: 0, shortCount: 5, topN: 5 },
      ctx: { coin: 'ETH', fundingHourly: 0.0000125, openInterest: 0, premium: 0, markPx: 1700, oraclePx: 1700 },
      book: book(1700, 2_000_000, 8_000_000), // ask-heavy → favors short micro
    });
    const r = computeRubric(inp, CFG);
    // short is GATED (against-confirmed-htf) OR crushed; either way it is NOT a GO.
    expect(r.short.opportunity).toBeLessThan(40);
    expect(r.badge).not.toBe('GO');
  });

  it('everything aligned for SHORT in a bearish regime → GO short', () => {
    const inp = inputs({
      regimeByTf: tfAll('bearish'),
      consensus: { coin: 'ETH', net: -5, longCount: 0, shortCount: 5, topN: 5 },
      ctx: { coin: 'ETH', fundingHourly: 0.0000125, openInterest: 0, premium: 0, markPx: 1700, oraclePx: 1700 },
      book: book(1700, 2_000_000, 8_000_000),
    });
    const r = computeRubric(inp, CFG);
    expect(r.chosenSide).toBe('short');
    expect(r.badge).toBe('GO');
    expect(r.short.opportunity).toBeGreaterThanOrEqual(CFG.thresholds.go);
  });

  it('NO-EDGE: vol-contraction stands down even with a directional read', () => {
    const inp = inputs({ regimeByTf: tfAll('bearish'), atrPctile: 0.1, bbBandwidthPctile: 0.1,
      consensus: { coin: 'ETH', net: -5, longCount: 0, shortCount: 5, topN: 5 } });
    const r = computeRubric(inp, CFG);
    expect(r.badge).toBe('NO-EDGE');
    expect(r.noTradeReason).toBe('vol-contraction');
  });

  it('NO-EDGE: flat/neutral everything → below-bar', () => {
    const r = computeRubric(inputs(), CFG);
    expect(r.badge).toBe('NO-EDGE');
    expect(['below-bar', 'margin-too-thin']).toContain(r.noTradeReason);
  });

  it('is deterministic — identical inputs → identical result', () => {
    const inp = inputs({ regimeByTf: tfAll('bearish'), consensus: { coin: 'ETH', net: -4, longCount: 0, shortCount: 4, topN: 4 } });
    expect(computeRubric(inp, CFG)).toEqual(computeRubric(inp, CFG));
  });
});

describe('portfolio crypto-beta cap', () => {
  it('directionExposure: ETH+BTC pair = btcEthBeta; +HYPE exceeds cap', () => {
    expect(directionExposure(new Set(['ETH', 'BTC']), CFG)).toBeCloseTo(CFG.portfolio.btcEthBeta, 6);
    expect(directionExposure(new Set(['ETH', 'BTC', 'HYPE']), CFG)).toBeGreaterThan(CFG.portfolio.maxSameDirBeta);
  });
  it('a 3rd same-direction leg is downgraded GO→WATCH/portfolio-cap', () => {
    const go = (coin: string, side: Side) => ({
      ...computeRubric(inputs({ coin }), CFG), coin, chosenSide: side, badge: 'GO' as const, noTradeReason: null,
    });
    const out = applyPortfolioCaps([go('HYPE', 'short')], [{ coin: 'ETH', side: 'short' }, { coin: 'BTC', side: 'short' }], CFG);
    expect(out[0].badge).toBe('WATCH');
    expect(out[0].noTradeReason).toBe('portfolio-cap');
  });
  it('opposite-direction legs do not trip the cap', () => {
    const go = { ...computeRubric(inputs({ coin: 'HYPE' }), CFG), coin: 'HYPE', chosenSide: 'long' as const, badge: 'GO' as const, noTradeReason: null };
    const out = applyPortfolioCaps([go], [{ coin: 'ETH', side: 'short' }, { coin: 'BTC', side: 'short' }], CFG);
    expect(out[0].badge).toBe('GO');
  });
});

describe('position review', () => {
  const health = (score: number, alerts: HealthResult['alerts'] = []): HealthResult => ({
    score, pContinuation: 0.5, pAdverse: 0.3, alerts, timeframeReads: [],
  });
  const rubricFor = (side: Side, opposed: boolean, badge: 'GO' | 'WATCH' | 'NO-EDGE' = 'WATCH') => {
    const r = computeRubric(inputs({ regimeByTf: opposed ? tfAll(side === 'short' ? 'bullish' : 'bearish') : tfAll('neutral') }), CFG);
    return { ...r, badge, chosenSide: side };
  };
  it('EXIT on low health', () => {
    expect(reviewPosition({ health: health(20), rubric: rubricFor('short', false), positionSide: 'short' }, CFG).verdict).toBe('EXIT');
  });
  it('EXIT when higher-TF regime confirmed against the position', () => {
    expect(reviewPosition({ health: health(70), rubric: rubricFor('short', true), positionSide: 'short' }, CFG).verdict).toBe('EXIT');
  });
  it('TRIM on alerts + mid health', () => {
    expect(reviewPosition({ health: health(50, ['stop-within-1-ATR']), rubric: rubricFor('short', false), positionSide: 'short' }, CFG).verdict).toBe('TRIM');
  });
  it('ADD on high health + rubric GO same side', () => {
    expect(reviewPosition({ health: health(80), rubric: rubricFor('short', false, 'GO'), positionSide: 'short' }, CFG).verdict).toBe('ADD');
  });
  it('HOLD otherwise', () => {
    expect(reviewPosition({ health: health(65), rubric: rubricFor('short', false), positionSide: 'short' }, CFG).verdict).toBe('HOLD');
  });
});

describe('rows + inputs_hash', () => {
  it('inputs_hash is stable for identical inputs + changes when an input changes', () => {
    const a = inputs({ regimeByTf: tfAll('bearish'), markPx: 1700 });
    const b = inputs({ regimeByTf: tfAll('bearish'), markPx: 1700 });
    expect(rubricInputsHash(a)).toBe(rubricInputsHash(b));
    expect(rubricInputsHash(inputs({ markPx: 1701 }))).not.toBe(rubricInputsHash(inputs({ markPx: 1700 })));
  });
  it('buildRubricScoreRows yields one row per side with the shared hash', () => {
    const inp = inputs({ regimeByTf: tfAll('bearish'), consensus: { coin: 'ETH', net: -4, longCount: 0, shortCount: 4, topN: 4 } });
    const rows = buildRubricScoreRows(computeRubric(inp, CFG), inp, CFG.version);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.side).sort()).toEqual(['long', 'short']);
    expect(rows[0].inputs_hash).toBe(rows[1].inputs_hash);
    expect(rows[0].config_version).toBe(CFG.version);
    expect(rows[0].coin).toBe('ETH');
  });
});

describe('config resolution', () => {
  it('resolveCoinConfig deep-merges the HYPE override over base', () => {
    const hype = resolveCoinConfig(CFG, 'HYPE');
    expect(hype.gates.minDepthUsd).toBe(20000); // overridden
    expect(hype.consensus.topN).toBe(8); // overridden
    expect(hype.thresholds.go).toBe(CFG.thresholds.go); // inherited
  });
  it('deepMerge leaves base untouched + merges nested', () => {
    const base = { a: 1, n: { x: 1, y: 2 } };
    const merged = deepMerge(base, { n: { y: 9 } });
    expect(merged).toEqual({ a: 1, n: { x: 1, y: 9 } });
    expect(base.n.y).toBe(2); // immutable
  });
});
