/**
 * PURE stop-suggestion logic for the entry form (no React, no I/O — fixture-tested).
 *
 * The wick-out problem: a flat default stop (4%) sits INSIDE normal noise on a
 * longer-timeframe thesis, so a brief spike triggers it. The professional fix is to
 * size the stop off realized volatility (ATR) at the HOLDING timeframe — a wider ATR
 * multiple for longer holds — so the stop sits beyond the noise band. The operator
 * can still override; this only seeds a sane default.
 *
 * Reuses the existing ATR primitive (calculateATR) — does not re-derive true-range.
 */

import type { PriceCandle } from '@/types/trading-core';
import type { CandleInterval } from '@/lib/hyperliquid/candle-service-business-logic';
import { calculateATR } from '@/lib/strategy/indicators/indicators';

/** How long the operator intends to hold — drives the candle interval + ATR multiple. */
export type HoldTimeframe = 'scalp' | 'swing' | 'position';

export interface HoldTimeframeSpec {
  label: string;
  /** Candle interval ATR is measured on (longer hold → higher TF). */
  interval: CandleInterval;
  /** ATR multiple for the stop (longer hold → wider, beyond the noise band). */
  atrMult: number;
  /** Conservative leverage ceiling for this hold (longer hold → lower leverage). */
  maxLeverage: number;
  /** ATR lookback period. */
  atrPeriod: number;
  /** One-line rationale shown in the UI. */
  hint: string;
}

/** Hold presets. ATR multiples/leverage ceilings follow standard practice
 *  (scalp tight+higher lev → position wide+low lev). Server still re-clamps. */
export const HOLD_TIMEFRAMES: Record<HoldTimeframe, HoldTimeframeSpec> = {
  scalp: { label: 'Scalp', interval: '5m', atrMult: 1.5, maxLeverage: 10, atrPeriod: 14, hint: 'minutes–hours · tight ATR stop, higher leverage' },
  swing: { label: 'Swing', interval: '1h', atrMult: 2.5, maxLeverage: 5, atrPeriod: 14, hint: 'hours–days · ATR stop beyond noise, moderate leverage' },
  position: { label: 'Position', interval: '4h', atrMult: 3.5, maxLeverage: 3, atrPeriod: 14, hint: 'days+ · wide structural stop, low leverage (avoids wick-outs)' },
};

/** Mirror of the SERVER stop floor (open-position/route MIN_STOP_FRAC) + a sane ceiling. */
export const MIN_STOP_FRAC = 0.005; // 0.5%
export const MAX_STOP_FRAC = 0.5; // 50%

/** Latest ATR value from a candle series, or null when there isn't enough data. */
export function latestAtr(candles: PriceCandle[] | null | undefined, period = 14): number | null {
  if (!candles || candles.length < period + 2) return null;
  const series = calculateATR(candles, period, true);
  const atr = series.length ? series[series.length - 1] : null;
  return atr != null && Number.isFinite(atr) && atr > 0 ? atr : null;
}

/**
 * Suggest a stop fraction = (ATR / last price) × atrMult, clamped to [MIN, MAX].
 * Returns null when candles are too thin/stale to measure — the caller then keeps
 * the operator's current stop (NEVER falls back to "no stop"). PURE.
 */
export function suggestStopFrac(
  candles: PriceCandle[] | null | undefined,
  atrMult: number,
  period = 14,
): number | null {
  const atr = latestAtr(candles, period);
  if (atr == null || !candles || candles.length === 0) return null;
  const last = candles[candles.length - 1]?.close;
  if (!(typeof last === 'number' && last > 0)) return null;
  const frac = (atr / last) * atrMult;
  if (!Number.isFinite(frac) || frac <= 0) return null;
  return Math.min(MAX_STOP_FRAC, Math.max(MIN_STOP_FRAC, frac));
}

/**
 * Liquidation cushion = how many multiples of the stop distance the liquidation
 * price sits beyond the stop. >1 means the stop triggers first (good); ≤1 is the
 * danger the liquidation-inside-stop guard rejects. null when unknown.
 */
export function liquidationCushion(
  entryPx: number | null,
  stopPx: number | null | undefined,
  liqPx: number | null | undefined,
): number | null {
  if (entryPx == null || stopPx == null || liqPx == null) return null;
  const stopDist = Math.abs(entryPx - stopPx);
  const liqDist = Math.abs(entryPx - liqPx);
  if (!(stopDist > 0) || !Number.isFinite(liqDist)) return null;
  return liqDist / stopDist;
}
