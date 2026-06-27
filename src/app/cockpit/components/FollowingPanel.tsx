'use client';

/**
 * FollowingPanel — the cockpit's "Following" section: the leader positions the
 * operator has FOLLOWED (from the Traders tab). Each row shows the leader's live
 * position (side · entry · uPnL · health) with two actions: Copy → (open a pre-filled
 * entry preview for it) and Unfollow. Read-only mirror of OpenPositionsPanel's style —
 * it surfaces leaders' positions; it never trades. Discord alerts on a followed
 * leader's moves come from the watch daemon, independent of this panel.
 */

import { useFollowing } from '@/hooks/useFollowing';
import { computePositionHealth, markFromPosition, type HealthStatus } from '@/lib/cockpit/position-health-business-logic';
import { TRADEABLE_COINS } from './left-rail/top-traders-filter-helpers';
import { ZONE_COLORS, GH, fmtUsd, fmtPx } from './panel-styles';
import { css } from '@styled-system/css';

const HEALTH_COLOR: Record<HealthStatus, string> = {
  healthy: ZONE_COLORS.ok, caution: ZONE_COLORS.warn, critical: ZONE_COLORS.danger, unknown: GH.textMuted,
};
const HEALTH_LABEL: Record<HealthStatus, string> = {
  healthy: 'HEALTHY', caution: 'AT RISK', critical: 'NEAR LIQ', unknown: '—',
};

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export interface FollowingPanelProps {
  /** Copy a followed leader's position → open the pre-filled entry preview. */
  onCopy?: (coin: string, side: 'long' | 'short') => void;
}

export default function FollowingPanel({ onCopy }: FollowingPanelProps) {
  const { rows, loading, noFollows, unfollow } = useFollowing();

  return (
    <section
      data-testid="following-panel"
      className={css({ bg: 'github.bgSecondary', border: '1px solid token(colors.github.border)', borderRadius: '12px', overflow: 'hidden', flexShrink: 0 })}
    >
      <header className={css({ display: 'flex', alignItems: 'baseline', gap: '8px', padding: '13px 15px 10px', flexWrap: 'wrap' })}>
        <h2 className={css({ fontFamily: 'sans', fontSize: '12px', letterSpacing: '0.13em', textTransform: 'uppercase', color: 'github.text', fontWeight: 'semibold' })}>Following</h2>
        <span className={css({ fontFamily: 'mono', fontSize: '9.5px', color: 'cockpit.faint', letterSpacing: '0.03em' })}>leaders you track</span>
        <span data-testid="following-count" className={css({ marginLeft: 'auto', fontFamily: 'mono', fontSize: '11px', color: 'cockpit.faint' })}>{rows.length} tracked</span>
      </header>

      {noFollows ? (
        <p data-testid="following-empty" className={css({ padding: '8px 15px 18px', fontFamily: 'mono', fontSize: '11.5px', color: 'cockpit.faint', lineHeight: 1.5 })}>
          No followed positions. Open a trader in the <strong>Traders</strong> tab, click a position, and tap <strong>Follow</strong> — it shows here and pings you (Discord) when they change it.
        </p>
      ) : loading && rows.length === 0 ? (
        <p data-testid="following-loading" className={css({ padding: '8px 15px 18px', fontFamily: 'mono', fontSize: '11px', color: 'cockpit.faint' })}>loading…</p>
      ) : (
        <div className={css({ padding: '0 11px 12px', display: 'flex', flexDirection: 'column', gap: '7px' })}>
          {rows.map((r) => (
            <FollowingRowCard key={`${r.leaderAddress}|${r.coin}`} row={r} onCopy={onCopy} onUnfollow={() => void unfollow(r.leaderAddress, r.coin).catch(() => {})} />
          ))}
        </div>
      )}
    </section>
  );
}

function FollowingRowCard({
  row,
  onCopy,
  onUnfollow,
}: {
  row: ReturnType<typeof useFollowing>['rows'][number];
  onCopy?: (coin: string, side: 'long' | 'short') => void;
  onUnfollow: () => void;
}) {
  const p = row.position;
  const side = p?.side ?? null;
  const sideColor = side === 'long' ? ZONE_COLORS.ok : side === 'short' ? ZONE_COLORS.danger : GH.textMuted;
  const markPx = p ? markFromPosition(p.positionValue, p.size) : null;
  const health = computePositionHealth({ markPx, liquidationPx: p?.liquidationPx ?? null });
  const pnlColor = !p ? GH.textMuted : p.unrealizedPnl > 0 ? ZONE_COLORS.ok : p.unrealizedPnl < 0 ? ZONE_COLORS.danger : GH.textMuted;
  // Copy only works for coins the cockpit can trade (the chart/feed/entry are scoped
  // to TRADEABLE_COINS); disable with a reason for anything else the leader holds.
  const tradeable = (TRADEABLE_COINS as readonly string[]).includes(row.coin);
  const copyDisabled = !onCopy || !side || !tradeable;
  const copyReason = !side ? 'no live position to copy' : !tradeable ? `${row.coin} isn't tradeable in the cockpit` : undefined;

  return (
    <div data-testid="following-row" data-coin={row.coin} className={css({ display: 'flex', flexDirection: 'column', gap: '7px', padding: '11px 12px', bg: 'cockpit.row', border: '1px solid token(colors.github.borderSubtle)', borderRadius: '9px' })}>
      <div className={css({ display: 'flex', alignItems: 'center', gap: '8px' })}>
        <span className={css({ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0, flex: 1 })}>
          {side && (
            <span style={{ color: sideColor, background: `${sideColor}1f` }} className={css({ fontFamily: 'mono', fontSize: '10px', fontWeight: 'semibold', letterSpacing: '0.06em', paddingX: '6px', paddingY: '2px', borderRadius: '5px' })}>{side.toUpperCase()}</span>
          )}
          <span className={css({ fontFamily: 'mono', fontSize: '13px', fontWeight: 'semibold', color: 'github.textBright' })}>{row.coin}</span>
          <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'cockpit.faint' })}>{shortAddr(row.leaderAddress)}</span>
        </span>
        {p && (
          <span
            data-testid="following-health"
            aria-label={`Position health: ${HEALTH_LABEL[health.status]}${health.liqDistancePct != null ? `, ${health.liqDistancePct.toFixed(0)} percent to liquidation` : ''}`}
            title={health.liqDistancePct != null ? `${health.liqDistancePct.toFixed(1)}% to liquidation` : HEALTH_LABEL[health.status]}
            style={{ color: HEALTH_COLOR[health.status], borderColor: HEALTH_COLOR[health.status] }}
            className={css({ flexShrink: 0, fontFamily: 'mono', fontSize: '9px', fontWeight: 'bold', border: '1px solid', borderRadius: '4px', paddingX: '5px', paddingY: '1px' })}
          >
            {HEALTH_LABEL[health.status]}{health.liqDistancePct != null ? ` · ${health.liqDistancePct.toFixed(0)}%` : ''}
          </span>
        )}
      </div>

      {p ? (
        <div className={css({ display: 'flex', gap: '16px', flexWrap: 'wrap', fontFamily: 'mono', fontSize: '10.5px' })} style={{ fontFeatureSettings: '"tnum"' }}>
          <span className={css({ color: 'github.textMuted' })}>entry <span className={css({ color: 'github.text' })}>{fmtPx(p.entryPx)}</span></span>
          <span className={css({ color: 'github.textMuted' })}>mark <span className={css({ color: 'github.text' })}>{markPx != null ? fmtPx(markPx) : '—'}</span></span>
          <span className={css({ color: 'github.textMuted' })}>uPnL <span style={{ color: pnlColor }}>{fmtUsd(p.unrealizedPnl)}</span></span>
        </div>
      ) : (
        <span data-testid="following-stale" className={css({ fontFamily: 'mono', fontSize: '10px', color: 'cockpit.faint' })}>leader closed it (or we&apos;ve stopped tracking them)</span>
      )}

      <div className={css({ display: 'flex', gap: '6px' })}>
        <button
          type="button"
          data-testid="following-copy"
          disabled={copyDisabled}
          title={copyReason}
          aria-label={copyReason ? `Copy ${row.coin} — ${copyReason}` : `Copy ${row.coin} ${side ?? ''}`}
          onClick={() => side && tradeable && onCopy?.(row.coin, side)}
          style={{ borderColor: '#5b8cff', color: '#cfe0ff', background: 'rgba(91,140,255,0.12)' }}
          className={css({ fontFamily: 'mono', fontSize: '10px', fontWeight: 'bold', border: '1px solid', borderRadius: '5px', paddingX: '11px', paddingY: '8px', cursor: 'pointer', _disabled: { opacity: 0.5, cursor: 'not-allowed' }, _hover: { borderColor: 'github.link' }, _focusVisible: { outline: '2px solid token(colors.github.link)' } })}
        >
          Copy →
        </button>
        <button
          type="button"
          data-testid="following-unfollow"
          onClick={onUnfollow}
          aria-label={`Unfollow ${row.coin}`}
          className={css({ fontFamily: 'mono', fontSize: '10px', color: 'cockpit.faint', bg: 'transparent', border: '1px solid token(colors.github.borderSubtle)', borderRadius: '5px', paddingX: '11px', paddingY: '8px', cursor: 'pointer', _hover: { color: 'zone.danger', borderColor: 'rgba(242,77,94,0.4)' }, _focusVisible: { outline: '2px solid token(colors.github.link)' } })}
        >
          Unfollow
        </button>
      </div>
    </div>
  );
}
