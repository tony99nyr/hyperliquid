/** Pure shadow replay for runaway entry variants. No live drafter or order code. */

import { detectRunaway, type RunawayHit } from '@/lib/ladder/runaway-alert-business-logic';

export interface RunawayShadowCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface RunawayShadowDetection {
  id: string;
  coin: string;
  side: 'long' | 'short';
  detectedAt: number;
  mark: number;
  /** Highest high for longs, lowest low for shorts, known at detection. */
  extreme: number;
  movePct24h?: number;
}

export type RunawayEntryVariant = 'pullback' | 'continuation' | 'split';

export interface RunawayHorizonOutcome {
  noTrade: boolean;
  grossReturn: number;
  netReturn: number;
  fees: number;
  stopHit: boolean;
  overshoot: number;
  filledFraction: number;
}

export interface RunawayStrategyResult {
  filledFraction: number;
  fillPrice: number | null;
  fillCount: number;
  horizons: Record<number, RunawayHorizonOutcome | undefined>;
}

export interface RunawayDetectionResult {
  detection: RunawayShadowDetection;
  episodeDay: string;
  strategies: Record<RunawayEntryVariant, RunawayStrategyResult>;
}

export const RUNAWAY_PULLBACK_FRACTION = 0.035;
export const RUNAWAY_STOP_FRACTION = 0.05;
export const RUNAWAY_TAKER_COST_PER_SIDE = 0.0005;
export const RUNAWAY_HORIZONS_MS = [48 * 3_600_000, 7 * 24 * 3_600_000] as const;

function validDetection(d: RunawayShadowDetection): boolean {
  const hit: RunawayHit | null = detectRunaway({ coin: d.coin, mark: d.mark, prevDayPx: d.mark / (1 + (d.movePct24h ?? 0)) });
  return d.mark > 0 && d.extreme > 0 && (d.movePct24h == null || hit !== null);
}

function isAdverse(side: 'long' | 'short', candle: RunawayShadowCandle, stop: number): boolean {
  return side === 'long' ? candle.low <= stop : candle.high >= stop;
}

function stopExecution(side: 'long' | 'short', candle: RunawayShadowCandle, stop: number): { price: number; overshoot: number } {
  const gap = side === 'long' ? candle.open < stop : candle.open > stop;
  const price = gap ? candle.open : stop;
  const overshoot = side === 'long' ? Math.max(0, stop - price) : Math.max(0, price - stop);
  return { price, overshoot };
}

function returnForFill(
  side: 'long' | 'short', fill: number, fillTime: number, fraction: number,
  candles: RunawayShadowCandle[], horizons: readonly number[],
): Record<number, RunawayHorizonOutcome | undefined> {
  const sign = side === 'long' ? 1 : -1;
  const stop = fill * (1 - sign * RUNAWAY_STOP_FRACTION);
  const outcomes: Record<number, RunawayHorizonOutcome | undefined> = {};
  for (const horizon of horizons) {
    let exit: number | null = null;
    let stopHit = false;
    let overshoot = 0;
    let last: RunawayShadowCandle | undefined;
    const targetTime = fillTime + horizon;
    for (const candle of candles) {
      if (candle.timestamp <= fillTime) continue;
      if (candle.timestamp > targetTime) break;
      last = candle;
      if (isAdverse(side, candle, stop)) {
        const stopped = stopExecution(side, candle, stop);
        exit = stopped.price;
        overshoot = stopped.overshoot / fill;
        stopHit = true;
        break;
      }
    }
    if (exit == null && last?.timestamp === targetTime) exit = last.close;
    if (exit == null && last && last.timestamp >= targetTime) exit = last.close;
    if (exit == null) {
      outcomes[horizon] = undefined;
      continue;
    }
    const grossReturn = sign * (exit / fill - 1) * fraction;
    const fees = RUNAWAY_TAKER_COST_PER_SIDE * 2 * fraction;
    outcomes[horizon] = {
      noTrade: false, grossReturn, netReturn: grossReturn - fees, fees,
      stopHit, overshoot, filledFraction: fraction,
    };
  }
  return outcomes;
}

interface Fill { price: number; time: number; fraction: number }

function strategyFills(
  variant: RunawayEntryVariant, d: RunawayShadowDetection, candles: RunawayShadowCandle[],
): Fill[] {
  const sign = d.side === 'long' ? 1 : -1;
  const pullback = d.mark * (1 - sign * RUNAWAY_PULLBACK_FRACTION);
  if (variant === 'split') {
    const second = firstPullbackFill(d.side, pullback, d.detectedAt, candles);
    return [{ price: d.mark, time: d.detectedAt, fraction: 0.5 }, ...(second ? [{ ...second, fraction: 0.5 }] : [])];
  }
  if (variant === 'pullback') {
    const f = firstPullbackFill(d.side, pullback, d.detectedAt, candles);
    return f ? [{ ...f, fraction: 1 }] : [];
  }
  for (const c of candles) {
    if (c.timestamp <= d.detectedAt) continue;
    if (d.side === 'long' ? c.close > d.extreme : c.close < d.extreme) {
      return [{ price: c.close, time: c.timestamp, fraction: 1 }];
    }
  }
  return [];
}

function firstPullbackFill(
  side: 'long' | 'short', level: number, after: number, candles: RunawayShadowCandle[],
): Omit<Fill, 'fraction'> | null {
  for (const c of candles) {
    if (c.timestamp <= after) continue;
    const touched = side === 'long' ? c.low <= level : c.high >= level;
    if (!touched) continue;
    const gapped = side === 'long' ? c.open < level : c.open > level;
    return { price: gapped ? c.open : level, time: c.timestamp };
  }
  return null;
}

export function detectRunawayFromCandles(
  coin: string, candles: readonly RunawayShadowCandle[], atIndex: number,
): RunawayShadowDetection | null {
  if (atIndex < 24 || atIndex >= candles.length) return null;
  const current = candles[atIndex];
  const previous = candles[atIndex - 24];
  const hit = detectRunaway({ coin, mark: current.close, prevDayPx: previous.close });
  if (!hit) return null;
  const window = candles.slice(Math.max(0, atIndex - 23), atIndex + 1);
  const extreme = hit.side === 'long'
    ? Math.max(...window.map((c) => c.high))
    : Math.min(...window.map((c) => c.low));
  return {
    id: `${coin.toUpperCase()}-${current.timestamp}`, coin: coin.toUpperCase(), side: hit.side,
    detectedAt: current.timestamp, mark: current.close, extreme, movePct24h: hit.movePct24h,
  };
}

export function evaluateRunawayDetection(
  detection: RunawayShadowDetection,
  candlesInput: readonly RunawayShadowCandle[],
  horizons: readonly number[] = RUNAWAY_HORIZONS_MS,
): RunawayDetectionResult {
  if (!validDetection(detection)) throw new Error(`Invalid runaway detection ${detection.id}`);
  const candles = [...candlesInput].sort((a, b) => a.timestamp - b.timestamp);
  const strategies = {} as Record<RunawayEntryVariant, RunawayStrategyResult>;
  for (const variant of ['pullback', 'continuation', 'split'] as const) {
    const fills = strategyFills(variant, detection, candles);
    const total = fills.reduce((s, f) => s + f.fraction, 0);
    const weightedEntry = fills.reduce((s, f) => s + f.price * f.fraction, 0);
    const outcomes: Record<number, RunawayHorizonOutcome | undefined> = {};
    for (const horizon of horizons) {
      if (fills.length === 0) {
        outcomes[horizon] = { noTrade: true, grossReturn: 0, netReturn: 0, fees: 0, stopHit: false, overshoot: 0, filledFraction: 0 };
        continue;
      }
      const parts = fills.map((f) => returnForFill(detection.side, f.price, f.time, f.fraction, candles, [horizon])[horizon]);
      if (parts.some((p) => p == null)) { outcomes[horizon] = undefined; continue; }
      const known = parts.filter((p): p is RunawayHorizonOutcome => p != null);
      outcomes[horizon] = {
        noTrade: false,
        grossReturn: known.reduce((s, p) => s + p.grossReturn, 0),
        netReturn: known.reduce((s, p) => s + p.netReturn, 0),
        fees: known.reduce((s, p) => s + p.fees, 0),
        stopHit: known.some((p) => p.stopHit),
        overshoot: known.reduce((s, p) => s + p.overshoot * p.filledFraction, 0),
        filledFraction: total,
      };
    }
    strategies[variant] = {
      filledFraction: total, fillPrice: total ? weightedEntry / total : null,
      fillCount: fills.length, horizons: outcomes,
    };
  }
  return { detection, episodeDay: new Date(detection.detectedAt).toISOString().slice(0, 10), strategies };
}
