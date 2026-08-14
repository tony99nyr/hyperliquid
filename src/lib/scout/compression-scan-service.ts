/**
 * Compression-squeeze scan (I/O) — the ONE place that fetches 4h candles and runs the
 * PURE `compressionRead` for a set of coins, so every consumer (today: the cycle
 * snapshot) shares identical logic. Mirrors htf-trend-scan-service. See
 * docs/scout/PREREGISTRATION_compression-straddle.md.
 *
 * READ-ONLY. Fail-soft per coin; injectable fetcher for tests. Returns a read PER
 * SCANNED COIN (squeeze state + channels always — so an OPEN position's mid-band exit
 * is checkable here) — `breakout != null` marks a fresh squeeze-resolution entry.
 */

import type { CandleInterval } from '@/lib/hyperliquid/candle-service';
import type { PriceCandle } from '@/types/trading-core';
import { compressionRead, type CompressionRead } from './compression-squeeze-signal-business-logic';

export interface CompressionCoinRead extends CompressionRead {
  coin: string;
}

export type CompressionCandleFetch = (
  coin: string,
  interval: CandleInterval,
  startMs: number,
  endMs: number,
) => Promise<{ stale: boolean; candles: PriceCandle[] }>;

export interface CompressionScanResult {
  reads: CompressionCoinRead[];
  /** Coverage tally: a dropped coin (stale/thin candles, a fetch throw) is VISIBLE,
   *  never silently indistinguishable from "no squeeze". */
  coverage: { requested: number; scanned: number; skipped: number };
}

const HOUR_MS = 3_600_000;
/** ~35 days of 4h bars (~210) covers bbPeriod(20)+bbwLookback(100)+grace with headroom. */
const LOOKBACK_HOURS = 35 * 24;
/** Minimum completed 4h bars for a trustworthy percentile: bbPeriod + bbwLookback. */
const MIN_4H_BARS = 121;

export async function scanCompressionSqueezes(
  coins: string[],
  now: number,
  fetchCandles?: CompressionCandleFetch,
): Promise<CompressionScanResult> {
  const fc: CompressionCandleFetch =
    fetchCandles ??
    (async (coin, interval, startMs, endMs) => {
      const { fetchCandles: realFc } = await import('@/lib/hyperliquid/candle-service');
      const res = await realFc(coin, interval, startMs, endMs);
      return { stale: res.stale, candles: res.candles };
    });

  const reads: CompressionCoinRead[] = [];
  let scanned = 0;

  for (const coin of coins) {
    try {
      const res = await fc(coin, '4h', now - LOOKBACK_HOURS * HOUR_MS, now);
      const completed = res.candles.slice(0, -1); // drop the in-progress bar
      if (res.stale || completed.length < MIN_4H_BARS) continue; // thin/stale → skipped
      const bars = completed.map((c) => ({ highPx: c.high, lowPx: c.low, closePx: c.close }));
      const read = compressionRead(bars);
      if (!read) continue;
      scanned++;
      reads.push({ coin, ...read });
    } catch {
      /* per-coin fail-soft → counts as skipped */
    }
  }

  return { reads, coverage: { requested: coins.length, scanned, skipped: coins.length - scanned } };
}
