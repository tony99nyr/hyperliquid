'use client';

/**
 * LadderChart — the ladder modal's price view: a 15m candlestick of the ladder's primary
 * coin (15m because rungs fire on COMPLETED 15m closes — the chart's timeframe must match
 * what the watcher evaluates) with EVERY rung's trigger/stop/target overlaid as labeled
 * price lines, plus the live mark. Reuses the cockpit's inner CandleChart (the heavy
 * lightweight-charts renderer, dynamically imported ssr:false) so the modal stays a thin
 * shell. Candles poll via useCandles; the live mark is passed in from the modal's shared
 * per-coin probe (one ws per coin, not one per surface).
 */

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { css } from '@styled-system/css';
import { useCandles } from '@/hooks/useCandles';
import { TERM, ZONE_COLORS, GH, fmtPx, fmtPctSigned } from '../panel-styles';
import type { TradePriceLine } from '../chart/candle-chart-helpers';
import { buildLadderChartLines } from '@/lib/ladder/ladder-projection-business-logic';
import type { LadderRung } from '@/lib/ladder/ladder-types';

const CandleChart = dynamic(() => import('../chart/CandleChart'), {
  ssr: false,
  loading: () => (
    <div data-testid="ladder-chart-loading" className={css({ height: '260px', display: 'grid', placeItems: 'center', color: 'github.textMuted', fontFamily: 'mono', fontSize: 'xs' })}>
      loading chart…
    </div>
  ),
});

const ROLE_STYLE: Record<'trigger' | 'stop' | 'target', { color: string; dashed: boolean }> = {
  trigger: { color: TERM.accent, dashed: false },
  stop: { color: ZONE_COLORS.danger, dashed: true },
  target: { color: ZONE_COLORS.ok, dashed: true },
};

export interface LadderChartProps {
  /** Primary coin to chart (the modal picks it; only this coin's rungs overlay). */
  coin: string;
  rungs: LadderRung[];
  /** Live mark from the modal's shared probe (drives the forming candle + header). */
  lastPx?: number | null;
  height?: number;
}

export default function LadderChart({ coin, rungs, lastPx = null, height = 260 }: LadderChartProps) {
  const { candles, loading, stale, error } = useCandles(coin, '15m');

  const extraLines = useMemo<TradePriceLine[]>(
    () => buildLadderChartLines(rungs, coin).map((l) => ({ price: l.price, title: l.title, color: ROLE_STYLE[l.role].color, dashed: ROLE_STYLE[l.role].dashed })),
    [rungs, coin],
  );

  // Session change from the first shown candle → the live mark (orientation, like the main chart).
  const changePct = useMemo(() => {
    if (candles.length < 2) return null;
    const open = candles[0].open;
    const close = lastPx ?? candles[candles.length - 1].close;
    return open ? ((close - open) / open) * 100 : null;
  }, [candles, lastPx]);

  return (
    <div data-testid="ladder-chart" className={css({ borderRadius: '11px', overflow: 'hidden' })} style={{ background: TERM.surface, border: '1px solid token(colors.github.border)' }}>
      <div className={css({ display: 'flex', alignItems: 'baseline', gap: '10px', padding: '9px 12px 0' })}>
        <span className={css({ fontFamily: 'label', fontSize: '12px', fontWeight: 'bold', color: 'github.textBright', letterSpacing: '0.02em' })}>{coin.toUpperCase()}</span>
        <span data-testid="ladder-chart-px" className={css({ fontFamily: 'mono', fontSize: '13px', fontWeight: 'bold' })} style={{ color: stale ? ZONE_COLORS.warn : GH.textBright, fontFeatureSettings: '"tnum"' }}>{lastPx == null ? '—' : fmtPx(lastPx)}</span>
        {changePct !== null && (
          <span className={css({ fontFamily: 'mono', fontSize: '11px' })} style={{ color: changePct >= 0 ? ZONE_COLORS.ok : ZONE_COLORS.danger, fontFeatureSettings: '"tnum"' }}>{fmtPctSigned(changePct)}</span>
        )}
        <span className={css({ marginLeft: 'auto', fontFamily: 'mono', fontSize: '9.5px', color: 'cockpit.faint' })}>15m · fires on close</span>
      </div>

      {error && candles.length === 0 ? (
        <div className={css({ height: '260px', display: 'grid', placeItems: 'center', color: 'zone.warn', fontFamily: 'mono', fontSize: 'xs' })}>chart unavailable</div>
      ) : loading && candles.length === 0 ? (
        <div className={css({ height: '260px', display: 'grid', placeItems: 'center', color: 'github.textMuted', fontFamily: 'mono', fontSize: 'xs' })}>loading {coin.toUpperCase()} 15m…</div>
      ) : (
        <div className={css({ padding: '6px 6px 4px' })}>
          <CandleChart candles={candles} lastPx={lastPx} extraLines={extraLines} height={height} coin={coin} interval="15m" status={stale ? 'rest' : 'live'} />
        </div>
      )}

      <div className={css({ display: 'flex', gap: '12px', padding: '0 12px 9px', fontFamily: 'mono', fontSize: '9.5px', color: 'github.textMuted' })}>
        <Legend color={TERM.accent} label="trigger" />
        <Legend color={ZONE_COLORS.danger} label="stop" />
        <Legend color={ZONE_COLORS.ok} label="target" />
      </div>
    </div>
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
