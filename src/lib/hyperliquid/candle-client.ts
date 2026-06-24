/**
 * CLIENT-side candle fetchers. The browser must NOT call api.hyperliquid.xyz
 * directly (every tab doing so is what 429'd us). These hit our same-origin
 * cached proxies (/api/hl/candles, /api/hl/regime) instead, so all browser candle
 * reads collapse onto ONE shared server cache + 429 backoff.
 *
 * Mirrors the shapes returned by candle-service so the hooks/derivations are
 * unchanged downstream. Fail-soft: a proxy/network error returns an empty,
 * `stale`+`error` result (same contract as the server service) so the UI degrades
 * gracefully rather than throwing.
 */

import type { CandleResult } from './candle-service';
import type { CandleInterval } from './candle-service-business-logic';

function emptyResult(coin: string, interval: CandleInterval, error: string): CandleResult {
  return { coin, interval, candles: [], fetchedAt: Date.now(), stale: true, error };
}

/** Fetch one (coin, interval) over a lookback window via the cached proxy. */
export async function fetchCandlesViaProxy(
  coin: string,
  interval: CandleInterval,
  lookbackMs: number,
): Promise<CandleResult> {
  const normCoin = coin.trim().toUpperCase();
  try {
    // Use the browser HTTP cache (respects the proxy's Cache-Control max-age): the
    // URL is stable (constant lookbackMs; the window is bucketed server-side), so
    // polls within the max-age window are served from cache with ZERO origin
    // transfer. The live PRICE comes from the ws, so a ~30s-stale bar is fine. The
    // old `no-store` forced a full candle-payload refetch on EVERY poll (the Fast
    // Origin Transfer leak).
    const res = await fetch(
      `/api/hl/candles?coin=${encodeURIComponent(normCoin)}&interval=${interval}&lookbackMs=${lookbackMs}`,
    );
    if (!res.ok) return emptyResult(normCoin, interval, `proxy ${res.status}`);
    const json = (await res.json()) as { ok: boolean; result?: CandleResult; error?: string };
    if (!json.ok || !json.result) return emptyResult(normCoin, interval, json.error ?? 'proxy error');
    return json.result;
  } catch (err) {
    return emptyResult(normCoin, interval, err instanceof Error ? err.message : String(err));
  }
}

/** Fetch the combined multi-timeframe regime candle set via the cached proxy. */
export async function fetchRegimeCandlesViaProxy(
  coin: string,
): Promise<Record<string, CandleResult>> {
  const normCoin = coin.trim().toUpperCase();
  try {
    // Browser HTTP cache (respects the proxy max-age) — same rationale as candles:
    // the regime set is slow-moving, so serving repeat polls from cache cuts the
    // repeated multi-timeframe candle payload (origin transfer) to ~1 per window.
    const res = await fetch(`/api/hl/regime?coin=${encodeURIComponent(normCoin)}`);
    if (!res.ok) return {};
    const json = (await res.json()) as { ok: boolean; byInterval?: Record<string, CandleResult> };
    if (!json.ok || !json.byInterval) return {};
    return json.byInterval;
  } catch {
    return {};
  }
}
