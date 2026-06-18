'use client';

/**
 * LeaderActionFeed — the left rail's LIVE feed of watched-leader actions, read
 * straight from the trade-watch `leader_actions` event log via Supabase realtime
 * (useLeaderActionsFeed). Newest-first, compact: "0xecb6 ADD short ETH $258k · 4m".
 * READ-ONLY intel — it never triggers anything. Global (all watched leaders); the
 * trader-detail drawer scopes its own copy to one address.
 */

import { useEffect, useState } from 'react';
import { css } from '@styled-system/css';
import { useLeaderActionsFeed } from '@/hooks/useLeaderActionsFeed';
import type { LeaderActionKind, LeaderActionRow } from '@/hooks/realtime-row-mappers';
import { GH, ZONE_COLORS } from '../panel-styles';

/** Action kind → color + verb. open/add build exposure (ok), reduce/close cut it. */
const KIND_META: Record<LeaderActionKind, { color: string; verb: string }> = {
  open: { color: ZONE_COLORS.ok, verb: 'OPEN' },
  add: { color: ZONE_COLORS.ok, verb: 'ADD' },
  reduce: { color: ZONE_COLORS.warn, verb: 'REDUCE' },
  close: { color: ZONE_COLORS.danger, verb: 'CLOSE' },
  flip: { color: ZONE_COLORS.warn, verb: 'FLIP' },
};

function shortAddr(a: string): string {
  return a.length <= 10 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function relTime(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function fmtNotional(n: number | null): string {
  if (n == null) return '';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(abs / 1e3).toFixed(0)}k`;
  return `$${abs.toFixed(0)}`;
}

function ActionLine({ a, now }: { a: LeaderActionRow; now: number }) {
  const meta = KIND_META[a.kind];
  const side = a.newSide ?? a.prevSide;
  const notional = fmtNotional(a.notionalUsd);
  return (
    <li
      data-testid="leader-action-row"
      className={css({ display: 'flex', alignItems: 'baseline', gap: '6px', listStyle: 'none', margin: 0, padding: '2px 0', fontFamily: 'mono', fontSize: '10px', lineHeight: '1.3', minWidth: '0', overflowX: 'hidden' })}
    >
      <span className={css({ color: 'github.textMuted', flex: 'none' })}>{shortAddr(a.leaderAddress)}</span>
      <span style={{ color: meta.color, fontWeight: 'bold' }} className={css({ flex: 'none' })}>{meta.verb}</span>
      {side && <span style={{ color: side === 'long' ? ZONE_COLORS.ok : ZONE_COLORS.danger }} className={css({ flex: 'none' })}>{side}</span>}
      <span className={css({ color: 'github.textBright', flex: 'none' })}>{a.coin}</span>
      {notional && <span className={css({ color: 'github.textMuted', fontFeatureSettings: '"tnum"' })}>{notional}</span>}
      <span className={css({ flex: 1 })} />
      <span className={css({ color: 'github.textMuted', flex: 'none', fontFeatureSettings: '"tnum"' })}>{relTime(a.detectedAt, now)}</span>
    </li>
  );
}

export default function LeaderActionFeed() {
  const { rows, loaded } = useLeaderActionsFeed({ limit: 12 });
  // `now` drives relative times — refreshed on an interval; lazy init keeps the
  // first paint stable (no Date.now() read impurely during render).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div
      data-testid="leader-action-feed"
      className={css({ borderTop: '1px solid token(colors.github.borderSubtle)', paddingTop: '8px', display: 'flex', flexDirection: 'column', gap: '5px', minHeight: '0' })}
    >
      <div className={css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between' })}>
        <span className={css({ fontFamily: 'label', fontSize: '10px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.06em' })}>
          Leader activity
        </span>
        <span
          role="status"
          aria-label={loaded ? 'Feed live' : 'Feed connecting'}
          style={{ color: loaded ? ZONE_COLORS.ok : GH.textMuted }}
          className={css({ fontFamily: 'mono', fontSize: '9px' })}
        >
          {loaded ? 'live' : (<><span aria-hidden>◌ </span>connecting</>)}
        </span>
      </div>
      {!loaded ? null : rows.length === 0 ? (
        <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>
          No recent leader activity.
        </span>
      ) : (
        <ol aria-label="Leader activity feed" className={css({ display: 'flex', flexDirection: 'column', gap: '1px', listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto', maxHeight: '150px' })}>
          {rows.map((a) => (
            <ActionLine key={a.id} a={a} now={now} />
          ))}
        </ol>
      )}
    </div>
  );
}
