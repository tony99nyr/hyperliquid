'use client';

/**
 * MarketRegimePanel (design handoff, right rail) — the multi-timeframe regime
 * read as the design's full panel: header (Market Regime · <COIN> + live dot),
 * one row per TF (1d/8h/1h/15m) with direction (BULL/BEAR/NEU) + a confidence
 * bar + RSI, and a net-bias footer ("BEAR · 3 of 4 TF"). Fed by useRegimeStrip
 * (candle-service, polled). Reuses the PURE regime-strip helpers.
 *
 * The parent reads `onNetBias` to learn the coin's dominant direction (for the
 * Open Positions alignment badge), so the regime is fetched ONCE per coin.
 */

import { useEffect } from 'react';
import { css } from '@styled-system/css';
import { useRegimeStrip } from '@/hooks/useRegimeStrip';
import { rsiBand, type RegimeStripRow } from './regime-strip-helpers';
import { ZONE_COLORS, GH, regimeColor, regimeAbbrev } from '../panel-styles';
import type { RegimeDir } from '../open-positions-helpers';

export interface MarketRegimePanelProps {
  coin: string;
  rowsOverride?: RegimeStripRow[];
  /** Called with the net bias direction whenever it changes (for alignment). */
  onNetBias?: (dir: RegimeDir) => void;
}

function rsiColor(rsi: number | null): string {
  const band = rsiBand(rsi);
  if (band === 'overbought') return ZONE_COLORS.danger;
  if (band === 'oversold') return ZONE_COLORS.ok;
  return GH.text;
}

/** Net bias: the confidence-weighted majority direction across timeframes. */
export function netBias(rows: RegimeStripRow[]): { dir: RegimeDir; count: number; total: number } {
  const live = rows.filter((r) => !r.noData);
  if (live.length === 0) return { dir: 'neutral', count: 0, total: 0 };
  let bull = 0;
  let bear = 0;
  for (const r of live) {
    if (r.regime === 'bullish') bull++;
    else if (r.regime === 'bearish') bear++;
  }
  const dir: RegimeDir = bull > bear ? 'bullish' : bear > bull ? 'bearish' : 'neutral';
  const count = dir === 'bullish' ? bull : dir === 'bearish' ? bear : Math.max(bull, bear);
  return { dir, count, total: live.length };
}

export default function MarketRegimePanel({ coin, rowsOverride, onNetBias }: MarketRegimePanelProps) {
  const live = useRegimeStrip(rowsOverride ? '' : coin);
  const rows = rowsOverride ?? live.rows;
  const bias = netBias(rows);

  useEffect(() => {
    onNetBias?.(bias.dir);
  }, [bias.dir, onNetBias]);

  const biasColor =
    bias.dir === 'bullish' ? ZONE_COLORS.ok : bias.dir === 'bearish' ? ZONE_COLORS.danger : GH.textMuted;
  const biasLabel =
    bias.total === 0
      ? 'reading…'
      : `${regimeAbbrev(bias.dir)} · ${bias.count} of ${bias.total} TF`;

  return (
    <section
      data-testid="market-regime-panel"
      className={css({ bg: 'cockpit.panel', border: '1px solid token(colors.github.border)', borderRadius: '12px' })}
    >
      <header className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '13px 15px 11px', borderBottom: '1px solid token(colors.github.borderSubtle)' })}>
        <h2 className={css({ fontFamily: 'sans', fontSize: '11px', letterSpacing: '0.14em', textTransform: 'uppercase', color: '#9aa4b5', fontWeight: 'semibold' })}>
          Market Regime · {coin.toUpperCase()}
        </h2>
        <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'zone.ok' })}>live</span>
      </header>

      <div className={css({ padding: '11px 15px 14px' })}>
        {rows.length === 0 ? (
          <span className={css({ fontFamily: 'mono', fontSize: 'xs', color: 'github.textMuted' })}>reading…</span>
        ) : (
          rows.map((r) => <RegimeRow key={r.timeframe} row={r} />)
        )}

        <div className={css({ marginTop: '11px', paddingTop: '11px', borderTop: '1px solid token(colors.github.borderSubtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' })}>
          <span className={css({ fontSize: '11px', color: 'github.textMuted' })}>Net bias</span>
          <span data-testid="net-bias" style={{ color: biasColor }} className={css({ fontFamily: 'mono', fontSize: '12px', fontWeight: 'semibold' })}>
            {biasLabel}
          </span>
        </div>
      </div>
    </section>
  );
}

function RegimeRow({ row }: { row: RegimeStripRow }) {
  const color = regimeColor(row.regime);
  const confWidth = `${Math.round(row.confidence * 100)}%`;
  return (
    <div className={css({ display: 'grid', gridTemplateColumns: '34px 56px 1fr 56px', gap: '10px', alignItems: 'center', paddingY: '7px' })}>
      <span data-testid={`regime-tf-${row.timeframe}`} className={css({ fontFamily: 'mono', fontSize: '11.5px', color: 'github.textMuted', fontFeatureSettings: '"tnum"' })}>
        {row.timeframe}
      </span>
      <span data-testid={`regime-label-${row.timeframe}`} style={{ color }} className={css({ fontFamily: 'mono', fontSize: '11px', fontWeight: 'semibold', letterSpacing: '0.05em' })}>
        {row.noData ? '—' : regimeAbbrev(row.regime)}
      </span>
      <span className={css({ height: '4px', bg: '#1b2230', borderRadius: '3px', overflow: 'hidden' })}>
        <span data-testid={`regime-conf-${row.timeframe}`} aria-hidden style={{ display: 'block', width: row.noData ? '0%' : confWidth, height: '100%', background: color }} />
      </span>
      <span data-testid={`regime-rsi-${row.timeframe}`} style={{ color: rsiColor(row.rsi) }} className={css({ fontFamily: 'mono', fontSize: '10.5px', textAlign: 'right', fontFeatureSettings: '"tnum"' })}>
        {row.rsi === null ? 'RSI —' : `RSI ${Math.round(row.rsi)}`}
      </span>
    </div>
  );
}
