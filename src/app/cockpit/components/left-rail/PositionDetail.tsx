'use client';

/**
 * PositionDetail — the per-position drill-down (Req C/D/E). Opened by clicking a
 * position row in the trader drawer; REPLACES the drawer body (single dialog — no
 * nested modal) with a back button. Shows: when the leader opened it (leader_actions
 * "first detected", or "held before we watched them" for the silent-baseline case),
 * a health read (liq-distance), the entry-vs-market chart, and a Follow toggle.
 */

import { useEffect, useState } from 'react';
import { css } from '@styled-system/css';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';
import { getBrowserClient } from '@/lib/cockpit/supabase-browser';
import {
  computePositionHealth,
  markFromPosition,
  type HealthStatus,
} from '@/lib/cockpit/position-health-business-logic';
import PositionHistoryChart from './PositionHistoryChart';
import { GH, ZONE_COLORS, fmtUsd, fmtPx, fmtCompactUsd } from '../panel-styles';

const HEALTH_COLOR: Record<HealthStatus, string> = {
  healthy: ZONE_COLORS.ok,
  caution: ZONE_COLORS.warn,
  critical: ZONE_COLORS.danger,
  unknown: GH.textMuted,
};
const HEALTH_LABEL: Record<HealthStatus, string> = {
  healthy: 'HEALTHY', caution: 'AT RISK', critical: 'NEAR LIQ', unknown: 'UNKNOWN',
};

export interface PositionDetailProps {
  leaderAddress: string;
  position: HlPosition;
  onBack: () => void;
  /** Test seam: skip the leader_actions / follows reads. */
  override?: { openedAtMs: number | null; following: boolean };
}

function MicroStat({ label, value }: { label: string; value: string }) {
  return (
    <span className={css({ display: 'flex', flexDirection: 'column', gap: '1px' })}>
      <span className={css({ fontFamily: 'label', fontSize: '8px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.05em' })}>{label}</span>
      <span style={{ fontFeatureSettings: '"tnum"' }} className={css({ fontFamily: 'mono', fontSize: '11px', color: 'github.textBright' })}>{value}</span>
    </span>
  );
}

export default function PositionDetail({ leaderAddress, position: p, onBack, override }: PositionDetailProps) {
  const addr = leaderAddress.toLowerCase();
  const coin = p.coin.toUpperCase();
  const [openedAtMs, setOpenedAtMs] = useState<number | null>(override?.openedAtMs ?? null);
  const [openLoaded, setOpenLoaded] = useState(Boolean(override));
  const [following, setFollowing] = useState(override?.following ?? false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (override) return;
    let active = true;
    const sb = getBrowserClient();
    void sb
      .from('leader_actions')
      .select('detected_at')
      .eq('leader_address', addr)
      .eq('coin', coin)
      .eq('kind', 'open')
      .order('detected_at', { ascending: false })
      .limit(1)
      .then(({ data }) => {
        if (!active) return;
        const d = (data?.[0] as { detected_at?: string } | undefined)?.detected_at;
        setOpenedAtMs(d ? new Date(d).getTime() : null);
        setOpenLoaded(true);
      });
    void sb
      .from('followed_positions')
      .select('id')
      .eq('leader_address', addr)
      .eq('coin', coin)
      .eq('status', 'active')
      .limit(1)
      .then(({ data }) => { if (active) setFollowing(Boolean(data?.length)); });
    return () => { active = false; };
  }, [addr, coin, override]);

  const markPx = markFromPosition(p.positionValue, p.size);
  const health = computePositionHealth({ markPx, liquidationPx: p.liquidationPx });
  const sideColor = p.side === 'long' ? ZONE_COLORS.ok : ZONE_COLORS.danger;
  const pnlColor = p.unrealizedPnl > 0 ? ZONE_COLORS.ok : p.unrealizedPnl < 0 ? ZONE_COLORS.danger : GH.textMuted;

  const openedLabel = !openLoaded
    ? 'checking…'
    : openedAtMs
      ? `first detected ${new Date(openedAtMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
      : 'held before we watched them';

  async function toggleFollow() {
    if (busy) return;
    setBusy(true);
    const next = !following;
    setFollowing(next);
    try {
      const res = await fetch('/api/cockpit/follows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ leaderAddress: addr, coin, action: next ? 'follow' : 'unfollow' }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setFollowing(!next); // revert
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="position-detail" className={css({ display: 'flex', flexDirection: 'column', gap: '12px' })}>
      <button
        type="button"
        data-testid="position-detail-back"
        onClick={onBack}
        className={css({ alignSelf: 'flex-start', fontFamily: 'mono', fontSize: '10px', color: 'github.link', bg: 'transparent', border: 'none', cursor: 'pointer', padding: 0, _hover: { textDecoration: 'underline' }, _focusVisible: { outline: '2px solid token(colors.github.link)' } })}
      >
        ← positions
      </button>

      <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' })}>
        <span className={css({ display: 'flex', alignItems: 'baseline', gap: '6px' })}>
          <span style={{ color: sideColor }} className={css({ fontFamily: 'label', fontSize: 'sm', fontWeight: 'bold', letterSpacing: '0.04em' })}>{p.side.toUpperCase()}</span>
          <span className={css({ fontFamily: 'mono', fontSize: 'sm', color: 'github.textBright', fontWeight: 'bold' })}>{coin}</span>
          {p.leverage !== null && <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>{p.leverage}x</span>}
        </span>
        <span
          data-testid="position-health"
          title={health.liqDistancePct != null ? `${health.liqDistancePct.toFixed(1)}% to liquidation` : 'liquidation price unknown'}
          style={{ color: HEALTH_COLOR[health.status], borderColor: HEALTH_COLOR[health.status] }}
          className={css({ fontFamily: 'mono', fontSize: '9px', fontWeight: 'bold', border: '1px solid', borderRadius: '4px', paddingX: '5px', paddingY: '1px' })}
        >
          {HEALTH_LABEL[health.status]}{health.liqDistancePct != null ? ` · ${health.liqDistancePct.toFixed(0)}% to liq` : ''}
        </span>
      </div>

      <span data-testid="position-opened" className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>{openedLabel}</span>

      <div className={css({ display: 'flex', gap: '14px', flexWrap: 'wrap' })}>
        <MicroStat label="entry" value={fmtPx(p.entryPx)} />
        <MicroStat label="mark" value={markPx != null ? fmtPx(markPx) : '—'} />
        <MicroStat label="liq" value={fmtPx(p.liquidationPx)} />
        <MicroStat label="size" value={`${p.size}`} />
        <MicroStat label="value" value={fmtCompactUsd(p.positionValue)} />
      </div>
      <span style={{ color: pnlColor, fontFeatureSettings: '"tnum"' }} className={css({ fontFamily: 'mono', fontSize: 'xs', fontWeight: 'bold' })}>
        uPnL {fmtUsd(p.unrealizedPnl)}
      </span>

      <PositionHistoryChart coin={coin} side={p.side} entryPx={p.entryPx} liquidationPx={p.liquidationPx} openedAtMs={openedAtMs} />

      <button
        type="button"
        data-testid="position-follow"
        aria-pressed={following}
        disabled={busy}
        onClick={toggleFollow}
        style={following ? { borderColor: '#5b8cff', color: '#e8ebf2', background: 'rgba(91,140,255,0.14)' } : undefined}
        className={css({ fontFamily: 'mono', fontSize: '11px', fontWeight: 'bold', color: 'github.text', bg: 'github.bg', border: '1px solid token(colors.github.borderSubtle)', borderRadius: '6px', padding: '8px', cursor: busy ? 'wait' : 'pointer', _hover: { borderColor: 'github.link' }, _focusVisible: { outline: '2px solid token(colors.github.link)' } })}
      >
        {following ? '✓ Following — tap to unfollow' : '+ Follow this position'}
      </button>
      <span className={css({ fontFamily: 'mono', fontSize: '9px', color: 'github.textMuted', lineHeight: 1.4 })}>
        Following surfaces a keep-matched suggestion when this leader reduces/closes — you approve every action (no auto-fire).
      </span>
    </div>
  );
}
