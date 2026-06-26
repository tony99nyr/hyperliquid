'use client';

/**
 * PositionInsightsModal — the operator's OWN open-position drill-down. Opened by
 * clicking a row in OpenPositionsPanel. Surfaces, in one place: when it was opened
 * + how long held, the entry-vs-market RUN chart, full health (liq distance +
 * alignment vs regime), and the latest ATR insight — where a protective stop should
 * sit given current volatility, and how far liquidation sits beyond it (cushion).
 *
 * Read-only insight surface: the trade actions (Reduce / Close / Adjust leverage)
 * re-use the panel's existing modal seams via callbacks — NO new execution path,
 * no-auto-fire preserved. a11y mirrors the other cockpit dialogs.
 */

import { useEffect, useMemo, useRef } from 'react';
import { css } from '@styled-system/css';
import type { PnlSnapshot, PositionRow } from '@/hooks/realtime-row-mappers';
import { useCandles } from '@/hooks/useCandles';
import { computePositionHealth, type HealthStatus } from '@/lib/cockpit/position-health-business-logic';
import { HOLD_TIMEFRAMES, suggestStopFrac, liquidationCushion } from '@/lib/cockpit/stop-suggestion-business-logic';
import PositionHistoryChart from './left-rail/PositionHistoryChart';
import { positionHealth, uPnlPct, type RegimeDir } from './open-positions-helpers';
import { userPositionDisplay } from './position-panel-helpers';
import { GH, ZONE_COLORS, TERM, fmtPx, fmtUsd, fmtCompactUsd } from './panel-styles';

const HEALTH_COLOR: Record<HealthStatus, string> = {
  healthy: ZONE_COLORS.ok, caution: ZONE_COLORS.warn, critical: ZONE_COLORS.danger, unknown: GH.textMuted,
};
const HEALTH_LABEL: Record<HealthStatus, string> = {
  healthy: 'HEALTHY', caution: 'AT RISK', critical: 'NEAR LIQ', unknown: 'UNKNOWN',
};

/** "held 2d 4h" / "held 3h 12m" from the open timestamp. nowMs injected (no Date in render). */
function heldLabel(openedAtMs: number | null | undefined, nowMs: number): string {
  if (openedAtMs == null) return 'open time unknown';
  const m = Math.max(0, Math.floor((nowMs - openedAtMs) / 60_000));
  if (m < 60) return `held ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `held ${h}h ${m % 60}m`;
  return `held ${Math.floor(h / 24)}d ${h % 24}h`;
}

export interface PositionInsightsModalProps {
  pos: PositionRow;
  pnl: PnlSnapshot | undefined;
  regime: RegimeDir;
  /** Injected clock (parent ticks it) so "held" updates without a Date() in render. */
  nowMs: number;
  onReduce: () => void;
  onClose: () => void;
  onAdjust: () => void;
  onDismiss: () => void;
}

export default function PositionInsightsModal({
  pos, pnl, regime, nowMs, onReduce, onClose, onAdjust, onDismiss,
}: PositionInsightsModalProps) {
  const d = userPositionDisplay(pos, pnl);
  const side = d.side;
  const sideColor = side === 'long' ? ZONE_COLORS.ok : ZONE_COLORS.danger;

  const health = positionHealth({ side, entryPx: d.entryPx, markPx: d.markPx, leverage: d.leverage, liqPxOverride: d.liqPx, regime });
  const liqHealth = computePositionHealth({ markPx: d.markPx, liquidationPx: health.liqPx });
  const pct = uPnlPct(side, d.entryPx, d.markPx);
  const upnl = d.unrealizedPnlUsd;
  const upnlColor = upnl == null ? GH.text : upnl >= 0 ? ZONE_COLORS.ok : ZONE_COLORS.danger;

  // Latest ATR insight: where a protective stop should sit (swing TF) + the cushion
  // between that stop and liquidation. Reuses the entry-form stop math.
  const swing = HOLD_TIMEFRAMES.swing;
  const candles = useCandles(pos.coin, swing.interval);
  const suggestedStopFrac = useMemo(
    () => suggestStopFrac(candles.candles, swing.atrMult, swing.atrPeriod),
    [candles.candles, swing.atrMult, swing.atrPeriod],
  );
  const ref = d.markPx ?? d.entryPx;
  const suggestedStopPx = suggestedStopFrac != null && ref != null
    ? side === 'long' ? ref * (1 - suggestedStopFrac) : ref * (1 + suggestedStopFrac)
    : null;
  const stopCushion = liquidationCushion(ref, suggestedStopPx, health.liqPx);
  const notionalUsd = (d.entryPx != null ? d.entryPx : 0) * pos.sz;

  const overlayRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, []);

  return (
    <div
      ref={overlayRef}
      role="presentation"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onDismiss(); } }}
      onClick={(e) => { if (e.target === overlayRef.current) onDismiss(); }}
      className={css({ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: { base: 'flex-end', md: 'center' }, justifyContent: 'center', bg: 'rgba(1,4,9,0.72)', padding: { base: '0', md: '16px' }, overflowY: 'auto', animation: 'backdropIn 0.16s ease-out' })}
    >
      <section
        data-testid="position-insights-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${pos.coin} position insights`}
        className={css({ width: '100%', maxWidth: { base: '100%', md: '560px' }, maxHeight: '92vh', overflowY: 'auto', bg: 'github.bgSecondary', border: '1px solid token(colors.github.border)', borderRadius: { base: '14px 14px 0 0', md: '14px' }, padding: '18px', display: 'flex', flexDirection: 'column', gap: '14px', boxShadow: '0 16px 48px rgba(0,0,0,0.6)', animation: 'popupIn 0.22s cubic-bezier(0.16,1,0.3,1)' })}
      >
        {/* Header */}
        <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' })}>
          <div className={css({ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 })}>
            <span className={css({ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' })}>
              <span className={css({ fontFamily: 'mono', fontSize: 'md', fontWeight: 'bold', color: 'github.textBright' })}>{pos.coin}-PERP</span>
              <span style={{ color: sideColor, background: `${sideColor}1f` }} className={css({ fontFamily: 'mono', fontSize: '10px', fontWeight: 'bold', letterSpacing: '0.06em', paddingX: '7px', paddingY: '2px', borderRadius: '5px' })}>{side.toUpperCase()}</span>
              <span className={css({ fontFamily: 'mono', fontSize: '11px', color: 'github.textMuted' })}>{pos.sz.toLocaleString('en-US', { maximumFractionDigits: 4 })}{d.leverage != null ? ` · ${d.leverage}×` : ''}</span>
            </span>
            <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>{heldLabel(pos.createdAt, nowMs)} · ≈ {fmtCompactUsd(notionalUsd)} notional</span>
          </div>
          <button
            ref={closeRef}
            type="button"
            data-testid="position-insights-close"
            onClick={onDismiss}
            aria-label="Close position insights"
            className={css({ flexShrink: 0, bg: 'github.bg', border: '1px solid token(colors.github.border)', borderRadius: '6px', color: 'github.text', fontSize: 'sm', fontWeight: 'bold', width: '28px', height: '28px', cursor: 'pointer', _hover: { color: 'github.textBright' } })}
          >✕</button>
        </div>

        {/* The run: entry line vs candles since open. */}
        <PositionHistoryChart coin={pos.coin} side={side} entryPx={d.entryPx} liquidationPx={health.liqPx} openedAtMs={pos.createdAt ?? null} />

        {/* uPnL / entry / mark */}
        <div className={css({ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px 14px' })}>
          <Stat label="Entry" value={fmtPx(d.entryPx)} />
          <Stat label="Mark" value={fmtPx(d.markPx)} />
          <Stat label="uPnL" value={`${upnl == null ? '—' : fmtUsd(upnl)}${pct == null ? '' : ` (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`}`} color={upnlColor} />
        </div>

        {/* Health */}
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '8px', bg: 'github.bg', border: '1px solid token(colors.github.borderSubtle)', borderRadius: '8px', padding: '11px 13px' })}>
          <div className={css({ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' })}>
            <span style={{ color: HEALTH_COLOR[liqHealth.status] }} className={css({ fontFamily: 'label', fontSize: '10px', fontWeight: 'bold', letterSpacing: '0.06em', border: '1px solid', borderRadius: '4px', paddingX: '6px', paddingY: '1px' })}>{HEALTH_LABEL[liqHealth.status]}</span>
            <span data-testid="insights-alignment" style={{ color: health.alignColor, background: `${health.alignColor}1f` }} className={css({ fontFamily: 'mono', fontSize: '10px', fontWeight: 'semibold', letterSpacing: '0.06em', paddingX: '7px', paddingY: '2px', borderRadius: '5px' })}>{health.alignLabel}</span>
            <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>vs {pos.coin} regime</span>
          </div>
          <div className={css({ display: 'flex', justifyContent: 'space-between', fontFamily: 'mono', fontSize: '10px' })}>
            <span className={css({ color: 'github.textMuted' })}>liq {fmtPx(health.liqPx)}</span>
            <span style={{ color: health.liqColor }}>{health.liqDistPct == null ? '—' : `${health.liqDistPct.toFixed(1)}%`} away</span>
          </div>
          <div className={css({ height: '4px', bg: '#1b2230', borderRadius: '3px', overflow: 'hidden' })}>
            <div style={{ width: health.liqBarWidth, height: '100%', background: health.liqColor }} />
          </div>
        </div>

        {/* Latest ATR insight: where a protective stop belongs + cushion to liq. */}
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '5px', bg: 'github.bg', border: '1px solid token(colors.github.borderSubtle)', borderRadius: '8px', padding: '11px 13px' })}>
          <span className={css({ fontFamily: 'label', fontSize: '9px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.06em' })}>Protective stop (ATR {swing.interval})</span>
          {suggestedStopPx != null ? (
            <>
              <span className={css({ fontFamily: 'mono', fontSize: '12px', color: 'github.text' })} style={{ fontFeatureSettings: '"tnum"' }}>
                ≈ {fmtPx(suggestedStopPx)} <span className={css({ color: 'github.textMuted' })}>({((suggestedStopFrac ?? 0) * 100).toFixed(1)}% from mark)</span>
              </span>
              {stopCushion != null && (
                <span data-testid="insights-stop-cushion" style={{ color: stopCushion < 1.5 ? ZONE_COLORS.danger : stopCushion < 2.5 ? ZONE_COLORS.warn : ZONE_COLORS.ok }} className={css({ fontFamily: 'mono', fontSize: '10px' })}>
                  liquidation sits {stopCushion.toFixed(1)}× beyond that stop
                </span>
              )}
            </>
          ) : (
            <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>{candles.loading ? 'measuring volatility…' : 'ATR unavailable — judge the stop off the chart.'}</span>
          )}
        </div>

        {/* Actions — reuse the panel's existing reduce-only / leverage seams. */}
        <div className={css({ display: 'flex', gap: '8px', flexWrap: 'wrap' })}>
          <button type="button" data-testid="insights-adjust" onClick={onAdjust} className={css({ fontFamily: 'sans', fontSize: '12px', fontWeight: 'medium', color: 'cockpit.accent', bg: 'cockpit.button', border: '1px solid', borderColor: 'rgba(91,140,255,0.32)', borderRadius: '7px', paddingX: '14px', paddingY: '9px', cursor: 'pointer' })}>
            {d.leverage != null ? `${d.leverage}× lev` : 'Set lev'}
          </button>
          <button type="button" data-testid="insights-reduce" onClick={onReduce} className={css({ fontFamily: 'sans', fontSize: '12px', fontWeight: 'medium', color: 'github.text', bg: 'cockpit.button', border: '1px solid token(colors.github.border)', borderRadius: '7px', paddingX: '14px', paddingY: '9px', cursor: 'pointer' })}>Reduce</button>
          <button type="button" data-testid="insights-close-position" onClick={onClose} style={{ color: ZONE_COLORS.danger, background: 'rgba(242,77,94,0.08)', borderColor: 'rgba(242,77,94,0.32)' }} className={css({ fontFamily: 'sans', fontSize: '12px', fontWeight: 'semibold', border: '1px solid', borderRadius: '7px', paddingX: '16px', paddingY: '9px', cursor: 'pointer' })}>Close</button>
        </div>
        <span className={css({ fontFamily: 'mono', fontSize: '8px', color: 'github.textMuted' })} style={{ color: TERM.faint }}>Insights are read-only; Reduce/Close still run through the approved reduce-only seam.</span>
      </section>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span className={css({ display: 'flex', flexDirection: 'column', gap: '1px' })}>
      <span className={css({ fontFamily: 'label', fontSize: '8px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.05em' })}>{label}</span>
      <span style={{ color: color ?? GH.textBright, fontFeatureSettings: '"tnum"' }} className={css({ fontFamily: 'mono', fontSize: '13px', fontWeight: 'bold' })}>{value}</span>
    </span>
  );
}
