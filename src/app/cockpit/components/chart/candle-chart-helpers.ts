/**
 * PURE helpers for the lightweight-charts CandleChart (no DOM, no charts lib —
 * fixture-testable). Convert our PriceCandle[] into the library's data shapes,
 * derive moving-average line data, and compute the trade price-line set from the
 * active position + safe-exit plan.
 */

import type { PriceCandle } from '@/types/trading-core';
import { calculateSMA } from '@/lib/strategy/indicators/indicators';

/** lightweight-charts uses UNIX SECONDS for `time`. */
export interface LwcCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface LwcLinePoint {
  time: number;
  value: number;
}

/** A horizontal price line overlaid on the chart (entry / stop / target / mark). */
export interface TradePriceLine {
  price: number;
  color: string;
  /** Short title rendered at the axis (e.g. "ENTRY", "STOP"). */
  title: string;
  /** Solid for entry/mark, dashed for stop/target. */
  dashed: boolean;
}

/** Convert PriceCandle[] (ms timestamps) → lightweight-charts candle data (s). */
export function toLwcCandles(candles: PriceCandle[]): LwcCandle[] {
  // Dedupe by second-resolution time and keep ascending (the lib requires it).
  const out: LwcCandle[] = [];
  let lastTime = -1;
  for (const c of candles) {
    const time = Math.floor(c.timestamp / 1000);
    if (time <= lastTime) continue;
    out.push({ time, open: c.open, high: c.high, low: c.low, close: c.close });
    lastTime = time;
  }
  return out;
}

/** A simple-moving-average line aligned to the candle times. PURE. */
export function maLine(candles: PriceCandle[], period: number): LwcLinePoint[] {
  if (candles.length < period) return [];
  const closes = candles.map((c) => c.close);
  const sma = calculateSMA(closes, period); // length = closes.length - period + 1
  const offset = closes.length - sma.length;
  const points: LwcLinePoint[] = [];
  let lastTime = -1;
  for (let i = 0; i < sma.length; i++) {
    const time = Math.floor(candles[offset + i].timestamp / 1000);
    if (time <= lastTime) continue;
    points.push({ time, value: sma[i] });
    lastTime = time;
  }
  return points;
}

export interface ActiveTrade {
  side: 'long' | 'short';
  entryPx: number | null;
  /** Stop price from the exit plan (when the plan rests a protective limit). */
  stopPx?: number | null;
  /** Target/take-profit price, when known. */
  targetPx?: number | null;
}

/**
 * Build the color-coded price-line set for the active trade. Entry is always
 * shown (accent); stop is red dashed; target is green dashed. PURE — colors are
 * passed so the component owns the palette.
 */
export function buildTradeLines(
  trade: ActiveTrade | null,
  colors: { entry: string; stop: string; target: string },
): TradePriceLine[] {
  if (!trade) return [];
  const lines: TradePriceLine[] = [];
  if (trade.entryPx != null && Number.isFinite(trade.entryPx)) {
    lines.push({ price: trade.entryPx, color: colors.entry, title: 'ENTRY', dashed: false });
  }
  if (trade.stopPx != null && Number.isFinite(trade.stopPx)) {
    lines.push({ price: trade.stopPx, color: colors.stop, title: 'STOP', dashed: true });
  }
  if (trade.targetPx != null && Number.isFinite(trade.targetPx)) {
    lines.push({ price: trade.targetPx, color: colors.target, title: 'TARGET', dashed: true });
  }
  return lines;
}

/** The selected coin's rubric levels, for overlaying a potential setup (no position yet). */
export interface OpportunityLevels {
  side: 'long' | 'short' | 'none';
  entryLow: number | null;
  entryHigh: number | null;
  invalidation: number | null;
  target: number | null;
}

/**
 * Build the rubric opportunity price-line set (entry zone / invalidation / target)
 * for a SETUP you don't yet hold. Empty when there's no directional edge
 * (side==='none'). All dashed (it's a proposal, not a live trade). PURE.
 */
export function buildOpportunityLines(
  opp: OpportunityLevels | null,
  colors: { entry: string; invalidation: string; target: string },
): TradePriceLine[] {
  if (!opp || opp.side === 'none') return [];
  const lines: TradePriceLine[] = [];
  if (opp.entryLow != null && Number.isFinite(opp.entryLow)) {
    lines.push({ price: opp.entryLow, color: colors.entry, title: 'ENTRY▼', dashed: true });
  }
  if (opp.entryHigh != null && Number.isFinite(opp.entryHigh)) {
    lines.push({ price: opp.entryHigh, color: colors.entry, title: 'ENTRY▲', dashed: true });
  }
  if (opp.invalidation != null && Number.isFinite(opp.invalidation)) {
    lines.push({ price: opp.invalidation, color: colors.invalidation, title: 'INVAL', dashed: true });
  }
  if (opp.target != null && Number.isFinite(opp.target)) {
    lines.push({ price: opp.target, color: colors.target, title: 'TGT', dashed: true });
  }
  return lines;
}
