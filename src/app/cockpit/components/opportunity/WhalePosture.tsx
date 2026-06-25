'use client';

/**
 * WhalePosture — a compact per-coin summary of where the operator's FAVORITED
 * traders sit (net long/short + who's de-risking) from leader_positions +
 * leader_actions. Since the trade-watch daemon is favorites-gated, those feeds are
 * favorites-only, so this is "Favorites' Posture" — the "are my traders short ETH /
 * covering HYPE" read, native in the UI (no new HL calls).
 */

import { useMemo } from 'react';
import { css } from '@styled-system/css';
import { useLeaderPositionsTable } from '@/hooks/useLeaderPositionsTable';
import { useLeaderActionsFeed } from '@/hooks/useLeaderActionsFeed';
import type { LeaderPositionRow, LeaderActionRow } from '@/hooks/realtime-row-mappers';
import { ZONE_COLORS, GH, fmtCompactUsd } from '../panel-styles';
import { summarizeWhalePosture } from './opportunity-helpers';

export interface WhalePostureProps {
  coins: string[];
  positionsOverride?: LeaderPositionRow[];
  actionsOverride?: LeaderActionRow[];
}

export default function WhalePosture({ coins, positionsOverride, actionsOverride }: WhalePostureProps) {
  const livePos = useLeaderPositionsTable();
  const liveAct = useLeaderActionsFeed({ limit: 60 });
  const positions = positionsOverride ?? livePos.rows;
  const actions = actionsOverride ?? liveAct.rows;
  const rows = useMemo(() => summarizeWhalePosture(positions, actions, coins), [positions, actions, coins]);

  return (
    <section data-testid="whale-posture" className={css({ display: 'flex', flexDirection: 'column', gap: '8px', bg: 'cockpit.panel', border: '1px solid token(colors.github.border)', borderRadius: '12px', padding: '12px' })}>
      <header className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' })}>
        <h3 className={css({ fontFamily: 'label', fontSize: 'xs', fontWeight: 'bold', color: 'github.textBright', textTransform: 'uppercase', letterSpacing: '0.06em' })}>Favorites&apos; Posture</h3>
        <span className={css({ fontFamily: 'mono', fontSize: '9px', color: 'github.textMuted' })}>your favorites</span>
      </header>
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '5px' })}>
        {rows.map((r) => {
          const color = r.netSide === 'long' ? ZONE_COLORS.ok : r.netSide === 'short' ? ZONE_COLORS.danger : GH.textMuted;
          return (
            <div key={r.coin} data-testid="whale-row" data-coin={r.coin} className={css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontFamily: 'mono', fontSize: '11px' })}>
              <span className={css({ color: 'github.textBright', fontWeight: 'bold', width: '46px' })}>{r.coin}</span>
              <span style={{ color }} className={css({ fontFamily: 'label', fontSize: '10px', fontWeight: 'bold', letterSpacing: '0.04em', width: '64px' })}>
                {r.netSide === 'flat' ? '—' : `NET ${r.netSide.toUpperCase()}`}
              </span>
              <span className={css({ color: 'github.textMuted', flex: 1, textAlign: 'right' })}>
                {r.longCount}L / {r.shortCount}S · {fmtCompactUsd(Math.abs(r.netNotionalUsd))}
              </span>
              {r.coveringCount > 0 && (
                <span style={{ color: ZONE_COLORS.warn }} className={css({ fontSize: '9px', marginLeft: '8px', whiteSpace: 'nowrap' })}>⚠ {r.coveringCount} covering</span>
              )}
            </div>
          );
        })}
        {rows.length === 0 && <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>no leader data yet</span>}
      </div>
    </section>
  );
}
