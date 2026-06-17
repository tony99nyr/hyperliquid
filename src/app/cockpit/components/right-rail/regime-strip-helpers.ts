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
