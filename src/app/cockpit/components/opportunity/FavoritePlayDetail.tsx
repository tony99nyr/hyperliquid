'use client';

/**
 * FavoritePlayDetail — the "where did they get in, and how far has it run?" drill-down
 * for one favorite's play. Opened by clicking a PlayCard. Answers the operator's
 * question: how LATE am I, and how much room is left?
 *
 *   - entry age ("opened 3h ago") — WHEN they got in
 *   - PositionHistoryChart — the entry line vs candles from open → now (the RUN);
 *     works for ANY coin (HL candles are generic), even un-tradeable memecoins
 *   - extension % + a chase read — how far past entry the market already is
 *   - "Stage this trade →" — seeds the EntryModal with this coin+side (discretionary,
 *     no-auto-fire). Enabled ONLY for tradeable coins; chart-only otherwise.
 *
 * a11y mirrors the other cockpit dialogs: role=dialog + aria-modal, focus moved in,
 * Esc closes, click-outside closes.
 */

import { useEffect, useRef } from 'react';
import { css } from '@styled-system/css';
import PositionHistoryChart from '../left-rail/PositionHistoryChart';
import { isOverExtended, type FavoritePlay } from '@/lib/cockpit/favorite-plays-business-logic';
import { GH, ZONE_COLORS, panelSurface, fmtUsd, fmtPx } from '../panel-styles';

function shortAddr(a: string): string {
  return a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
function ageLabel(openedAtMs: number | null, nowMs: number): string {
  if (openedAtMs == null) return 'open time unknown (held before we watched them)';
  const s = Math.max(0, Math.round((nowMs - openedAtMs) / 1000));
  if (s < 60) return `opened ${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `opened ${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `opened ${h}h ${m % 60}m ago`;
  return `opened ${Math.floor(h / 24)}d ${h % 24}h ago`;
}

export interface FavoritePlayDetailProps {
  play: FavoritePlay;
  nowMs: number;
  /** True when this coin is a supported tradeable market (Stage enabled). */
  tradeable: boolean;
  /** Seed the EntryModal with this play's coin + side (discretionary entry). */
  onStage: () => void;
  onClose: () => void;
}

export default function FavoritePlayDetail({ play, nowMs, tradeable, onStage, onClose }: FavoritePlayDetailProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sideColor = play.side === 'long' ? ZONE_COLORS.ok : ZONE_COLORS.danger;
  const extended = isOverExtended(play);

  useEffect(() => { closeRef.current?.focus(); }, []);

  return (
    <div
      ref={overlayRef}
      role="presentation"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
      className={css({ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: { base: 'flex-end', md: 'center' }, justifyContent: 'center', bg: 'rgba(1, 4, 9, 0.72)', padding: { base: '0', md: '16px' }, animation: 'backdropIn 0.18s ease-out' })}
    >
      <section
        data-testid="favorite-play-detail"
        role="dialog"
        aria-modal="true"
        aria-label={`${play.side} ${play.coin} play detail`}
        className={css({ ...panelSurface, width: '100%', maxWidth: { base: '100%', md: '520px' }, maxHeight: { base: '90vh', md: '90vh' }, overflowY: 'auto', borderRadius: { base: '12px 12px 0 0', md: '12px' }, padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', boxShadow: '0 16px 48px rgba(0,0,0,0.6)', animation: 'popupIn 0.22s cubic-bezier(0.16, 1, 0.3, 1)' })}
      >
        {/* Header */}
        <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' })}>
          <div className={css({ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 })}>
            <span className={css({ display: 'flex', alignItems: 'baseline', gap: '8px' })}>
              <span style={{ color: sideColor }} className={css({ fontFamily: 'label', fontSize: 'sm', fontWeight: 'bold', letterSpacing: '0.04em' })}>{play.side.toUpperCase()}</span>
              <span className={css({ fontFamily: 'mono', fontSize: 'md', fontWeight: 'bold', color: 'github.textBright' })}>{play.coin}</span>
              <span title={play.leaderAddress} className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>{shortAddr(play.leaderAddress)}</span>
            </span>
            <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>{ageLabel(play.detectedAtMs, nowMs)}</span>
          </div>
          <button
            ref={closeRef}
            type="button"
            data-testid="favorite-play-detail-close"
            onClick={onClose}
            aria-label="Close play detail"
            className={css({ flexShrink: 0, bg: 'github.bg', border: '1px solid token(colors.github.border)', borderRadius: '6px', color: 'github.text', fontSize: 'sm', fontWeight: 'bold', width: '28px', height: '28px', cursor: 'pointer', _hover: { color: 'github.textBright' } })}
          >
            ✕
          </button>
        </div>

        {/* The run: entry line vs candles from open → now. */}
        <PositionHistoryChart
          coin={play.coin}
          side={play.side}
          entryPx={play.entryPx}
          liquidationPx={null}
          openedAtMs={play.detectedAtMs}
        />

        {/* Stats row: entry → now → extension. */}
        <div className={css({ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px 12px' })}>
          <Stat label="Their entry" value={fmtPx(play.entryPx)} />
          <Stat label="Market now" value={fmtPx(play.markPx)} />
          <Stat
            label="Ran (in their favor)"
            value={play.extendedPct != null ? `${play.extendedPct >= 0 ? '+' : ''}${play.extendedPct.toFixed(1)}%` : '—'}
            color={extended ? ZONE_COLORS.warn : play.extendedPct != null && play.extendedPct >= 0 ? ZONE_COLORS.ok : GH.textMuted}
          />
          {play.unrealizedPnl != null && (
            <Stat label="Their uPnL" value={fmtUsd(play.unrealizedPnl)} color={play.unrealizedPnl >= 0 ? ZONE_COLORS.ok : ZONE_COLORS.danger} />
          )}
        </div>

        {/* How late am I? read */}
        <p className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted', lineHeight: 1.5, margin: 0 })}>
          {play.extendedPct == null
            ? 'No entry reference — judge the run off the chart above.'
            : extended
              ? `This has already run ${play.extendedPct.toFixed(1)}% past their entry — you'd be entering LATE (chase-risk). The chart shows how much of the move is behind you.`
              : `Only ${play.extendedPct.toFixed(1)}% past their entry — relatively early. The chart shows the move so far; size for the room left, not the move gone.`}
        </p>

        {/* Stage — discretionary entry (no-auto-fire). Tradeable coins only. */}
        {tradeable ? (
          <button
            type="button"
            data-testid="favorite-play-stage"
            onClick={onStage}
            className={css({ alignSelf: 'flex-start', fontFamily: 'mono', fontSize: '11px', fontWeight: 'bold', color: 'github.bg', bg: 'github.link', border: 'none', borderRadius: '6px', padding: '8px 14px', cursor: 'pointer', _hover: { opacity: 0.9 }, _focusVisible: { outline: '2px solid token(colors.github.link)', outlineOffset: '2px' } })}
          >
            Stage this trade → ({play.side === 'long' ? 'LONG' : 'SHORT'} {play.coin})
          </button>
        ) : (
          <span data-testid="favorite-play-untradeable" className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted', bg: 'github.bg', border: '1px solid token(colors.github.borderSubtle)', borderRadius: '6px', padding: '8px 10px' })}>
            {play.coin} isn&apos;t a supported market in the cockpit — chart only. Place this one manually on HL.
          </span>
        )}
        <span className={css({ fontFamily: 'mono', fontSize: '8px', color: 'github.textMuted' })}>
          Staging seeds the entry form with this coin + side. You set your OWN size and stop, and approve it — nothing fires on its own.
        </span>
      </section>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span className={css({ display: 'flex', flexDirection: 'column', gap: '1px' })}>
      <span className={css({ fontFamily: 'label', fontSize: '8px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.05em' })}>{label}</span>
      <span style={{ color: color ?? GH.textBright, fontFeatureSettings: '"tnum"' }} className={css({ fontFamily: 'mono', fontSize: '12px', fontWeight: 'bold' })}>{value}</span>
    </span>
  );
}
