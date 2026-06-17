/**
 * Candle parsing / normalization (PURE). No I/O — given raw HL `candleSnapshot`
 * rows it produces typed, sorted, de-duplicated PriceCandle[]. Split out from
 * candle-service.ts so the parsing logic is fixture-testable with no fetch.
 *
 * HL `candleSnapshot` returns rows shaped (numbers are strings):
 *   { t: openMs, T: closeMs, s: coin, i: interval, o, h, l, c, v, n }
 */

import type { PriceCandle } from '@/types/trading-core';

/** Multi-timeframe set the cockpit reads (plan: 1d / 8h / 1h / 15m). */
export const SUPPORTED_INTERVALS = ['1d', '8h', '1h', '15m'] as const;
export type CandleInterval = (typeof SUPPORTED_INTERVALS)[number];

export function isSupportedInterval(i: string): i is CandleInterval {
  return (SUPPORTED_INTERVALS as readonly string[]).includes(i);
}

/** Raw HL candle row. Fields arrive as strings; `t`/`T`/`n` may be numbers. */
export interface RawHlCandle {
  t?: number | string;
  T?: number | string;
  s?: string;
  i?: string;
  o?: number | string;
  h?: number | string;
  l?: number | string;
  c?: number | string;
  v?: number | string;
  n?: number | string;
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Convert ONE raw row to a PriceCandle, or null if it is malformed (missing
 * timestamp or a non-finite OHLC value). Volume defaults to 0 when absent.
 */
export function parseCandle(raw: RawHlCandle): PriceCandle | null {
  const timestamp = num(raw.t);
  const open = num(raw.o);
  const high = num(raw.h);
  const low = num(raw.l);
  const close = num(raw.c);
  if (
    !Number.isFinite(timestamp) ||
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close)
  ) {
    return null;
  }
  const volume = num(raw.v);
  return {
    timestamp,
    open,
    high,
    low,
    close,
    volume: Number.isFinite(volume) ? volume : 0,
    source: 'hyperliquid',
  };
}

/**
 * Parse a full snapshot: drop malformed rows, sort ascending by timestamp, and
 * de-duplicate by timestamp (keeping the LAST occurrence — HL may resend the
 * most recent, still-forming candle). Returns a clean, chronologically ordered
 * PriceCandle[].
 */
export function parseCandleSnapshot(raw: unknown): PriceCandle[] {
  if (!Array.isArray(raw)) return [];
  const byTs = new Map<number, PriceCandle>();
  for (const row of raw) {
    const candle = parseCandle(row as RawHlCandle);
    if (candle) byTs.set(candle.timestamp, candle);
  }
  return [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** Interval length in milliseconds, for cache-window bucketing. */
export const INTERVAL_MS: Record<CandleInterval, number> = {
  '1d': 24 * 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '15m': 15 * 60 * 1000,
};

/** Floor `t` to the start of its `interval`-sized bucket. PURE. */
export function bucketTime(t: number, interval: CandleInterval): number {
  const period = INTERVAL_MS[interval];
  return Math.floor(t / period) * period;
}

/**
 * Cache key for a (coin, interval, start, end) candle request. The start/end
 * bounds are BUCKETED to the interval period so repeated ticks within the same
 * bucket (callers pass start/end derived from `Date.now()`, which drifts every
 * call) reuse one cache entry instead of minting a unique key per call. Returns
 * the same set of candles for any moment inside a bucket — acceptable because the
 * most-recent candle only updates once per interval anyway, and the cache TTL is
 * far shorter than the bucket period.
 */
export function candleCacheKey(
  coin: string,
  interval: CandleInterval,
  startTime: number,
  endTime: number,
): string {
  const start = bucketTime(startTime, interval);
  const end = bucketTime(endTime, interval);
  return `${coin.toUpperCase()}:${interval}:${start}:${end}`;
}
