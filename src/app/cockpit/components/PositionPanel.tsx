'use client';

/**
 * PositionPanel — the user's live position(s) and, if a leader is being followed,
 * the leader's, side by side. User positions are realtime via usePositionPnl
 * (Supabase: positions + pnl tables, fed by executeIntent). Leader positions are
 * passed in from a server-fetched clearinghouseState (refreshed by the parent).
 */

import { css } from '@styled-system/css';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';
import { usePositionPnl } from '@/hooks/usePositionPnl';
import type { PnlSnapshot, PositionRow } from '@/hooks/realtime-row-mappers';
import {
  leaderPositionDisplay,
  userPositionDisplay,
  type PositionDisplay,
} from './position-panel-helpers';
import { GH, ZONE_COLORS, fmtPx, fmtUsd, pnlColor } from './panel-styles';

export interface PositionPanelProps {
  sessionId: string | null;
  /** Leader address being followed (label only); null = not following. */
  leaderAddress?: string | null;
  /** Leader positions from server-fetched clearinghouseState. */
  leaderPositions?: HlPosition[];
  /** Test/RSC seed for user side. */
  userOverride?: { positions: PositionRow[]; latestPnlByCoin: Record<string, PnlSnapshot> };
}

function PositionCard({ d }: { d: PositionDisplay }) {
  const sideColor = d.side === 'long' ? ZONE_COLORS.ok : ZONE_COLORS.danger;
  return (
    <div
      data-testid="position-card"
      data-side={d.side}
      className={css({
        bg: 'github.bg',
        border: '1px solid token(colors.github.borderSubtle)',
        borderRadius: '6px',
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
      })}
    >
      <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' })}>
        <span className={css({ fontSize: 'sm', fontWeight: 'bold', color: 'github.textBright' })}>{d.coin}</span>
        <span style={{ color: sideColor }} className={css({ fontSize: '10px', fontFamily: 'mono', textTransform: 'uppercase' })}>
          {d.side}
        </span>
      </div>
      <Row label="size" value={d.sz.toLocaleString('en-US', { maximumFractionDigits: 4 })} />
      <Row label="entry" value={fmtPx(d.entryPx)} />
      <Row label="mark" value={fmtPx(d.markPx)} />
      <Row
        label="uPnL"
        value={d.unrealizedPnlUsd === null ? '—' : fmtUsd(d.unrealizedPnlUsd)}
        color={d.unrealizedPnlUsd === null ? GH.textMuted : pnlColor(d.unrealizedPnlUsd)}
        testid="upnl"
      />
      <Row label="liq" value={fmtPx(d.liqPx)} />
      <Row label="lev" value={d.leverage === null ? '—' : `${d.leverage}x`} />
    </div>
  );
}

function Row({ label, value, color, testid }: { label: string; value: string; color?: string; testid?: string }) {
  return (
    <div className={css({ display: 'flex', justifyContent: 'space-between', fontSize: 'xs', fontFamily: 'mono' })}>
      <span className={css({ color: 'github.textMuted' })}>{label}</span>
      <span data-testid={testid} style={color ? { color } : { color: GH.text }}>{value}</span>
    </div>
  );
}

function Column({ title, displays, emptyLabel }: { title: string; displays: PositionDisplay[]; emptyLabel: string }) {
  return (
    <div data-testid="position-column" className={css({ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '0' })}>
      <span className={css({ fontSize: '10px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.05em' })}>
        {title}
      </span>
      {displays.length === 0 ? (
        <span className={css({ fontSize: 'xs', color: 'github.textMuted' })}>{emptyLabel}</span>
      ) : (
        displays.map((d) => <PositionCard key={`${title}-${d.coin}`} d={d} />)
      )}
    </div>
  );
}

export default function PositionPanel({
  sessionId,
  leaderAddress,
  leaderPositions = [],
  userOverride,
}: PositionPanelProps) {
  const live = usePositionPnl(userOverride ? null : sessionId);
  const positions = userOverride ? userOverride.positions : live.positions;
  const latestPnlByCoin = userOverride ? userOverride.latestPnlByCoin : live.latestPnlByCoin;

  const userDisplays = positions
    .filter((p) => p.side !== 'flat')
    .map((p) => userPositionDisplay(p, latestPnlByCoin[p.coin]));
  const leaderDisplays = leaderPositions.map(leaderPositionDisplay);

  return (
    <section
      data-testid="position-panel"
      className={css({
        bg: 'github.bgSecondary',
        border: '1px solid token(colors.github.border)',
        borderRadius: '8px',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      })}
    >
      <h2 className={css({ fontSize: 'sm', fontWeight: 'semibold', color: 'github.textBright' })}>Positions</h2>
      <div className={css({ display: 'flex', gap: '12px' })}>
        <Column title="You" displays={userDisplays} emptyLabel="No open position." />
        {leaderAddress && (
          <Column
            title={`Leader ${leaderAddress.slice(0, 6)}…`}
            displays={leaderDisplays}
            emptyLabel="Leader flat / no data."
          />
        )}
      </div>
    </section>
  );
}
