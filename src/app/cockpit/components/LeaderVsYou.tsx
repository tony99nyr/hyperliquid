'use client';

/**
 * LeaderVsYou — the side-by-side "leader's position vs yours on this coin" panel
 * (Item 4), with an ALIGNMENT readout that is the trail-the-leader exit cue.
 * States: aligned · leader trimming · leader covered/flipped · leader adding into
 * a loss (martingale caution). The state is shown as an on-palette CSS status dot
 * (font-independent — never a tofu box) plus a color-coded text label.
 *
 * Renders only when the session FOLLOWS a leader AND the operator holds a position
 * on the displayed coin (otherwise the comparison is meaningless — nothing to
 * align to). The user side is realtime via usePositionPnl; the leader side is the
 * live, short-polled positions passed down from the parent (useLeaderPositions).
 *
 * The leader baseline (size first seen) is captured on first observation so a
 * later trim/add is detectable. READ-ONLY throughout.
 */

import { useState } from 'react';
import { css } from '@styled-system/css';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';
import { usePositionPnl } from '@/hooks/usePositionPnl';
import type { PnlSnapshot, PositionRow } from '@/hooks/realtime-row-mappers';
import { userPositionDisplay, leaderPositionDisplay, type PositionDisplay } from './position-panel-helpers';
import { deriveAlignment, leaderPositionForCoin, type UserSide } from './leader-alignment-helpers';
import { GH, ZONE_COLORS, fmtPx, fmtUsd, panelSurface, pnlColor } from './panel-styles';

export interface LeaderVsYouProps {
  sessionId: string | null;
  coin: string;
  leaderAddress: string | null;
  /** Live (short-polled) leader positions from the parent. */
  leaderPositions: HlPosition[];
  /** Test/RSC seed for the user side. */
  userOverride?: { positions: PositionRow[]; latestPnlByCoin: Record<string, PnlSnapshot> };
}

export default function LeaderVsYou({
  sessionId,
  coin,
  leaderAddress,
  leaderPositions,
  userOverride,
}: LeaderVsYouProps) {
  const live = usePositionPnl(userOverride ? null : sessionId);
  const positions = userOverride ? userOverride.positions : live.positions;
  const latestPnlByCoin = userOverride ? userOverride.latestPnlByCoin : live.latestPnlByCoin;

  const norm = coin.trim().toUpperCase();
  const userPos = positions.find((p) => p.side !== 'flat' && p.coin.toUpperCase() === norm);
  const leaderPos = leaderPositionForCoin(leaderPositions, norm);

  // Capture the leader's baseline size (first observation this coin) so a later
  // trim/add is detectable. Tracked in state via the store-previous-value idiom
  // (no ref-during-render): reset the baseline when the coin/leader key changes,
  // and latch the FIRST non-null leader size we observe under that key.
  const key = `${leaderAddress ?? ''}:${norm}`;
  const [baseline, setBaseline] = useState<{ key: string; size: number | null }>({
    key,
    size: leaderPos ? leaderPos.size : null,
  });
  if (baseline.key !== key) {
    setBaseline({ key, size: leaderPos ? leaderPos.size : null });
  } else if (baseline.size == null && leaderPos) {
    setBaseline({ key, size: leaderPos.size });
  }

  // Only meaningful when following AND holding a position on this coin.
  if (!leaderAddress || !userPos) return null;

  const userDisplay = userPositionDisplay(userPos, latestPnlByCoin[userPos.coin]);
  const leaderDisplay = leaderPos ? leaderPositionDisplay(leaderPos) : null;
  const alignment = deriveAlignment({
    coin: norm,
    userSide: userPos.side as UserSide,
    leaderPosition: leaderPos,
    leaderBaselineSize: baseline.key === key ? baseline.size : (leaderPos ? leaderPos.size : null),
  });

  const alignColor =
    alignment.state === 'aligned'
      ? ZONE_COLORS.ok
      : alignment.state === 'leader-trimming'
        ? ZONE_COLORS.warn
        : ZONE_COLORS.danger;

  return (
    <section
      data-testid="leader-vs-you"
      data-alignment={alignment.state}
      className={css({ ...panelSurface, padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' })}
    >
      <header className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' })}>
        <h2 className={css({ fontFamily: 'label', fontSize: 'sm', fontWeight: 'bold', color: 'github.textBright', textTransform: 'uppercase', letterSpacing: '0.06em' })}>
          Leader vs You
        </h2>
        <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.link' })}>
          {leaderAddress.slice(0, 6)}…{leaderAddress.slice(-4)}
        </span>
      </header>

      {/* Alignment readout — the exit cue. */}
      <div
        data-testid="alignment-readout"
        style={{ borderColor: alignColor }}
        className={css({
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          border: '1px solid',
          borderRadius: '6px',
          padding: '7px 10px',
          bg: 'github.bg',
        })}
      >
        {/* Font-independent status dot (no color-emoji dependency → no tofu).
            The color + the label below carry the meaning; this is decorative. */}
        <span
          aria-hidden
          data-testid="alignment-dot"
          style={{ backgroundColor: alignColor }}
          className={css({
            flex: 'none',
            width: '8px',
            height: '8px',
            borderRadius: '50%',
          })}
        />
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '1px', minWidth: '0' })}>
          <span data-testid="alignment-label" style={{ color: alignColor }} className={css({ fontFamily: 'label', fontSize: 'xs', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.04em' })}>
            {alignment.label}
          </span>
          <span className={css({ fontSize: '11px', color: 'github.text', lineHeight: '1.3' })}>{alignment.cue}</span>
        </div>
      </div>

      {/* Side-by-side cards. */}
      <div className={css({ display: 'flex', gap: '10px' })}>
        <MiniCard title="You" d={userDisplay} />
        <MiniCard title="Leader" d={leaderDisplay} emptyLabel="Flat / closed" />
      </div>
    </section>
  );
}

function MiniCard({ title, d, emptyLabel }: { title: string; d: PositionDisplay | null; emptyLabel?: string }) {
  return (
    <div className={css({ flex: 1, minWidth: '0', display: 'flex', flexDirection: 'column', gap: '4px' })}>
      <span className={css({ fontFamily: 'label', fontSize: '9px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.06em' })}>
        {title}
      </span>
      {!d ? (
        <span className={css({ fontFamily: 'mono', fontSize: 'xs', color: 'github.textMuted' })}>{emptyLabel ?? '—'}</span>
      ) : (
        <div
          data-testid={`lvy-card-${title.toLowerCase()}`}
          data-side={d.side}
          className={css({
            bg: 'github.bg',
            border: '1px solid token(colors.github.borderSubtle)',
            borderRadius: '6px',
            padding: '7px 9px',
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
          })}
        >
          <span style={{ color: d.side === 'long' ? ZONE_COLORS.ok : ZONE_COLORS.danger }} className={css({ fontFamily: 'mono', fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase' })}>
            {d.side}
          </span>
          <MiniRow label="size" value={d.sz.toLocaleString('en-US', { maximumFractionDigits: 4 })} />
          <MiniRow label="entry" value={fmtPx(d.entryPx)} />
          <MiniRow label="uPnL" value={d.unrealizedPnlUsd == null ? '—' : fmtUsd(d.unrealizedPnlUsd)} color={d.unrealizedPnlUsd == null ? GH.textMuted : pnlColor(d.unrealizedPnlUsd)} />
          <MiniRow label="lev" value={d.leverage == null ? '—' : `${d.leverage}×`} />
        </div>
      )}
    </div>
  );
}

function MiniRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className={css({ display: 'flex', justifyContent: 'space-between', fontSize: 'xs', fontFamily: 'mono' })}>
      <span className={css({ color: 'github.textMuted' })}>{label}</span>
      <span style={{ color: color ?? GH.text, fontFeatureSettings: '"tnum"' }}>{value}</span>
    </div>
  );
}
