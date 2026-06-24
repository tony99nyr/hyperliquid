'use client';

/**
 * CandleChartPanel — the center stage. Owns the chart timeframe, streams candles
 * (useCandles) + the live last price (useHlOrderbook), derives a one-glance
 * trend/regime readout (detectMarketRegime over the displayed candles), and
 * overlays the active trade's entry/stop/target. The heavy lightweight-charts
 * renderer is dynamically imported with ssr:false (it's client-only — SSR would
 * crash on `document`), so this panel is safe to render server-side as a shell.
 */

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { css } from '@styled-system/css';
import type { CandleInterval } from '@/lib/hyperliquid/candle-service';
import { useCandles } from '@/hooks/useCandles';
import { useHlOrderbook } from '@/hooks/useHlOrderbook';
import { useUrlParamState } from '@/hooks/useUrlParamState';
import { detectMarketRegime } from '@/lib/strategy/analysis/market-regime-detector';
import type { ActiveTrade, OpportunityLevels } from './candle-chart-helpers';
import TimeframeTabs, { CHART_TIMEFRAMES } from './TimeframeTabs';
import {
  GH,
  ZONE_COLORS,
  TERM,
  fmtPx,
  fmtPctSigned,
  panelSurface,
  regimeColor,
  regimeAbbrev,
} from '../panel-styles';

// Client-only: lightweight-charts touches `document` + holds a chart instance.
const CandleChart = dynamic(() => import('./CandleChart'), {
  ssr: false,
  loading: () => (
    <div
      data-testid="candle-chart-loading"
      className={css({ height: { base: '250px', lg: '460px' }, display: 'grid', placeItems: 'center', color: 'github.textMuted', fontFamily: 'mono', fontSize: 'xs' })}
    >
      loading chart…
    </div>
  ),
});

export interface CandleChartPanelProps {
  coin: string;
  /** Active trade overlay (entry/stop/target), or null when flat. */
  trade?: ActiveTrade | null;
  /** Rubric opportunity levels to overlay when flat (entry zone / inval / target). */
  opportunity?: OpportunityLevels | null;
  /** Test seed: skip the timeframe selector default. */
  initialTimeframe?: CandleInterval;
}

export default function CandleChartPanel({
  coin,
  trade = null,
  opportunity = null,
  initialTimeframe = '15m',
}: CandleChartPanelProps) {
  // Timeframe is mirrored to the `?tf=` URL param so refresh + back/forward retain
  // the selection. SSR-safe: first render is `initialTimeframe`, then the URL wins.
  const [timeframe, setTimeframe] = useUrlParamState<CandleInterval>('tf', initialTimeframe, CHART_TIMEFRAMES);
  const { candles, loading, stale, error } = useCandles(coin, timeframe);
  const { lastPx, stale: pxStale, status } = useHlOrderbook(coin);

  // One-glance trend: regime over the displayed candles + session change.
  const regime = useMemo(() => {
    if (candles.length < 51) return null;
    return detectMarketRegime(candles, candles.length - 1);
  }, [candles]);

  const sessionChangePct = useMemo(() => {
    if (candles.length < 2) return null;
    const open = candles[0].open;
    const close = lastPx ?? candles[candles.length - 1].close;
    if (!open) return null;
    return ((close - open) / open) * 100;
  }, [candles, lastPx]);

  return (
    <section
      data-testid="candle-chart-panel"
      className={css({
        ...panelSurface,
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '12px',
        minHeight: '0',
        // Mobile: size to content (don't shrink the canvas to a sliver — the
        // cut-off-chart bug). Desktop (lg): GROW to fill the left column so the
        // chart uses the full container height (the column is just tabs + chart).
        flexShrink: 0,
        flexGrow: { base: 0, lg: 1 },
        // Clip the lightweight-charts canvas to the card so it can never bleed
        // over the panels below (mobile: the chart sits above the focal
        // Open-Positions stack — design 11-mobile-cockpit).
        overflow: 'hidden',
      })}
    >
      <header className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' })}>
        <div className={css({ display: 'flex', alignItems: 'baseline', gap: '12px' })}>
          <h2 className={css({ fontFamily: 'label', fontSize: 'md', fontWeight: 'bold', color: 'github.textBright', letterSpacing: '0.02em' })}>
            {coin.toUpperCase()}
          </h2>
          <span
            data-testid="chart-lastpx"
            style={{ color: pxStale ? ZONE_COLORS.warn : GH.textBright, fontFeatureSettings: '"tnum"' }}
            className={css({ fontFamily: 'mono', fontSize: 'lg', fontWeight: 'bold' })}
          >
            {lastPx === null ? '—' : fmtPx(lastPx)}
          </span>
          {sessionChangePct !== null && (
            <span
              data-testid="chart-change"
              style={{ color: sessionChangePct >= 0 ? ZONE_COLORS.ok : ZONE_COLORS.danger, fontFeatureSettings: '"tnum"' }}
              className={css({ fontFamily: 'mono', fontSize: 'sm' })}
            >
              {fmtPctSigned(sessionChangePct)}
            </span>
          )}
        </div>
        <div className={css({ display: 'flex', alignItems: 'center', gap: '10px' })}>
          {regime && (
            <span
              data-testid="chart-regime"
              style={{ color: regimeColor(regime.regime), borderColor: regimeColor(regime.regime) }}
              className={css({
                fontFamily: 'label',
                fontSize: '10px',
                fontWeight: 'bold',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                border: '1px solid',
                borderRadius: '4px',
                paddingX: '6px',
                paddingY: '2px',
              })}
            >
              {regimeAbbrev(regime.regime)} {Math.round(regime.confidence * 100)}%
            </span>
          )}
          <TimeframeTabs value={timeframe} onChange={setTimeframe} />
        </div>
      </header>

      {error && candles.length === 0 ? (
        <div
          data-testid="chart-error"
          className={css({ height: { base: '250px', lg: '460px' }, display: 'grid', placeItems: 'center', color: 'zone.warn', fontFamily: 'mono', fontSize: 'xs' })}
        >
          chart unavailable: {error}
        </div>
      ) : loading && candles.length === 0 ? (
        <div
          className={css({ height: { base: '250px', lg: '460px' }, display: 'grid', placeItems: 'center', color: 'github.textMuted', fontFamily: 'mono', fontSize: 'xs' })}
        >
          loading {coin.toUpperCase()} {timeframe}…
        </div>
      ) : (
        <CandleChart candles={candles} lastPx={lastPx} trade={trade} opportunity={opportunity} coin={coin} interval={timeframe} status={status} />
      )}

      <footer className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>
        <span className={css({ display: 'flex', gap: '12px' })}>
          <Legend color="#5b8cff" label="MA20" />
          <Legend color="#d9a441" label="MA50" />
          {trade && <Legend color={TERM.accent} label="ENTRY" />}
          {trade?.stopPx != null && <Legend color={ZONE_COLORS.danger} label="STOP" />}
          {trade?.targetPx != null && <Legend color={ZONE_COLORS.ok} label="TARGET" />}
        </span>
        <span data-testid="chart-feed-status">
          {stale || pxStale ? 'stale feed' : status}
        </span>
      </footer>
    </section>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className={css({ display: 'inline-flex', alignItems: 'center', gap: '4px' })}>
      <span style={{ background: color }} className={css({ width: '10px', height: '2px', display: 'inline-block' })} />
      {label}
    </span>
  );
}
