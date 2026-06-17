'use client';

/**
 * useCandles — the data hook for the live candlestick chart. Fetches the initial
 * OHLCV snapshot via the existing candle-service (HL public `candleSnapshot`),
 * then keeps it fresh on a short poll. The HL websocket client this repo ships
 * subscribes to l2Book / trades / allMids ONLY (no candle channel — see
 * hl-ws-client.ts), so per ADR/transport reuse we POLL candle-service rather than
 * rebuild the socket. The chart layers the live last price (from useHlOrderbook)
 * on top so the forming candle ticks between polls.
 *
 * Switching coin or interval drops the previous series immediately (during
 * render) so the chart visibly re-points instead of showing stale candles until
 * the next fetch resolves — same idiom as LiveChart/useHlOrderbook.
 */

import { useEffect, useState } from 'react';
import {
  fetchCandles,
  type CandleInterval,
} from '@/lib/hyperliquid/candle-service';
import type { PriceCandle } from '@/types/trading-core';

/** How far back to fetch per interval, tuned so each timeframe shows useful history. */
const LOOKBACK_MS: Record<CandleInterval, number> = {
  '1m': 6 * 60 * 60 * 1000, // 6h of 1m
  '5m': 24 * 60 * 60 * 1000, // 1d of 5m
  '15m': 3 * 24 * 60 * 60 * 1000, // 3d of 15m
  '1h': 10 * 24 * 60 * 60 * 1000, // 10d of 1h
  '4h': 40 * 24 * 60 * 60 * 1000, // 40d of 4h
  '8h': 60 * 24 * 60 * 60 * 1000, // analysis TF (not in the chart selector)
  '1d': 240 * 24 * 60 * 60 * 1000, // ~8mo of 1d
};

/** Poll cadence per interval (faster timeframes refresh more often). */
const REFRESH_MS: Record<CandleInterval, number> = {
  '1m': 5_000,
  '5m': 10_000,
  '15m': 15_000,
  '1h': 30_000,
  '4h': 60_000,
  '8h': 60_000,
  '1d': 60_000,
};

export interface UseCandlesState {
  candles: PriceCandle[];
  /** True until the first successful (or failed) fetch resolves. */
  loading: boolean;
  /** True when the last fetch failed and we are showing the prior set. */
  stale: boolean;
  error: string | null;
}

export function useCandles(coin: string, interval: CandleInterval): UseCandlesState {
  const [candles, setCandles] = useState<PriceCandle[]>([]);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Drop the previous selection's candles the instant coin/interval changes so
  // the chart re-points immediately (store-previous-prop-in-state idiom).
  const selectionKey = `${coin}|${interval}`;
  const [renderedKey, setRenderedKey] = useState(selectionKey);
  if (renderedKey !== selectionKey) {
    setRenderedKey(selectionKey);
    setCandles([]);
    setLoading(true);
    setStale(false);
    setError(null);
  }

  useEffect(() => {
    let active = true;
    const lookback = LOOKBACK_MS[interval];
    const load = async () => {
      const res = await fetchCandles(coin, interval, Date.now() - lookback);
      if (!active) return;
      setCandles(res.candles);
      setStale(res.stale);
      setError(res.error ?? null);
      setLoading(false);
    };
    void load();
    const timer = setInterval(load, REFRESH_MS[interval]);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [coin, interval]);

  return { candles, loading, stale, error };
}
