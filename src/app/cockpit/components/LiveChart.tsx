'use client';

/**
 * LiveChart — the vendored 3-panel MiniChart (price + RSI + MACD with regime
 * shading) for the selected coin/timeframe, fed by the candle-service, with the
 * live last price overlaid above it. Candles are fetched client-side from the
 * public HL info endpoint and refreshed on an interval; the live last price
 * comes from the HL websocket via useHlOrderbook.
 *
 * MiniChart's regime config is keyed by TradingAsset (eth|btc). For coins
 * outside that set the chart still renders (regions just fall back to neutral).
 */

import { useEffect, useMemo, useState } from 'react';
import { css } from '@styled-system/css';
import MiniChart from './regime-chart/MiniChart';
import type { TradingAsset } from '@/lib/infrastructure/config/asset-config';
import type { PriceCandle } from '@/types/trading-core';
import {
  fetchCandles,
  type CandleInterval,
} from '@/lib/hyperliquid/candle-service';
import { useHlOrderbook } from '@/hooks/useHlOrderbook';
import { GH, ZONE_COLORS, fmtPx } from './panel-styles';

export interface LiveChartProps {
  coin: string;
  interval?: CandleInterval;
  /** How far back to fetch (ms). Default ~30 days. */
  lookbackMs?: number;
  refreshMs?: number;
}

const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_MS = 60_000;

/** Map a coin symbol to MiniChart's TradingAsset, defaulting to eth. */
function coinToAsset(coin: string): TradingAsset {
  return coin.trim().toUpperCase() === 'BTC' ? 'btc' : 'eth';
}

export default function LiveChart({
  coin,
  interval = '8h',
  lookbackMs = DEFAULT_LOOKBACK_MS,
  refreshMs = DEFAULT_REFRESH_MS,
}: LiveChartProps) {
  const [candles, setCandles] = useState<PriceCandle[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { lastPx, stale, status } = useHlOrderbook(coin);

  const asset = useMemo(() => coinToAsset(coin), [coin]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const res = await fetchCandles(coin, interval, Date.now() - lookbackMs);
      if (!active) return;
      setCandles(res.candles);
      setError(res.error ?? null);
    };
    void load();
    const timer = setInterval(load, refreshMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [coin, interval, lookbackMs, refreshMs]);

  return (
    <section
      data-testid="live-chart"
      className={css({
        bg: 'github.bgSecondary',
        border: '1px solid token(colors.github.border)',
        borderRadius: '8px',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      })}
    >
      <header className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' })}>
        <h2 className={css({ fontSize: 'sm', fontWeight: 'semibold', color: 'github.textBright' })}>
          {coin.toUpperCase()} · {interval}
        </h2>
        <span className={css({ display: 'flex', gap: '10px', alignItems: 'baseline' })}>
          <span
            data-testid="live-chart-lastpx"
            style={{ color: stale ? ZONE_COLORS.warn : ZONE_COLORS.ok }}
            className={css({ fontSize: 'sm', fontFamily: 'mono', fontWeight: 'bold' })}
          >
            {lastPx === null ? '—' : fmtPx(lastPx)}
          </span>
          <span style={{ color: GH.textMuted }} className={css({ fontSize: '10px' })}>
            {stale ? 'stale' : status}
          </span>
        </span>
      </header>

      {error && candles.length === 0 ? (
        <span className={css({ fontSize: 'xs', color: 'zone.warn' })}>chart unavailable: {error}</span>
      ) : (
        <MiniChart asset={asset} candles={candles} />
      )}
    </section>
  );
}
