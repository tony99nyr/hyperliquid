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
  snapToWindowGrid,
  type CandleInterval,
} from './candle-service-business-logic';
import { cachedHlRead, _bumpHlCacheGeneration, _clearInFlight } from './hl-cached-transport';

export { SUPPORTED_INTERVALS, isSupportedInterval } from './candle-service-business-logic';
export type { CandleInterval } from './candle-service-business-logic';

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const REQUEST_TIMEOUT_MS = 8000;
const CANDLE_CACHE_TTL_MS = 30_000;
/** Hard cap on distinct cache entries — a backstop bound on heap over long runs. */
const CANDLE_CACHE_MAX_ENTRIES = 256;

/**
 * Global 429 backoff. When HL returns 429 (Too Many Requests) we record a
 * "do-not-call-before" timestamp (honoring `Retry-After` when present, else a
 * default cool-down) and serve cached/stale candles until it passes — instead of
 * piling more requests onto a rate-limited upstream. Process-wide so EVERY
 * in-flight caller backs off together. Set HIGH when the proxy route fronts all
 * browser candle reads (one server, shared cache) so a single 429 quiets the
 * whole fleet rather than each tab retrying independently.
 */
const DEFAULT_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;
let backoffUntil = 0;

class RateLimitedError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Hyperliquid info API returned 429`);
    this.name = 'RateLimitedError';
  }
}

/** Parse a `Retry-After` header (seconds, or an HTTP-date) into ms from now. */
function parseRetryAfterMs(header: string | null): number {
  if (!header) return DEFAULT_BACKOFF_MS;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_BACKOFF_MS);
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.min(Math.max(when - Date.now(), 0), MAX_BACKOFF_MS);
  return DEFAULT_BACKOFF_MS;
}

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

/**
 * Sweep expired entries, then enforce the size cap (evict oldest-inserted first
 * — Map preserves insertion order). Called on every write so the cache stays
 * bounded even under a stream of distinct-window calls. O(n) but n ≤ the cap.
 */
function evictCandleCache(now: number): void {
  for (const [key, entry] of candleCache) {
    if (entry.expiresAt <= now) candleCache.delete(key);
  }
  while (candleCache.size >= CANDLE_CACHE_MAX_ENTRIES) {
    const oldest = candleCache.keys().next().value;
    if (oldest === undefined) break;
    candleCache.delete(oldest);
  }
}

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
    if (res.status === 429) {
      const wait = parseRetryAfterMs(res.headers.get('retry-after'));
      backoffUntil = Date.now() + wait;
      throw new RateLimitedError(wait);
    }
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

  // Snap the window to the 30s grid (mirrors fetchRegimeCandleSet / the regime
  // route) so that drifting `Date.now()`-derived bounds from polling callers
  // collapse onto a SINGLE Data-Cache key per 30s window instead of minting a
  // new key every poll (which bypassed the cross-instance Data Cache entirely —
  // the layer that exists to kill Vercel 429s). We snap BOTH the cache key and
  // the actually-fetched window so the key faithfully identifies the request.
  // Snapping `end` DOWN by <30s never drops needed history (the start lookback is
  // unchanged-or-earlier and HL returns the whole window inclusive).
  const snapStart = snapToWindowGrid(startTime);
  const snapEnd = snapToWindowGrid(endTime);
  const key = candleCacheKey(normCoin, interval, snapStart, snapEnd);

  const cached = candleCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  // Global 429 backoff: while rate-limited, DON'T add another request — serve the
  // last cached set (stale) or an empty error result. The window clears itself.
  if (Date.now() < backoffUntil) {
    const message = `rate-limited (backing off ${Math.ceil((backoffUntil - Date.now()) / 1000)}s)`;
    if (cached) return { ...cached.value, stale: true, error: message };
    return { coin: normCoin, interval, candles: [], fetchedAt: Date.now(), stale: true, error: message };
  }

  try {
    // Cross-instance Data Cache (layer 1) + in-flight coalescing (layer 2): on
    // Vercel this collapses identical (coin, interval, window) reads across ALL
    // serverless instances to ~1 upstream HL fetch per revalidate window. The
    // per-instance Map above and the 429 backoff below wrap around it.
    const candles = await cachedHlRead(
      'candles',
      [normCoin, interval, String(snapStart), String(snapEnd)],
      async () => {
        const raw = await hlInfoPost<unknown>({
          type: 'candleSnapshot',
          req: { coin: normCoin, interval, startTime: snapStart, endTime: snapEnd },
        });
        return parseCandleSnapshot(raw);
      },
    );
    const result: CandleResult = {
      coin: normCoin,
      interval,
      candles,
      fetchedAt: Date.now(),
      stale: false,
    };
    const writeAt = Date.now();
    evictCandleCache(writeAt);
    candleCache.set(key, { value: result, expiresAt: writeAt + CANDLE_CACHE_TTL_MS });
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

/**
 * Timeframes the regime strip analyzes, highest → lowest. Kept here (server-side)
 * so the regime proxy doesn't import a cockpit component module.
 */
export const REGIME_TIMEFRAMES: CandleInterval[] = ['1d', '8h', '1h', '15m'];

/** ~200d — enough for a 1d 50-period regime. Mirrors useRegimeStrip's lookback. */
const REGIME_LOOKBACK_MS = 200 * 24 * 60 * 60 * 1000;

/**
 * Fetch the multi-timeframe candle set the regime strip needs, cross-instance
 * Data-Cached under its OWN tag keyed by COIN at the regime TTL (~45s). Bypasses
 * the per-interval candle cache so the whole set collapses to a single shared
 * cache key per coin (instead of four), which is what the regime proxy wants.
 *
 * Fail-soft per interval: a missing/empty interval yields an empty stale result
 * rather than failing the whole set. `endBucket` should already be snapped to the
 * 30s window grid by the caller so concurrent polls share the key.
 */
export async function fetchRegimeCandleSet(
  coin: string,
  endBucket: number = Date.now(),
): Promise<Record<string, CandleResult>> {
  const normCoin = coin.trim().toUpperCase();
  const startTime = endBucket - REGIME_LOOKBACK_MS;

  try {
    return await cachedHlRead('regime', [normCoin, String(endBucket)], async () => {
      const fetchedAt = Date.now();
      const sets = await Promise.all(
        REGIME_TIMEFRAMES.map(async (interval): Promise<CandleResult> => {
          try {
            const raw = await hlInfoPost<unknown>({
              type: 'candleSnapshot',
              req: { coin: normCoin, interval, startTime, endTime: endBucket },
            });
            return { coin: normCoin, interval, candles: parseCandleSnapshot(raw), fetchedAt, stale: false };
          } catch (err) {
            return {
              coin: normCoin,
              interval,
              candles: [],
              fetchedAt,
              stale: true,
              error: extractErrorMessage(err),
            };
          }
        }),
      );
      const out: Record<string, CandleResult> = {};
      for (const r of sets) out[r.interval] = r;
      // Don't let `unstable_cache` memoize an all-failed / empty set: a transient
      // HL blip on revalidation would otherwise pin an empty stale set across
      // instances for the whole ~45s window. THROW so the rejection isn't cached
      // (mirrors fetchCandles); the outer catch fail-soft handles the render.
      // PARTIAL sets (≥1 interval with usable candles) stay cacheable.
      const hasUsableCandles = sets.some((r) => r.candles.length > 0);
      if (!hasUsableCandles) {
        throw new Error('regime set empty: all intervals failed');
      }
      return out;
    });
  } catch (err) {
    // Whole-set failure (e.g. a 429 surfaced from the first call): degrade to an
    // empty stale set so the strip renders rather than erroring.
    const message = extractErrorMessage(err);
    const fetchedAt = Date.now();
    const out: Record<string, CandleResult> = {};
    for (const interval of REGIME_TIMEFRAMES) {
      out[interval] = { coin: normCoin, interval, candles: [], fetchedAt, stale: true, error: message };
    }
    return out;
  }
}

/** Clear the in-process candle cache (test hook). Also isolates the Data Cache. */
export function _clearCandleCache(): void {
  candleCache.clear();
  backoffUntil = 0;
  _clearInFlight();
  _bumpHlCacheGeneration();
}

/**
 * Clear ONLY the per-instance Map + in-flight (NOT the Data Cache generation) —
 * simulates a fresh serverless instance whose module-level Map is cold but the
 * shared cross-instance Data Cache is still warm. Test hook for the collapse proof.
 */
export function _clearCandleCacheMapOnly(): void {
  candleCache.clear();
  backoffUntil = 0;
  _clearInFlight();
}

/** True when the service is in a global 429 backoff window (test/observability hook). */
export function _isBackingOff(): boolean {
  return Date.now() < backoffUntil;
}

/** Current number of live cache entries (test hook for bound verification). */
export function _candleCacheSize(): number {
  return candleCache.size;
}
