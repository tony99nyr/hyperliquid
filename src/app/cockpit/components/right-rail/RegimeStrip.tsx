'use client';

/**
 * RegimeStrip — the per-timeframe regime read (1d / 8h / 1h / 15m) as dense
 * NUMBERS: regime label + confidence% + RSI, color-coded by regime, with an RSI
 * over/oversold tint. Fed by useRegimeStrip (candle-service, polled).
 */

import { css } from '@styled-system/css';
import { useRegimeStrip } from '@/hooks/useRegimeStrip';
import {
  rsiBand,
  type RegimeStripRow,
} from './regime-strip-helpers';
import { GH, ZONE_COLORS, regimeColor, regimeAbbrev } from '../panel-styles';

export interface RegimeStripProps {
  coin: string;
  /** Test seed: render fixed rows instead of fetching. */
  rowsOverride?: RegimeStripRow[];
}

function rsiColor(rsi: number | null): string {
  const band = rsiBand(rsi);
  if (band === 'overbought') return ZONE_COLORS.danger;
  if (band === 'oversold') return ZONE_COLORS.ok;
  return GH.text;
}

export default function RegimeStrip({ coin, rowsOverride }: RegimeStripProps) {
  const live = useRegimeStrip(rowsOverride ? '' : coin);
  const rows = rowsOverride ?? live.rows;

  return (
    <div
      data-testid="regime-strip"
      className={css({ display: 'flex', flexDirection: 'column', gap: '4px' })}
    >
      <span className={css({ fontFamily: 'label', fontSize: '10px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.08em' })}>
        Multi-Timeframe Regime
      </span>
      {rows.length === 0 ? (
        <span className={css({ fontSize: 'xs', color: 'github.textMuted', fontFamily: 'mono' })}>reading…</span>
      ) : (
        <div className={css({ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: '2px 10px', alignItems: 'center' })}>
          {rows.map((r) => (
            <RegimeRow key={r.timeframe} row={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function RegimeRow({ row }: { row: RegimeStripRow }) {
  const color = regimeColor(row.regime);
  return (
    <>
      <span
        data-testid={`regime-tf-${row.timeframe}`}
        className={css({ fontFamily: 'mono', fontSize: '11px', color: 'github.textMuted', fontFeatureSettings: '"tnum"' })}
      >
        {row.timeframe}
      </span>
      <span
        data-testid={`regime-label-${row.timeframe}`}
        style={{ color }}
        className={css({ fontFamily: 'label', fontSize: '11px', fontWeight: 'bold', letterSpacing: '0.04em' })}
      >
        {row.noData ? '—' : regimeAbbrev(row.regime)}
      </span>
      <span
        data-testid={`regime-conf-${row.timeframe}`}
        style={{ color }}
        className={css({ fontFamily: 'mono', fontSize: '11px', textAlign: 'right', fontFeatureSettings: '"tnum"' })}
      >
        {row.noData ? '' : `${Math.round(row.confidence * 100)}%`}
      </span>
      <span
        data-testid={`regime-rsi-${row.timeframe}`}
        style={{ color: rsiColor(row.rsi) }}
        className={css({ fontFamily: 'mono', fontSize: '11px', textAlign: 'right', fontFeatureSettings: '"tnum"' })}
      >
        {row.rsi === null ? 'RSI —' : `RSI ${Math.round(row.rsi)}`}
      </span>
    </>
  );
}
