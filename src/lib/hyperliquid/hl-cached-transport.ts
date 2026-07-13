/**
 * Shared caching layer for the public Hyperliquid `/info` reads.
 *
 * WHY THIS EXISTS (Vercel-specific):
 * The per-service caches (the `Map`s in candle-service / hyperliquid-info-service)
 * are MODULE-level and short-lived. Under load, concurrent callers and repeat
 * polls would each hit api.hyperliquid.xyz directly → HL 429 (Too Many Requests).
 *
 * This module adds two layers UNDER the existing per-service caches + 429 backoff:
 *
 *   1. TTL memo — a per-instance time-bounded value cache keyed by
 *      (type, keyParts). On Vercel Fluid Compute, instances are REUSED across
 *      concurrent requests and stay warm between polls, so this collapses the
 *      single-operator cockpit's repeat reads without any billed storage ops.
 *
 *   2. In-flight coalescing — a per-instance Promise map so concurrent same-key
 *      callers (e.g. a burst of polling tabs hitting one warm instance) share ONE
 *      upstream fetch instead of N.
 *
 * HISTORY: layer 1 used to be the Next Data Cache (`unstable_cache`), which is
 * Blob-backed on Vercel — every revalidation was a billed Blob "advanced request",
 * and the Hobby-tier allowance (2,000 ops/month) was exhausted within days of each
 * cycle, after which Vercel BLOCKED the ops and the cache silently degraded to
 * nothing. Cross-instance collapse for the genuinely hot PUBLIC endpoints
 * (/api/hl/candles, /api/hl/regime) is handled by the CDN edge cache
 * (`s-maxage`), which is free and unlimited — so the Blob layer was dead weight
 * most of the month and was removed deliberately. Do NOT reintroduce
 * `unstable_cache` here without checking the Blob billing math.
 *
 * Ordering (read path): per-service Map → TTL memo → in-flight coalesce →
 * network. The existing global 429 backoff + serve-stale stays as the last-resort
 * layer in each service and is INTENTIONALLY kept outside the memo (backoff
 * state and stale-marking must not be memoized). Errors are never memoized —
 * only successful values are stored, so a failed read retries on the next call.
 *
 * IMMUTABILITY CONTRACT: the memo hands out the SAME object reference to every
 * caller within a TTL window (the old Data Cache deserialized a copy per read).
 * Consumers MUST treat values from these reads as immutable — mutating one
 * (`mids[coin] = x`, `universe.sort()`) would silently corrupt the cache for
 * every other caller in the window.
 *
 * NOT USED BY: `fetchL2Book` (the paper-fill execution path needs a FRESH book
 * every time — never cache it) or the deep fills walk. Display/read paths only.
 */

/** Memo TTL windows (seconds) per read type — the type key also namespaces the
 *  cache. Tuned to keep the UI live while cutting HL hard. */
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

// --- Layer 1: TTL memo (per-instance; warm across requests on Fluid) ---

const memo = new Map<string, { value: unknown; expiresAt: number }>();

/** Bound the memo so a pathological key fan-out can't grow it unbounded. The real
 *  key space is tiny (a handful of coins × timeframes × read types); the cap only
 *  exists as a leak guard. On overflow: drop expired entries, then oldest-first. */
const MEMO_MAX_ENTRIES = 512;

function memoSet(key: string, value: unknown, ttlMs: number): void {
  if (memo.size >= MEMO_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of memo) if (v.expiresAt <= now) memo.delete(k);
    // Still full → evict oldest-inserted until under the cap (Map preserves order).
    for (const k of memo.keys()) {
      if (memo.size < MEMO_MAX_ENTRIES) break;
      memo.delete(k);
    }
  }
  memo.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Clear the TTL memo (test hook). */
export function _clearHlMemo(): void {
  memo.clear();
}

// --- Cache generation (test isolation) ---

/**
 * The memo keys include a monotonic generation token; bumping it via
 * `_bumpHlCacheGeneration()` makes every subsequent key unique, so prior entries
 * become unreachable. Production never calls the bump, so the token stays "0".
 */
let cacheGeneration = 0;

/** Bump the cache generation so all prior memo entries become unreachable (test hook). */
export function _bumpHlCacheGeneration(): void {
  cacheGeneration += 1;
}

/**
 * Run `fn` through BOTH the TTL memo (layer 1) and the in-flight coalescer
 * (layer 2). The same (type, keyParts) is fetched from HL at most once per
 * TTL window per warm instance. `keyParts` MUST fully identify the upstream
 * request (e.g. coin + interval + bucketed window) — they are the memo key.
 *
 * The coalescer wraps the fetch-and-store so that, even on a cold memo, a burst
 * of identical concurrent calls triggers a single upstream fetch rather than N.
 * (The memo re-check inside the coalesced section is belt-and-braces only: the
 * closure body runs synchronously to the fetch, so it observes the same miss the
 * outer check did. It guards a future refactor, not a live race.)
 *
 * Returns a SHARED reference within a TTL window — callers MUST NOT mutate the
 * result (see the immutability contract in the header).
 */
export function cachedHlRead<T>(
  type: keyof typeof HL_REVALIDATE_S,
  keyParts: string[],
  fn: () => Promise<T>,
  /** Skip the TTL memo for callers that must see a FRESH read every call (the
   *  reconcile/liq-monitor crons — a memoized position read could mask a change).
   *  In-flight coalescing is still applied. */
  bypassMemo = false,
): Promise<T> {
  const ttlMs = HL_REVALIDATE_S[type] * 1000;
  const key = `${type}:${keyParts.join('|')}:g${cacheGeneration}`;

  if (bypassMemo) return coalesce(key, fn);

  const hit = memo.get(key);
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.value as T);

  return coalesce(key, async () => {
    const inner = memo.get(key);
    if (inner && inner.expiresAt > Date.now()) return inner.value as T;
    const value = await fn();
    memoSet(key, value, ttlMs);
    return value;
  });
}
