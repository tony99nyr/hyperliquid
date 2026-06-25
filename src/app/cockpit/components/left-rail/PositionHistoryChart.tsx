'use client';

/**
 * PositionHistoryChart — entry-vs-market-vs-now for ONE leader position (Req C).
 *
 * Fetches a now-anchored candle window sized to the position's age (pickChartWindow
 * keeps the bar count under HL's ~5000 cap) and overlays the leader's entry + liq
 * lines on the inner CandleChart (reused, dynamic/ssr:false). The entry line vs the
 * candles shows where they got in relative to the market then; the rightmost candle
 * is "now". entryPx comes from leader_positions (always present, silent-baseline-safe).
 */

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { css } from '@styled-system/css';
import type { PriceCandle } from '@/types/trading-core';
import { fetchCandlesViaProxy } from '@/lib/hyperliquid/candle-client';
import type { CandleInterval } from '@/lib/hyperliquid/candle-service-business-logic';
import { pickChartWindow } from '@/lib/cockpit/position-health-business-logic';

const CandleChart = dynamic(() => import('../chart/CandleChart'), {
  ssr: false,
  loading: () => (
    <div data-testid="position-chart-loading" className={css({ height: '220px', display: 'grid', placeItems: 'center', fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>
      loading chart…
    </div>
  ),
});

export interface PositionHistoryChartProps {
  coin: string;
  side: 'long' | 'short';
  entryPx: number | null;
  liquidationPx: number | null;
  /** When the leader opened it (leader_actions.detected_at), or null (held before we watched). */
  openedAtMs: number | null;
}

export default function PositionHistoryChart({ coin, side, entryPx, liquidationPx, openedAtMs }: PositionHistoryChartProps) {
  const [candles, setCandles] = useState<PriceCandle[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const { interval, lookbackMs } = pickChartWindow(openedAtMs, Date.now());
    void fetchCandlesViaProxy(coin, interval as CandleInterval, lookbackMs)
      .then((res) => {
        if (!active) return;
        if (res.error && res.candles.length === 0) setError(res.error);
        setCandles(res.candles);
      })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [coin, openedAtMs]);

  if (error && !candles?.length) {
    return <div data-testid="position-chart-error" className={css({ height: '120px', display: 'grid', placeItems: 'center', fontFamily: 'mono', fontSize: '10px', color: 'zone.danger' })}>chart unavailable — {error}</div>;
  }
  if (candles === null) {
    return <div data-testid="position-chart-loading" className={css({ height: '220px', display: 'grid', placeItems: 'center', fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>loading chart…</div>;
  }
  return (
    <div data-testid="position-history-chart">
      <CandleChart
        candles={candles}
        coin={coin}
        trade={{ side, entryPx, stopPx: liquidationPx ?? null, targetPx: null }}
        height={240}
      />
    </div>
  );
}
