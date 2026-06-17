/**
 * PURE helpers for the per-timeframe RegimeStrip. Given the candle-service result
 * per interval, compute regime + confidence + latest RSI for each timeframe as
 * plain numbers. No I/O, no React — fixture-tested.
 */

import type { CandleResult } from '@/lib/hyperliquid/candle-service';
import type { CandleInterval } from '@/lib/hyperliquid/candle-service-business-logic';
import { detectMarketRegime, type MarketRegime } from '@/lib/strategy/analysis/market-regime-detector';
import { calculateRSI } from '@/lib/strategy/indicators/indicators';

/** The analysis timeframes shown in the strip, highest → lowest. */
export const REGIME_STRIP_TIMEFRAMES: readonly CandleInterval[] = ['1d', '8h', '1h', '15m'];

export interface RegimeStripRow {
  timeframe: CandleInterval;
  regime: MarketRegime;
  /** 0–1. */
  confidence: number;
  /** Latest RSI(14), or null when insufficient data. */
  rsi: number | null;
  /** True when this timeframe had no usable candles. */
  noData: boolean;
}

/** Compute one strip row from a timeframe's candle result. PURE. */
export function rowFromCandles(timeframe: CandleInterval, result: CandleResult | undefined): RegimeStripRow {
  const candles = result?.candles ?? [];
  if (candles.length < 51) {
    return { timeframe, regime: 'neutral', confidence: 0, rsi: null, noData: candles.length === 0 };
  }
  const signal = detectMarketRegime(candles, candles.length - 1);
  const rsiSeries = calculateRSI(candles.map((c) => c.close), 14);
  const rsi = rsiSeries.length > 0 ? rsiSeries[rsiSeries.length - 1] : null;
  return {
    timeframe,
    regime: signal.regime,
    confidence: signal.confidence,
    rsi: rsi !== null && Number.isFinite(rsi) ? rsi : null,
    noData: false,
  };
}

/** Build all strip rows from the multi-timeframe fetch result. PURE. */
export function buildRegimeStrip(byInterval: Record<string, CandleResult>): RegimeStripRow[] {
  return REGIME_STRIP_TIMEFRAMES.map((tf) => rowFromCandles(tf, byInterval[tf]));
}

/** RSI band label: oversold < 30, overbought > 70, else neutral. PURE. */
export function rsiBand(rsi: number | null): 'oversold' | 'overbought' | 'neutral' | 'unknown' {
  if (rsi === null) return 'unknown';
  if (rsi < 30) return 'oversold';
  if (rsi > 70) return 'overbought';
  return 'neutral';
}

/** A net directional entry read derived from the multi-timeframe regime strip. */
export interface EntryBias {
  /** Which way the timeframes lean. */
  side: 'long' | 'short' | 'neutral';
  /** Confidence-weighted lean strength, 0–1 (how aligned the timeframes are). */
  strength: number;
  /** A short, numbers-aware guidance line. */
  guidance: string;
}

/**
 * Derive a net directional ENTRY bias from the per-timeframe regime rows. Each
 * timeframe votes by its regime, weighted by its confidence; the net sign decides
 * the side. Higher timeframes carry more weight (a 1d trend dominates a 15m blip).
 * PURE — fixture-tested, no I/O.
 */
export function deriveEntryBias(rows: RegimeStripRow[]): EntryBias {
  // Higher-TF rows lead the list (1d..15m); weight them more heavily.
  const tfWeight: Record<string, number> = { '1d': 4, '8h': 3, '1h': 2, '15m': 1 };
  let net = 0;
  let totalWeight = 0;
  for (const r of rows) {
    if (r.noData) continue;
    const w = tfWeight[r.timeframe] ?? 1;
    totalWeight += w;
    const vote = r.regime === 'bullish' ? 1 : r.regime === 'bearish' ? -1 : 0;
    net += vote * r.confidence * w;
  }
  if (totalWeight === 0) {
    return { side: 'neutral', strength: 0, guidance: 'No regime data yet — wait for a read.' };
  }
  const norm = net / totalWeight; // -1..1
  const strength = Math.min(1, Math.abs(norm));
  // A small dead-band so a barely-net read reads as neutral (no false confidence).
  if (strength < 0.15) {
    return {
      side: 'neutral',
      strength,
      guidance: 'Mixed across timeframes — no clean edge. Prefer to wait.',
    };
  }
  const side = norm > 0 ? 'long' : 'short';
  const pct = Math.round(strength * 100);
  const guidance =
    side === 'long'
      ? `Timeframes lean LONG (${pct}% aligned) — bias favors a buy entry.`
      : `Timeframes lean SHORT (${pct}% aligned) — bias favors a sell entry.`;
  return { side, strength, guidance };
}
