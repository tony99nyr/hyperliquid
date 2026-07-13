/**
 * Shared cross-instance caching layer for the public Hyperliquid `/info` reads.
 *
 * WHY THIS EXISTS (Vercel-specific):
 * The per-service caches (the `Map`s in candle-service / hyperliquid-info-service)
 * are MODULE-level and therefore PER serverless instance and short-lived. On
 * Vercel many cold instances run concurrently across users/requests, so each one
 * hits api.hyperliquid.xyz directly → HL 429 (Too Many Requests). A per-instance
 * Map cannot collapse load across instances.
 *
 * This module adds two layers UNDER the existing per-service caches + 429 backoff:
 *
 *   1. Next Data Cache (`unstable_cache`) — SHARED across all serverless instances
 *      on Vercel. A given (type, keyParts) is fetched from HL at most ~once per
 *      `revalidate` window GLOBALLY, not per instance. Tagged for later
 *      invalidation. This is the layer that actually kills the cross-instance 429s.
 *
 *   2. In-flight coalescing — a per-instance Promise map so concurrent same-key
 *      callers (e.g. a burst of polling tabs hitting one warm instance) share ONE
 *      upstream fetch instead of N. Sits between the Data Cache and the network.
 *
 * Ordering (read path): per-service Map → Next Data Cache → in-flight coalesce →
 * network. The existing global 429 backoff + serve-stale stays as the last-resort
 * layer in each service and is INTENTIONALLY kept outside the Data Cache (backoff
 * state and stale-marking must not be memoized).
 *
 * NOT USED BY: `fetchL2Book` (the paper-fill execution path needs a FRESH book
 * every time — never cache it) or the deep fills walk. Display/read paths only.
 */

import { unstable_cache } from 'next/cache';

/** Cache tags per data type so each can be invalidated independently later. */
export const HL_CACHE_TAGS = {
  candles: 'hl:candles',
  regime: 'hl:regime',
  allMids: 'hl:all-mids',
  clearinghouse: 'hl:clearinghouse',
  spot: 'hl:spot',
  perpMeta: 'hl:perp-meta',
  assetCtxs: 'hl:asset-ctxs',
  recentTrades: 'hl:recent-trades',
} as const;

/** Revalidate windows (seconds). Tuned to keep the UI live while cutting HL hard. */
// Revalidate windows = how often a cache MISS re-fetches AND re-writes the Next Data
// Cache (Blob-backed on Vercel). Longer windows → fewer Blob writes. Tuned up for a
// human-paced cockpit (marks/positions a touch staler is imperceptible) to stay under
// the Blob free tier; the cron paths additionally bypass this cache entirely.
export const HL_REVALIDATE_S = {
  /** Candle grid; 60s is fine for a chart you read, not scalp. */
  candles: 60,
  /** Regime is multi-TF + slow-moving. */
  regime: 120,
  /** Marks for the Performance view — 30s still feels live for a human. */
  allMids: 30,
  /** Positions/liq — 60s; the liq monitor cron reads uncached anyway. */
  clearinghouse: 60,
  /** Spot balances move only when funds are transferred. */
  spot: 60,
  /** The perp universe (asset indices + szDecimals) changes very rarely. */
  perpMeta: 600,
  /** Funding/OI context for the rubric scan (~20min cadence). */
  assetCtxs: 120,
  recentTrades: 30,
} as const;

// --- Layer 2: in-flight coalescing (per-instance) ---

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Coalesce concurrent same-key calls into ONE in-flight Promise. The first caller
 * runs `fn`; concurrent callers with the same key await the same Promise. The
 * entry is cleared as soon as the Promise settles (success OR failure), so a
 * later call re-runs `fn`. Errors propagate to every awaiter.
 */
export function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = (async () => fn())().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}

/** Number of currently in-flight coalesced calls (test/observability hook). */
export function _inFlightSize(): number {
  return inFlight.size;
}

/** Clear the in-flight map (test hook). */
export function _clearInFlight(): void {
  inFlight.clear();
}

// --- Cache generation (test isolation) ---

/**
 * The Next Data Cache (`unstable_cache`) keys on `keyParts` + function-source and
 * memoizes IN-PROCESS across calls — which is exactly what we want in production,
 * but it survives across test cases (there is no public flush API). To isolate
 * tests we mix a monotonic generation token into the key; bumping it via
 * `_bumpHlCacheGeneration()` makes every subsequent key unique, so prior entries
 * become unreachable. Production never calls the bump, so the token stays "0".
 */
let cacheGeneration = 0;

/** Bump the cache generation so all prior Data-Cache entries become unreachable (test hook). */
export function _bumpHlCacheGeneration(): void {
  cacheGeneration += 1;
}

// --- Layer 1: Next Data Cache wrapper (cross-instance on Vercel) ---

/**
 * Run `fn` through BOTH the in-flight coalescer (layer 2) and the Next Data Cache
 * (layer 1). On Vercel the Data Cache is shared across instances, so the same
 * (type, keyParts) is fetched from HL at most once per `revalidate` window
 * globally. `keyParts` MUST fully identify the upstream request (e.g. coin +
 * interval + bucketed window) — they are the Data Cache key.
 *
 * `fn` is a fresh closure per call (it closes over the request args). We DON'T
 * pass it to `unstable_cache` directly across calls; instead we build a
 * per-invocation cached wrapper whose closure is the no-arg `fn` and whose key is
 * `keyParts`. `unstable_cache` keys on `keyParts` + the function-source hash, so
 * two calls with identical `keyParts` collapse to one cached entry.
 *
 * NOTE: the in-flight coalescer wraps the OUTSIDE so that, even on a cold Data
 * Cache, a burst of identical concurrent calls triggers a single revalidation
 * rather than N parallel upstream fetches.
 */
export function cachedHlRead<T>(
  type: keyof typeof HL_CACHE_TAGS,
  keyParts: string[],
  fn: () => Promise<T>,
  /** Skip the Next Data Cache (no Blob write). For server-side callers that read
   *  ONCE per tick (crons) — caching across ticks just burns Blob ops for no
   *  cross-instance benefit. In-flight coalescing is still applied. */
  bypassDataCache = false,
): Promise<T> {
  const tag = HL_CACHE_TAGS[type];
  const revalidate = HL_REVALIDATE_S[type];
  const coalesceKey = `${type}:${keyParts.join('|')}`;

  if (bypassDataCache) return coalesce(coalesceKey, fn);

  return coalesce(coalesceKey, async () => {
    const cached = unstable_cache(fn, [type, ...keyParts, `g${cacheGeneration}`], {
      revalidate,
      tags: [tag],
    });
    try {
      return await cached();
    } catch (err) {
      // `unstable_cache` requires a Next request/build context ("incrementalCache").
      // Outside one (unit tests, or a context where it's unavailable) it throws an
      // Invariant. Degrade to a DIRECT call so the read still succeeds — we lose the
      // cross-instance cache but keep the in-flight coalescing and the data. On
      // Vercel the context is always present, so this branch is a safety net only.
      if (isMissingIncrementalCache(err)) {
        return fn();
      }
      throw err;
    }
  });
}

/** True when the error is the `unstable_cache` "no request context" invariant. */
function isMissingIncrementalCache(err: unknown): boolean {
  return err instanceof Error && /incrementalCache missing/i.test(err.message);
}
