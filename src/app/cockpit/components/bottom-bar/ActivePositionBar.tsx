'use client';

/**
 * ActivePositionBar — the HL-style bottom positions row: a dense band of position
 * numerics anchored by the big color-coded PnlHero (uPnL $/%/ROE, flashes on
 * update). Shows side · size · entry · live mark · notional · fees · time-in-trade
 * · leader. The always-visible sticky SafeExitButton sits directly below this in
 * the layout, so Safe-Exit is reachable from the position context too.
 *
 * Realtime via usePositionPnl (Supabase positions + pnl). When flat it renders a
 * quiet "no open position" strip so the bar stays present without competing.
 */

import { useEffect, useState } from 'react';
import { css } from '@styled-system/css';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';
import { usePositionPnl } from '@/hooks/usePositionPnl';
import type { PnlSnapshot, PositionRow } from '@/hooks/realtime-row-mappers';
import { activePositionStats } from '../position-panel-helpers';
import PnlHero from './PnlHero';
import StatCell from './StatCell';
import { ZONE_COLORS, GH, fmtPx, fmtCompactUsd, fmtUsd, panelSurface } from '../panel-styles';

export interface ActivePositionBarProps {
  sessionId: string | null;
  leaderAddress?: string | null;
  leaderPositions?: HlPosition[];
  /** Test/RSC seed for the user side. */
  userOverride?: { positions: PositionRow[]; latestPnlByCoin: Record<string, PnlSnapshot> };
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export default function ActivePositionBar({ sessionId, leaderAddress, leaderPositions = [], userOverride }: ActivePositionBarProps) {
  const live = usePositionPnl(userOverride ? null : sessionId);
  const positions = userOverride ? userOverride.positions : live.positions;
  const latestPnlByCoin = userOverride ? userOverride.latestPnlByCoin : live.latestPnlByCoin;

  // Tick for time-in-trade (never read Date.now() impurely during render).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const open = positions.filter((p) => p.side !== 'flat');
  const leaderShort = leaderAddress ? `${leaderAddress.slice(0, 6)}…` : null;

  return (
    <section
      data-testid="active-position-bar"
      className={css({ ...panelSurface, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '8px' })}
    >
      <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' })}>
        <span className={css({ fontFamily: 'label', fontSize: '10px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.08em' })}>
          Active Position
        </span>
        {leaderShort && (
          <span data-testid="position-leader" className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.link' })}>
            leader {leaderShort} · {leaderPositions.length} open
          </span>
        )}
      </div>

      {open.length === 0 ? (
        <span data-testid="position-flat" className={css({ fontFamily: 'mono', fontSize: 'sm', color: 'github.textMuted' })}>
          No open position — Safe-Exit idle.
        </span>
      ) : (
        open.map((p) => {
          const s = activePositionStats(p, latestPnlByCoin[p.coin], now);
          const sideColor = s.side === 'long' ? ZONE_COLORS.ok : ZONE_COLORS.danger;
          return (
            <div
              key={p.id}
              data-testid="active-position-row"
              data-side={s.side}
              className={css({
                display: 'flex',
                alignItems: 'center',
                gap: '18px',
                flexWrap: 'wrap',
                overflowX: 'auto',
              })}
            >
              <PnlHero pnlUsd={s.unrealizedPnlUsd} pnlPct={s.pnlPct} roePct={null} />
              <StatCell label="coin" value={s.coin} color={GH.textBright} />
              <StatCell label="side" value={s.side.toUpperCase()} color={sideColor} testid="position-side" />
              <StatCell label="size" value={s.sz.toLocaleString('en-US', { maximumFractionDigits: 4 })} />
              <StatCell label="entry" value={fmtPx(s.entryPx)} />
              <StatCell label="mark" value={fmtPx(s.markPx)} />
              <StatCell label="notional" value={s.notionalUsd === null ? '—' : fmtCompactUsd(s.notionalUsd)} />
              <StatCell label="fees" value={fmtUsd(-s.feesPaidUsd)} color={GH.textMuted} />
              <StatCell label="in trade" value={fmtDuration(s.timeInTradeMs)} color={GH.textMuted} />
            </div>
          );
        })
      )}
    </section>
  );
}
