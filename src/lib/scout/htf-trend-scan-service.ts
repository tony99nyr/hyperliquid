/**
 * HTF-trend scan (I/O) — the ONE place that fetches DAILY candles and runs the PURE
 * `htfTrendRead` for a set of coins, so every consumer (today: the cycle snapshot in
 * scripts/scout-cycle.ts; later: a daily trigger) shares identical logic. Mirrors
 * reversion-scan-service. See docs/scout/PREREGISTRATION_htf-trend.md.
 *
 * READ-ONLY. Fail-soft per coin (a candle blip drops that coin, never the scan). The
 * candle fetcher is injectable so orchestration is unit-testable without HL I/O; the
 * pure decision (`htfTrendRead`) is fixture-tested in its own module.
 *
 * Returns a read PER SCANNED COIN (not just breakouts): the channel context lets an
 * OPEN htf-trend position's 10-day-close-through EXIT be checked from the same section,
 * with a single fetch — `breakout != null` is the subset that are fresh ENTRY candidates.
 */

import type { CandleInterval } from '@/lib/hyperliquid/candle-service';
import type { PriceCandle } from '@/types/trading-core';
import { htfTrendRead, type HtfTrendRead } from './htf-trend-signal-business-logic';

export interface HtfTrendCoinRead extends HtfTrendRead {
  coin: string;
}

export type HtfCandleFetch = (
  coin: string,
  interval: CandleInterval,
  startMs: number,
  endMs: number,
) => Promise<{ stale: boolean; candles: PriceCandle[] }>;

export interface HtfTrendScanResult {
  reads: HtfTrendCoinRead[];
  /** Coverage tally so a dropped coin (stale/thin candles, a fetch throw) is VISIBLE, not
   *  silently indistinguishable from "no breakout" — which would make the htf-trend
   *  forward-test look more complete than it is. `scanned` = coins that reached the read. */
  coverage: { requested: number; scanned: number; skipped: number };
}

const DAY_MS = 86_400_000;
/** ~70 daily bars covers the 20-day entry channel + 20-bar ATR + drop-the-in-progress-bar
 *  with generous headroom for exchange gaps. */
const LOOKBACK_DAYS = 70;
/** Minimum completed daily bars to attempt a read: the largest window (entry 20) + ATR
 *  prior close + the current bar + a small buffer. Below this `htfTrendRead` returns null. */
const MIN_DAILY_BARS = 24;

/**
 * Scan `coins` for daily Donchian reads. A missing fetcher defaults to the real candle
 * service (lazy import keeps this module's pure imports light and lets tests inject a
 * fake without touching HL).
 */
export async function scanHtfTrend(
  coins: string[],
  now: number,
  fetchCandles?: HtfCandleFetch,
): Promise<HtfTrendScanResult> {
  const fc: HtfCandleFetch =
    fetchCandles ??
    (async (coin, interval, startMs, endMs) => {
      const { fetchCandles: realFc } = await import('@/lib/hyperliquid/candle-service');
      const res = await realFc(coin, interval, startMs, endMs);
      return { stale: res.stale, candles: res.candles };
    });

  const reads: HtfTrendCoinRead[] = [];
  let scanned = 0;

  for (const coin of coins) {
    try {
      const res = await fc(coin, '1d', now - LOOKBACK_DAYS * DAY_MS, now);
      // Drop the in-progress daily bar; the read evaluates COMPLETED bars only.
      const completed = res.candles.slice(0, -1);
      if (res.stale || completed.length < MIN_DAILY_BARS) continue; // too thin/stale → skipped
      const bars = completed.map((c) => ({ highPx: c.high, lowPx: c.low, closePx: c.close }));
      const read = htfTrendRead(bars);
      if (!read) continue; // insufficient window → skipped
      scanned++;
      reads.push({ coin, ...read });
    } catch {
      /* per-coin fail-soft → the coin is left out of `scanned` (counts as skipped) */
    }
  }

  return { reads, coverage: { requested: coins.length, scanned, skipped: coins.length - scanned } };
}
