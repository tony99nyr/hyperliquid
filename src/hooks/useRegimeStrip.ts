'use client';

/**
 * useRegimeStrip — the per-timeframe regime read for the right-rail strip. Fetches
 * 1d / 8h / 1h / 15m candles (the health-engine analysis set) via candle-service
 * and computes, per timeframe, the regime + confidence + latest RSI as NUMBERS.
 * Polled on a slow cadence (regimes move slowly; this isn't the live tape).
 *
 * Pure derivation lives in regime-strip-helpers.ts so the numbers are fixture-
 * tested without I/O.
 */

import { useEffect, useState } from 'react';
import { fetchRegimeCandlesViaProxy } from '@/lib/hyperliquid/candle-client';
import {
  buildRegimeStrip,
  REGIME_STRIP_TIMEFRAMES,
  type RegimeStripRow,
} from '@/app/cockpit/components/right-rail/regime-strip-helpers';

const REFRESH_MS = 60_000;

export interface RegimeStripState {
  rows: RegimeStripRow[];
  loading: boolean;
  error: string | null;
}

export function useRegimeStrip(coin: string): RegimeStripState {
  const [rows, setRows] = useState<RegimeStripRow[]>([]);
  // Loading is true only while a fetch is in flight for a real coin; empty coin
  // (test/override convention, mirrors useHlOrderbook('')) is inert from the start.
  const [loading, setLoading] = useState(coin !== '');
  const [error, setError] = useState<string | null>(null);

  // Reset on coin change (store-previous-prop-in-state idiom).
  const [renderedCoin, setRenderedCoin] = useState(coin);
  if (renderedCoin !== coin) {
    setRenderedCoin(coin);
    setRows([]);
    setLoading(coin !== '');
    setError(null);
  }

  useEffect(() => {
    // Empty coin = inert: never fetch, leave the (already non-loading) state.
    if (!coin) return;
    let active = true;
    const load = async () => {
      const byInterval = await fetchRegimeCandlesViaProxy(coin);
      if (!active) return;
      setRows(buildRegimeStrip(byInterval));
      const anyError = REGIME_STRIP_TIMEFRAMES.map((i) => byInterval[i]?.error).find(Boolean);
      setError(anyError ?? null);
      setLoading(false);
    };
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [coin]);

  return { rows, loading, error };
}
