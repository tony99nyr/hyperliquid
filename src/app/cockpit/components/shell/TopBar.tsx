'use client';

/**
 * TopBar (design handoff, 52px) — brand + Cockpit/Performance segmented nav +
 * Equity / Today / PAPER-LIVE pill / feed-live dot. The view switch is the only
 * stateful control here; everything else is a live readout. The PAPER/LIVE pill
 * is a READOUT of the server-resolved mode (TRADING_MODE) — it is NOT a toggle
 * that changes mode (mode is flipped by ONE env var, ADR-0001), so it renders
 * as a status pill, not a button.
 */

import { css } from '@styled-system/css';
import type { TradingMode } from '@/types/fill';
import { TERM, fmtUsd } from '../panel-styles';

export type CockpitView = 'cockpit' | 'traders' | 'performance' | 'scout';

export interface TopBarProps {
  view: CockpitView;
  onViewChange: (v: CockpitView) => void;
  mode: TradingMode;
  /** Current account equity (cash + unrealized), or null until known. */
  equityUsd: number | null;
  /** Breakdown of equity into spot cash + perp value (for the hover tooltip). */
  equityBreakdown?: { perpUsd: number | null; spotUsd: number | null } | null;
  /** Today's realized PnL, or null until known. */
  todayUsd: number | null;
  /** Realtime feed health for the pulsing dot. null = no active session → hidden
   *  (the feed only means something while a session is live-tracked; showing
   *  "feed idle" with no session reads as a fault when nothing is wrong). */
  feedLive: boolean | null;
}

const NAV: { key: CockpitView; label: string }[] = [
  { key: 'cockpit', label: 'Cockpit' },
  { key: 'traders', label: 'Traders' },
  { key: 'performance', label: 'Performance' },
  { key: 'scout', label: 'Scout' }, // PAPER — autonomous scout, kept separate from the LIVE cockpit
];

export default function TopBar({ view, onViewChange, mode, equityUsd, equityBreakdown, todayUsd, feedLive }: TopBarProps) {
  const isLive = mode === 'live';
  const fmt2 = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  const equityTitle =
    equityBreakdown && (equityBreakdown.spotUsd != null || equityBreakdown.perpUsd != null)
      ? `Total account equity${equityBreakdown.spotUsd != null ? ` · cash (spot) ${fmt2(equityBreakdown.spotUsd)}` : ''}${equityBreakdown.perpUsd != null ? ` · perp (margin + uPnL) ${fmt2(equityBreakdown.perpUsd)}` : ''}`
      : undefined;
  return (
    <header
      data-testid="cockpit-topbar"
      className={css({
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'nowrap',
        gap: { base: '10px', md: '20px' },
        paddingX: { base: '12px', md: '18px' },
        height: '52px',
        flex: 'none',
        borderBottom: '1px solid token(colors.github.border)',
        bg: 'cockpit.bar',
      })}
    >
      {/* Brand */}
      <div className={css({ display: 'flex', alignItems: 'baseline', gap: '10px' })}>
        <span className={css({ fontFamily: 'mono', fontWeight: 'semibold', fontSize: '15px', letterSpacing: '0.04em', color: 'github.textBright' })}>
          HL COCKPIT
        </span>
        <span className={css({ fontFamily: 'mono', fontSize: '10.5px', letterSpacing: '0.14em', textTransform: 'uppercase', display: { base: 'none', sm: 'inline' } })} style={{ color: '#9aa4b5' }}>
          decision terminal
        </span>
      </div>

      {/* Segmented nav — desktop only; the mobile shell navigates via the bottom
          tab bar, so hiding this here is what stops the 52px bar from wrapping on
          a phone (brand + nav + 4 right-cluster readouts overflow 390px). */}
      <nav
        className={css({
          display: { base: 'none', lg: 'flex' },
          gap: '2px',
          bg: 'cockpit.navIdle',
          border: '1px solid token(colors.github.border)',
          borderRadius: '8px',
          padding: '3px',
        })}
      >
        {NAV.map((n) => {
          const active = view === n.key;
          return (
            <button
              key={n.key}
              type="button"
              data-testid={`nav-${n.key}`}
              data-active={active}
              aria-current={active ? 'page' : undefined}
              onClick={() => onViewChange(n.key)}
              style={{ background: active ? TERM.navActive : 'transparent', color: active ? '#e8ebf2' : '#9aa4b5' }}
              className={css({
                fontFamily: 'sans',
                fontSize: '12px',
                fontWeight: active ? 'semibold' : 'medium',
                paddingX: '14px',
                paddingY: '6px',
                borderRadius: '6px',
                border: 'none',
                cursor: 'pointer',
              })}
            >
              {n.label}
            </button>
          );
        })}
      </nav>

      <div className={css({ flex: 1 })} />

      {/* Right cluster */}
      <div className={css({ display: 'flex', alignItems: 'center', gap: { base: '14px', md: '22px' } })}>
        <Metric label="Equity" value={equityUsd == null ? '—' : `$${equityUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}`} title={equityTitle} />
        <Metric
          label="Today"
          value={todayUsd == null ? '—' : fmtUsd(todayUsd)}
          color={todayUsd == null ? undefined : todayUsd >= 0 ? '#19c98a' : '#f24d5e'}
        />
        <span className={css({ width: '1px', height: '26px', bg: 'rgba(255,255,255,0.08)', display: { base: 'none', sm: 'block' } })} />
        <span
          data-testid="mode-pill"
          data-mode={mode}
          style={{
            color: isLive ? '#f24d5e' : '#19c98a',
            borderColor: isLive ? 'rgba(242,77,94,0.4)' : 'rgba(25,201,138,0.4)',
            background: isLive ? 'rgba(242,77,94,0.08)' : 'rgba(25,201,138,0.08)',
          }}
          className={css({
            fontFamily: 'mono',
            fontSize: '11px',
            fontWeight: 'semibold',
            letterSpacing: '0.06em',
            paddingX: '12px',
            paddingY: '6px',
            borderRadius: '7px',
            border: '1px solid',
          })}
        >
          {isLive ? '● LIVE' : '◉ PAPER'}
        </span>
        {feedLive !== null && (
          <span
            data-testid="feed-indicator"
            className={css({ display: { base: 'none', sm: 'flex' }, alignItems: 'center', gap: '7px', fontFamily: 'mono', fontSize: '11px', color: 'zone.ok' })}
          >
            <span
              aria-hidden
              style={{ background: feedLive ? '#19c98a' : '#586273' }}
              className={css({ width: '7px', height: '7px', borderRadius: '50%', animation: feedLive ? 'livePulse 2s infinite' : 'none' })}
            />
            {feedLive ? 'feed live' : 'feed idle'}
          </span>
        )}
      </div>
    </header>
  );
}

function Metric({ label, value, color, title }: { label: string; value: string; color?: string; title?: string }) {
  return (
    <div title={title} className={css({ textAlign: 'right' })}>
      <div className={css({ fontFamily: 'sans', fontSize: '10px', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'cockpit.faint', fontWeight: 'semibold' })}>
        {label}
      </div>
      <div style={{ color: color ?? '#e8ebf2', fontFeatureSettings: '"tnum"' }} className={css({ fontFamily: 'mono', fontSize: '15px', fontWeight: 'semibold', letterSpacing: '0.01em' })}>
        {value}
      </div>
    </div>
  );
}
