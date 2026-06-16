/**
 * analyze-market-timeframes — PURE multi-TF read composer (fixture-tested).
 *
 * Composes the vendored strategy pure-functions (regime detector, RSI, MACD
 * divergence) across 1d / 8h / 1h / 15m into a structured market assessment the
 * skill can present and write to analysis_log. ADVISORY ONLY — never acts.
 *
 * No I/O: the candle sets all come in as parameters. The thin script
 * (scripts/analyze-market.ts) fetches the candles and calls this.
 */

import type { PriceCandle } from '@/types/trading-core';
import {
  detectMarketRegimeCached,
  clearIndicatorCache,
} from '@/lib/strategy/analysis/market-regime-detector-cached';
import { detectRSIDivergence, detectMACDDivergence } from '@/lib/strategy/analysis/divergence-detector';
import { calculateRSI, getLatestIndicatorValue, getATRValue } from '@/lib/strategy/indicators/indicators';

/** The four timeframes the read composes (highest → lowest). */
export type MarketTimeframe = '1d' | '8h' | '1h' | '15m';
export const MARKET_TIMEFRAMES: MarketTimeframe[] = ['1d', '8h', '1h', '15m'];

/** Candle sets per timeframe (missing/thin TFs are reported as no-read). */
export type TimeframeCandles = Partial<Record<MarketTimeframe, PriceCandle[]>>;

/** A single timeframe's read. */
export interface TimeframeRead {
  timeframe: MarketTimeframe;
  /** False when there were too few candles for a meaningful read. */
  hasData: boolean;
  regime: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  rsi: number | null;
  atr: number | null;
  /** Strongest divergence on this TF, if any. */
  divergence: { type: 'bullish' | 'bearish'; strength: number } | null;
}

/** The composed multi-TF assessment. */
export interface MarketAssessment {
  coin: string;
  reads: TimeframeRead[];
  /** Net directional bias across the TFs that had data: -1..+1. */
  bias: number;
  /** Human-readable label of the bias. */
  biasLabel: 'bullish' | 'bearish' | 'neutral';
  /** True when the higher TFs (1d/8h) and lower TFs (1h/15m) agree in direction. */
  aligned: boolean;
  /** One-line summary for the analysis log. */
  summary: string;
}

/** Minimum candles for a meaningful regime read (matches the health engine). */
const MIN_CANDLES = 51;

function regimeSign(regime: 'bullish' | 'bearish' | 'neutral'): number {
  if (regime === 'bullish') return 1;
  if (regime === 'bearish') return -1;
  return 0;
}

/** Read one timeframe. PURE. */
export function readTimeframe(timeframe: MarketTimeframe, candles: PriceCandle[] | undefined): TimeframeRead {
  if (!candles || candles.length < MIN_CANDLES) {
    return {
      timeframe,
      hasData: false,
      regime: 'neutral',
      confidence: 0,
      rsi: null,
      atr: null,
      divergence: null,
    };
  }
  const idx = candles.length - 1;
  // The regime detector caches indicators in a MODULE-LEVEL buffer keyed only by
  // (candle count, last close). Across timeframes those keys collide — every TF
  // here is fetched up to "now", so they share the same candle count AND the same
  // latest close — which would make the detector silently reuse the FIRST
  // timeframe's indicators for all subsequent TFs (uniform regime/confidence).
  // Clearing the cache before each TF guarantees a fresh, per-timeframe read.
  // (Mirrors regime-region-calculator.ts, which clears before each fresh run.)
  clearIndicatorCache();
  const signal = detectMarketRegimeCached(candles, idx);
  const rsiSeries = calculateRSI(candles.map((c) => c.close), 14);
  const rsi = getLatestIndicatorValue(rsiSeries, idx, 14);
  const atr = getATRValue(candles, idx, 14);

  const rsiDiv = detectRSIDivergence(candles, idx);
  const macdDiv = detectMACDDivergence(candles, idx);
  const divCandidates = [rsiDiv, macdDiv].filter(
    (d): d is NonNullable<typeof d> => d !== null && (d.type === 'bullish' || d.type === 'bearish'),
  );
  divCandidates.sort((a, b) => b.strength - a.strength);
  const top = divCandidates[0];

  return {
    timeframe,
    hasData: true,
    regime: signal.regime,
    confidence: signal.confidence,
    rsi,
    atr,
    divergence: top ? { type: top.type as 'bullish' | 'bearish', strength: top.strength } : null,
  };
}

function biasToLabel(bias: number): 'bullish' | 'bearish' | 'neutral' {
  if (bias > 0.15) return 'bullish';
  if (bias < -0.15) return 'bearish';
  return 'neutral';
}

/**
 * Compose the full multi-TF assessment. PURE. Higher timeframes (1d/8h) are
 * weighted more for trend; only TFs that had data contribute.
 */
export function composeMarketAssessment(coin: string, candles: TimeframeCandles): MarketAssessment {
  const weights: Record<MarketTimeframe, number> = { '1d': 0.4, '8h': 0.3, '1h': 0.2, '15m': 0.1 };
  const reads = MARKET_TIMEFRAMES.map((tf) => readTimeframe(tf, candles[tf]));

  const active = reads.filter((r) => r.hasData);
  const totalWeight = active.reduce((s, r) => s + weights[r.timeframe], 0);
  const bias =
    totalWeight > 0
      ? active.reduce((s, r) => s + regimeSign(r.regime) * r.confidence * weights[r.timeframe], 0) /
        totalWeight
      : 0;

  const higher = reads.filter((r) => (r.timeframe === '1d' || r.timeframe === '8h') && r.hasData);
  const lower = reads.filter((r) => (r.timeframe === '1h' || r.timeframe === '15m') && r.hasData);
  const higherSign = Math.sign(higher.reduce((s, r) => s + regimeSign(r.regime) * r.confidence, 0));
  const lowerSign = Math.sign(lower.reduce((s, r) => s + regimeSign(r.regime) * r.confidence, 0));
  const aligned = higherSign !== 0 && higherSign === lowerSign;

  const biasLabel = biasToLabel(bias);
  const tfSummary = active
    .map((r) => `${r.timeframe}:${r.regime}(${Math.round(r.confidence * 100)}%)`)
    .join(' ');
  const summary =
    active.length === 0
      ? `${coin}: insufficient candle data on all timeframes — no read.`
      : `${coin}: ${biasLabel} bias ${bias >= 0 ? '+' : ''}${bias.toFixed(2)}${aligned ? ' (TFs aligned)' : ''} — ${tfSummary}`;

  return { coin, reads, bias, biasLabel, aligned, summary };
}
