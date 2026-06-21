/**
 * PURE rubric gates + level derivation. Gates are boolean KILLS (any → score 0).
 * Levels (entry zone / invalidation / target / trigger) derive from mark + ATR.
 * No I/O. Fixture-tested.
 */

import type { HealthTimeframe } from '@/lib/health/health-engine-types';
import type { MarketRegimeSignal } from '@/lib/strategy/analysis/market-regime-detector-cached';
import type { RubricConfig } from './rubric-config-types';
import type { GateStates, Levels, RubricInputs, Side } from './rubric-types';
import { scoreBookImbalance } from './rubric-scorers-business-logic';

/** Entry-zone / stop / target / trigger from mark + ATR for a side. */
export function deriveLevels(markPx: number, atr: number, side: Side, cfg: RubricConfig): Levels {
  const zone = atr * cfg.levels.entryZoneAtrFrac;
  const stopDist = atr * cfg.levels.stopAtrMult;
  const targetDist = atr * cfg.levels.targetAtrMult;
  const invalidation = side === 'long' ? markPx - stopDist : markPx + stopDist;
  const target = side === 'long' ? markPx + targetDist : markPx - targetDist;
  const roomToTarget = stopDist > 0 ? targetDist / stopDist : 0;
  return {
    entryLow: markPx - zone,
    entryHigh: markPx + zone,
    invalidation,
    target,
    trigger: markPx,
    roomToTarget,
  };
}

/** True when BOTH 8h and 1d regimes are CONFIRMED opposed to the side. */
export function againstConfirmedHtf(
  regimeByTf: Partial<Record<HealthTimeframe, MarketRegimeSignal>>,
  side: Side,
  cfg: RubricConfig,
): boolean {
  const need: HealthTimeframe[] = ['8h', '1d'];
  for (const tf of need) {
    const sig = regimeByTf[tf];
    if (!sig || sig.regime === 'neutral') return false;
    const bullish = sig.regime === 'bullish';
    const opposed = (side === 'long') !== bullish;
    if (!opposed || sig.confidence < cfg.regime.confirmedConfidence) return false;
  }
  return true;
}

/** Evaluate every gate for a side. PURE. */
export function evaluateGates(inp: RubricInputs, levels: Levels, side: Side, cfg: RubricConfig): GateStates {
  const { bidDepthUsd, askDepthUsd } = scoreBookImbalance(inp.book, cfg.gates.depthQueryFrac);
  // You CROSS the opposite side of the book to enter: a long lifts asks, a short hits bids.
  const fillDepth = side === 'long' ? askDepthUsd : bidDepthUsd;
  const bookTooThin = fillDepth < cfg.gates.minDepthUsd;

  const roomTooTight = levels.roomToTarget < cfg.gates.minRoomToTarget;

  const volContraction =
    inp.atrPctile < cfg.gates.volContractionAtrPctile &&
    inp.bbBandwidthPctile < cfg.gates.volContractionBbPctile;

  const againstHtf = againstConfirmedHtf(inp.regimeByTf, side, cfg);

  // Liq-inside-stop only meaningful when a position is open and liq is known.
  let liqInsideStop = false;
  if (inp.hasOpenPosition && inp.liqPx != null && Number.isFinite(inp.liqPx)) {
    liqInsideStop = side === 'long' ? inp.liqPx >= levels.invalidation : inp.liqPx <= levels.invalidation;
  }

  return { bookTooThin, againstConfirmedHtf: againstHtf, roomTooTight, volContraction, liqInsideStop };
}

/** First failing gate name (the kill reason), or null when all pass. */
export function firstFailingGate(g: GateStates): string | null {
  if (g.bookTooThin) return 'book-too-thin';
  if (g.againstConfirmedHtf) return 'against-confirmed-htf';
  if (g.roomTooTight) return 'room-too-tight';
  if (g.volContraction) return 'vol-contraction';
  if (g.liqInsideStop) return 'liq-inside-stop';
  return null;
}
