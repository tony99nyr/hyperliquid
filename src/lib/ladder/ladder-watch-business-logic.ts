/**
 * PURE helpers for the ladder watcher (no I/O). The watcher evaluates triggers on the
 * most recent COMPLETED candle (never the in-progress bar — §3.4) and fails closed.
 */

import type { PriceCandle } from '@/types/trading-core';
import type { RungMarketSnapshot } from './ladder-trigger-evaluator';

/**
 * Build a market snapshot from a coin's candle series. The LAST element is the
 * in-progress bar; the trigger evaluates on the one BEFORE it (the last COMPLETED
 * candle). Fails closed (stale=true → evaluator never fires) when the feed is stale or
 * there aren't yet two candles (no completed bar to read). PURE.
 */
export function snapshotFromCandleResult(coin: string, candles: PriceCandle[], feedStale: boolean): RungMarketSnapshot {
  const c = coin.toUpperCase();
  if (feedStale || candles.length < 2) {
    return { coin: c, completedClose: 0, stale: true };
  }
  const completed = candles[candles.length - 2]; // [-1] is the in-progress bar
  if (!completed || !(completed.close > 0)) {
    return { coin: c, completedClose: 0, stale: true };
  }
  return { coin: c, completedClose: completed.close, completedVolume: completed.volume, stale: false };
}
