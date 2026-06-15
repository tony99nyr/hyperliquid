/**
 * Hyperliquid candle service (READ-ONLY I/O). Fetches OHLCV candles via the
 * public `/info` `candleSnapshot` endpoint for the cockpit's multi-timeframe
 * analysis (1d / 8h / 1h / 15m). The parsing/normalization is PURE and lives in
 * candle-service-business-logic.ts (fixture-tested).
 *
 * Rate-limit posture mirrors hyperliquid-info-service.ts: short in-process cache
 * + fail-soft. On a fetch error we return the last cached candles (if any) so
 * the UI degrades gracefully rather than erroring. No API key required.
 */

import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';
import type { PriceCandle } from '@/types/trading-core';
import {
  candleCacheKey,
  parseCandleSnapshot,
  type CandleInterval,
} from './candle-service-business-logic';

export { SUPPORTED_INTERVALS, isSupportedInterval } from './candle-service-business-logic';
export type { CandleInterval } from './candle-service-business-logic';

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const REQUEST_TIMEOUT_MS = 8000;
const CANDLE_CACHE_TTL_MS = 30_000;

export interface CandleResult {
  coin: string;
  interval: CandleInterval;
  candles: PriceCandle[];
  /** Epoch ms when this set was fetched. */
  fetchedAt: number;
  /** True when served from cache after a live fetch failure. */
  stale: boolean;
  /** Set when the live fetch failed and a cached/empty value was returned. */
  error?: string;
}

interface CacheEntry {
  value: CandleResult;
  expiresAt: number;
}

const candleCache = new Map<string, CacheEntry>();

async function hlInfoPost<T>(body: Record<string, unknown>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new Error(`Hyperliquid info API returned ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch candles for one coin + interval over [startTime, endTime] (epoch ms).
 * Cached for 30s per (coin, interval, window). Fails soft: on error returns the
 * last cached set (marked stale) or an empty result with an `error` field.
 */
export async function fetchCandles(
  coin: string,
  interval: CandleInterval,
  startTime: number,
  endTime: number = Date.now(),
): Promise<CandleResult> {
  const normCoin = coin.trim().toUpperCase();
  const key = candleCacheKey(normCoin, interval, startTime, endTime);

  const cached = candleCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const raw = await hlInfoPost<unknown>({
      type: 'candleSnapshot',
      req: { coin: normCoin, interval, startTime, endTime },
    });
    const candles = parseCandleSnapshot(raw);
    const result: CandleResult = {
      coin: normCoin,
      interval,
      candles,
      fetchedAt: Date.now(),
      stale: false,
    };
    candleCache.set(key, { value: result, expiresAt: Date.now() + CANDLE_CACHE_TTL_MS });
    return result;
  } catch (err) {
    const message = extractErrorMessage(err);
    if (cached) {
      return { ...cached.value, stale: true, error: message };
    }
    return {
      coin: normCoin,
      interval,
      candles: [],
      fetchedAt: Date.now(),
      stale: true,
      error: message,
    };
  }
}

/**
 * Fetch the same window across MULTIPLE intervals concurrently. Each result is
 * independently fail-soft; one interval failing does not fail the others.
 */
export async function fetchMultiTimeframeCandles(
  coin: string,
  intervals: CandleInterval[],
  startTime: number,
  endTime: number = Date.now(),
): Promise<Record<string, CandleResult>> {
  const results = await Promise.all(
    intervals.map((interval) => fetchCandles(coin, interval, startTime, endTime)),
  );
  const out: Record<string, CandleResult> = {};
  for (const r of results) out[r.interval] = r;
  return out;
}

/** Clear the in-process candle cache (test hook). */
export function _clearCandleCache(): void {
  candleCache.clear();
}
