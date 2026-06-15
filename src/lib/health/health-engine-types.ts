/**
 * Health-engine types — shared between the PURE composer
 * (health-engine-business-logic.ts) and the I/O engine (health-engine.ts).
 */

import type { PriceCandle } from '@/types/trading-core';
import type { PositionSide } from '@/types/position';

/** The four timeframes the engine composes. Mirrors candle-service intervals. */
export type HealthTimeframe = '1d' | '8h' | '1h' | '15m';

/** Versioned weights (loaded from data/health-engine via the manifest). */
export interface HealthWeights {
  version: string;
  timeframeWeights: Record<HealthTimeframe, number>;
  score: {
    /** Score when every TF is neutral (the midpoint). */
    neutralBaseline: number;
    /** How far a fully-aligned regime moves the score from baseline. */
    regimeSpan: number;
    /** Extra credit when TFs agree with the held position direction. */
    alignmentBonusMax: number;
    /** Penalty subtracted per fired alert. */
    alertPenaltyEach: number;
    /** Cap on total alert penalty. */
    alertPenaltyMax: number;
  };
  probability: {
    baseContinuation: number;
    scoreInfluence: number;
    /** Reserved residual so P(cont)+P(adverse) < 1 (honest uncertainty). */
    residualUncertainty: number;
  };
  alerts: {
    divergenceTimeframe: HealthTimeframe;
    divergenceMinStrength: number;
    regimeFlipTimeframe: HealthTimeframe;
    stopWithinAtrMultiplier: number;
  };
}

/** The held position context the health engine assesses against. */
export interface HealthPositionContext {
  /** 'long' | 'short'; 'flat' means no open position (alerts relax). */
  side: PositionSide;
  entryPx: number;
  /** Optional current stop price (drives the stop-within-1-ATR alert). */
  stopPx?: number;
}

/** Candle sets per timeframe (any subset; missing TFs are skipped). */
export type MultiTimeframeCandles = Partial<Record<HealthTimeframe, PriceCandle[]>>;

/** Per-timeframe regime read, surfaced for UI transparency. */
export interface TimeframeRegimeRead {
  timeframe: HealthTimeframe;
  regime: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  /** Weight applied (0 when the TF had insufficient candles). */
  weight: number;
}

/** Discrete alert codes the engine can emit. */
export type HealthAlert =
  | 'bearish-divergence-1h'
  | 'stop-within-1-ATR'
  | 'regime-flip-8h'
  | 'decline-detected';

/** The composed health result. */
export interface HealthResult {
  /** 0–100 composite health score (higher = healthier for the position). */
  score: number;
  /** P(thesis continues) — normalized, leaves residual uncertainty. */
  pContinuation: number;
  /** P(adverse move) — normalized, leaves residual uncertainty. */
  pAdverse: number;
  alerts: HealthAlert[];
  /** Per-TF regime reads for UI inspection. */
  timeframeReads: TimeframeRegimeRead[];
}
