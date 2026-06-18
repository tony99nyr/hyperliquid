'use client';

/**
 * TraderDetailDrawer — the "is this trader safe to follow?" detail panel, opened
 * by clicking a TopTradersRail row. Three reads, numbers-first:
 *   1. LIVE positions — via useTraderPositions: read from the trade-watch feed
 *      (Supabase leader_positions) when the watcher covers this leader (zero HL
 *      load), else fetched on demand from HL. Per position side/coin/size/entry/
 *      uPnL/leverage, color-coded; loading+error; a source badge marks which.
 *   2. STATS — the rated wallet's metrics (Sharpe / win% / PF / maxDD / PnL /
 *      median hold / nFills) + composite.
 *   3. RISK/HEALTH flags — color-coded chips with a one-line meaning each (the
 *      0x418aa6 lesson), plus a one-line "safe to follow?" verdict.
 * Footer: "Mirror this →" surfaces the exact run-session command (copy button) —
 * it does NOT execute (Claude-proposes / you-approve). NO-AUTO-FIRE preserved.
 *
 * A11y mirrors ApprovalPopup: role=dialog + aria-modal, focus moved in on open,
 * the rest of the page inert/aria-hidden, Tab trapped, Esc closes. Mobile: the
 * dialog is a bottom sheet on small screens, a centered modal on desktop.
 */

import { useEffect, useRef, useState } from 'react';
import { css } from '@styled-system/css';
import type { TopTraderRow } from '@/lib/hyperliquid/top-traders-service';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';
import { useTraderPositions } from '@/hooks/useTraderPositions';
import {
  GH,
  ZONE_COLORS,
  fmtCompactUsd,
  fmtUsd,
  fmtPx,
} from '../panel-styles';
import { describeFlags, followVerdict, type FlagSeverity } from './trader-flag-helpers';
import { pickMirrorTarget } from './mirror-command-helpers';

export interface TraderDetailDrawerProps {
  trader: TopTraderRow;
  onClose: () => void;
  /** Test seed: render fixed positions instead of fetching. */
  detailOverride?: {
    positions: HlPosition[];
    accountValueUsd: number | null;
    loading: boolean;
    error: string | null;
    stale: boolean;
  };
}

const SEVERITY_COLOR: Record<FlagSeverity, string> = {
  danger: ZONE_COLORS.danger,
  warn: ZONE_COLORS.warn,
  clean: ZONE_COLORS.ok,
  info: GH.textMuted,
};

export default function TraderDetailDrawer({ trader, onClose, detailOverride }: TraderDetailDrawerProps) {
  const live = useTraderPositions(detailOverride ? null : trader.address);
  const detail = detailOverride ?? live;
  // Where the positions came from: 'supabase' (watcher covers this leader — live,
  // zero HL load) vs 'hl' (on-demand fallback). Null for a seeded override.
  const source = detailOverride ? null : live.source;

  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // A11y: focus the close button, inert + hide the rest of the page (same pattern
  // as ApprovalPopup), restore on unmount.
  useEffect(() => {
    closeRef.current?.focus();
    const overlay = overlayRef.current;
    const siblings: Element[] = [];
    if (overlay?.parentElement) {
      for (const child of Array.from(overlay.parentElement.children)) {
        if (child !== overlay) {
          siblings.push(child);
          child.setAttribute('inert', '');
          child.setAttribute('aria-hidden', 'true');
        }
      }
    }
    return () => {
      for (const child of siblings) {
        child.removeAttribute('inert');
        child.removeAttribute('aria-hidden');
      }
    };
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const verdict = followVerdict(trader.allFlags, trader.composite);
  const descriptors = describeFlags(trader.allFlags);
  const mirrorTarget = pickMirrorTarget(detail.positions);

  return (
    <div
      ref={overlayRef}
      role="presentation"
      onKeyDown={onKeyDown}
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
      className={css({
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: { base: 'flex-end', md: 'center' },
        justifyContent: 'center',
        bg: 'rgba(1, 4, 9, 0.72)',
        padding: { base: '0', md: '16px' },
        animation: 'backdropIn 0.18s ease-out',
      })}
    >
      <section
        ref={dialogRef}
        data-testid="trader-detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Trader detail ${trader.displayName ?? trader.short}`}
        className={css({
          width: '100%',
          maxWidth: { base: '100%', md: '480px' },
          maxHeight: { base: '88vh', md: '90vh' },
          overflowY: 'auto',
          bg: 'github.bgSecondary',
          border: '1px solid token(colors.github.border)',
          borderRadius: { base: '12px 12px 0 0', md: '12px' },
          padding: '18px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
          animation: 'popupIn 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
        })}
      >
        {/* Header */}
        <header className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' })}>
          <div className={css({ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: '0' })}>
            <span className={css({ fontFamily: 'label', fontSize: 'md', fontWeight: 'bold', color: 'github.textBright', letterSpacing: '0.03em' })}>
              {trader.displayName ?? trader.short}
              {trader.leaderboardTop && (
                <span title="On the HL leaderboard" className={css({ fontSize: 'xs', color: 'github.link', marginLeft: '6px' })}>★</span>
              )}
            </span>
            <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted', overflow: 'hidden', textOverflow: 'ellipsis' })}>
              {trader.address}
            </span>
          </div>
          <button
            ref={closeRef}
            type="button"
            data-testid="trader-detail-close"
            onClick={onClose}
            aria-label="Close trader detail"
            className={css({
              flexShrink: 0,
              bg: 'github.bg',
              border: '1px solid token(colors.github.border)',
              borderRadius: '6px',
              color: 'github.text',
              fontSize: 'sm',
              fontWeight: 'bold',
              width: '28px',
              height: '28px',
              cursor: 'pointer',
              _hover: { color: 'github.textBright' },
            })}
          >
            ✕
          </button>
        </header>

        {/* Verdict headline */}
        <div
          data-testid="trader-detail-verdict"
          data-level={verdict.level}
          style={{ color: SEVERITY_COLOR[verdict.level], borderColor: SEVERITY_COLOR[verdict.level] }}
          className={css({
            fontFamily: 'mono',
            fontSize: 'xs',
            fontWeight: 'bold',
            border: '1px solid',
            borderRadius: '6px',
            padding: '8px 10px',
            lineHeight: '1.4',
          })}
        >
          {verdict.headline}
        </div>

        {/* STATS */}
        <Section title="Stats">
          <div className={css({ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px 14px' })}>
            <Stat label="Composite" value={trader.composite === null ? '—' : trader.composite.toFixed(0)} testid="stat-composite" />
            <Stat label="Sharpe" value={fmtNum(trader.metrics.sharpe, 2)} />
            <Stat label="Win %" value={fmtFracPct(trader.metrics.winRate)} />
            <Stat label="Profit Factor" value={fmtNum(trader.metrics.profitFactor, 2)} />
            <Stat label="Max DD" value={fmtFracPct(trader.metrics.maxDrawdownFrac)} danger />
            <Stat label="PnL" value={trader.metrics.aggregatePnlUsd === null ? '—' : fmtCompactUsd(trader.metrics.aggregatePnlUsd)} signed={trader.metrics.aggregatePnlUsd} />
            <Stat label="Median Hold" value={trader.metrics.medianHoldHours === null ? '—' : `${trader.metrics.medianHoldHours.toFixed(1)}h`} />
            <Stat label="Fills" value={trader.metrics.nFills === null ? '—' : trader.metrics.nFills.toLocaleString('en-US')} />
          </div>
        </Section>

        {/* LIVE POSITIONS */}
        <Section title="Live Positions">
          {source && !detail.loading && (
            <span
              data-testid="positions-source"
              aria-label={source === 'supabase' ? 'Positions are live from the trade-watch feed' : 'Positions fetched on demand from Hyperliquid'}
              title={source === 'supabase' ? 'Live from the trade-watch feed (Supabase) — no HL call' : 'Fetched on demand from Hyperliquid'}
              style={{ color: source === 'supabase' ? ZONE_COLORS.ok : GH.textMuted }}
              className={css({ fontFamily: 'mono', fontSize: '9px', letterSpacing: '0.03em' })}
            >
              {source === 'supabase' ? (
                <>
                  <span aria-hidden>● </span>live · trade-watch
                </>
              ) : detail.stale ? (
                'cached · HL'
              ) : (
                'fetched · HL'
              )}
            </span>
          )}
          {detail.loading ? (
            <span data-testid="trader-positions-loading" className={css({ fontSize: 'xs', color: 'github.textMuted', fontFamily: 'mono' })}>
              fetching live positions…
            </span>
          ) : detail.error ? (
            <span data-testid="trader-positions-error" className={css({ fontSize: 'xs', color: 'zone.danger', fontFamily: 'mono' })}>
              {detail.error}
            </span>
          ) : detail.positions.length === 0 ? (
            <span data-testid="trader-positions-empty" className={css({ fontSize: 'xs', color: 'github.textMuted', fontFamily: 'mono' })}>
              No open positions right now.
            </span>
          ) : (
            <ul data-testid="trader-positions" className={css({ display: 'flex', flexDirection: 'column', gap: '6px', listStyle: 'none', margin: 0, padding: 0 })}>
              {detail.positions.map((p) => (
                <PositionRowView key={`${p.coin}-${p.side}`} p={p} />
              ))}
            </ul>
          )}
          {detail.stale && (
            <span className={css({ fontSize: '9px', color: 'github.textMuted', fontFamily: 'mono' })}>
              (showing last cached snapshot — live fetch failed)
            </span>
          )}
        </Section>

        {/* RISK / HEALTH FLAGS */}
        <Section title="Risk / Health">
          {descriptors.length === 0 ? (
            <span className={css({ fontSize: 'xs', color: 'github.textMuted', fontFamily: 'mono' })}>No flags recorded.</span>
          ) : (
            <ul data-testid="trader-flags" className={css({ display: 'flex', flexDirection: 'column', gap: '6px', listStyle: 'none', margin: 0, padding: 0 })}>
              {descriptors.map((d) => (
                <li key={d.code} data-testid="trader-flag" data-severity={d.severity} className={css({ display: 'flex', flexDirection: 'column', gap: '1px' })}>
                  <span
                    style={{ color: SEVERITY_COLOR[d.severity] }}
                    className={css({ fontFamily: 'mono', fontSize: '10px', fontWeight: 'bold', letterSpacing: '0.03em' })}
                  >
                    {d.label}
                  </span>
                  <span className={css({ fontSize: '11px', color: 'github.text', lineHeight: '1.35' })}>{d.meaning}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* MIRROR THIS → */}
        <MirrorPanel
          coin={mirrorTarget?.coin ?? null}
          side={mirrorTarget?.side ?? null}
          leaderAddress={trader.address}
        />
      </section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '8px' })}>
      <span className={css({ fontFamily: 'label', fontSize: '10px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.08em' })}>
        {title}
      </span>
      {children}
    </div>
  );
}

function Stat({ label, value, testid, danger, signed }: { label: string; value: string; testid?: string; danger?: boolean; signed?: number | null }) {
  const color =
    signed !== undefined && signed !== null
      ? signed > 0
        ? ZONE_COLORS.ok
        : signed < 0
          ? ZONE_COLORS.danger
          : GH.textBright
      : danger
        ? ZONE_COLORS.warn
        : GH.textBright;
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '1px' })}>
      <span className={css({ fontFamily: 'label', fontSize: '9px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.05em' })}>
        {label}
      </span>
      <span
        data-testid={testid}
        style={{ color, fontFeatureSettings: '"tnum"' }}
        className={css({ fontFamily: 'mono', fontSize: 'sm', fontWeight: 'bold' })}
      >
        {value}
      </span>
    </div>
  );
}

function PositionRowView({ p }: { p: HlPosition }) {
  const sideColor = p.side === 'long' ? ZONE_COLORS.ok : ZONE_COLORS.danger;
  const pnlColor = p.unrealizedPnl > 0 ? ZONE_COLORS.ok : p.unrealizedPnl < 0 ? ZONE_COLORS.danger : GH.textMuted;
  return (
    <li
      data-testid="trader-position-row"
      className={css({
        bg: 'github.bg',
        border: '1px solid token(colors.github.borderSubtle)',
        borderRadius: '6px',
        padding: '7px 9px',
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
      })}
    >
      <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' })}>
        <span className={css({ display: 'flex', alignItems: 'baseline', gap: '6px' })}>
          <span style={{ color: sideColor }} className={css({ fontFamily: 'label', fontSize: '11px', fontWeight: 'bold', letterSpacing: '0.04em' })}>
            {p.side.toUpperCase()}
          </span>
          <span className={css({ fontFamily: 'mono', fontSize: 'xs', color: 'github.textBright', fontWeight: 'bold' })}>{p.coin}</span>
          {p.leverage !== null && (
            <span className={css({ fontFamily: 'mono', fontSize: '9px', color: 'github.textMuted' })}>{p.leverage}x</span>
          )}
        </span>
        <span style={{ color: pnlColor, fontFeatureSettings: '"tnum"' }} className={css({ fontFamily: 'mono', fontSize: 'xs', fontWeight: 'bold' })}>
          {fmtUsd(p.unrealizedPnl)}
        </span>
      </div>
      <div className={css({ display: 'flex', gap: '12px', flexWrap: 'wrap' })}>
        <MicroStat label="size" value={`${p.size}`} />
        <MicroStat label="entry" value={fmtPx(p.entryPx)} />
        <MicroStat label="value" value={fmtCompactUsd(p.positionValue)} />
        {p.liquidationPx !== null && <MicroStat label="liq" value={fmtPx(p.liquidationPx)} />}
      </div>
    </li>
  );
}

function MicroStat({ label, value }: { label: string; value: string }) {
  return (
    <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted', fontFeatureSettings: '"tnum"' })}>
      {label} <span className={css({ color: 'github.text' })}>{value}</span>
    </span>
  );
}

/**
 * "Mirror this →" — creates an operator PREVIEW of the trader's top position
 * (coin/side, risk-sized server-side off the live mark). The preview appears in
 * the approval popup, where Claude can review it and the operator approves (or
 * forces). NO-AUTO-FIRE: creating a preview executes NOTHING; only the operator's
 * Approve in the popup fires it. The UI still never places a trade directly.
 */
function MirrorPanel({
  coin,
  side,
  leaderAddress,
}: {
  coin: string | null;
  side: 'buy' | 'sell' | null;
  leaderAddress: string;
}) {
  const [status, setStatus] = useState<'idle' | 'creating' | 'created' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function createPreview(): Promise<void> {
    if (!coin || !side) return;
    setStatus('creating');
    setError(null);
    try {
      const res = await fetch('/api/cockpit/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ coin, side, leaderAddress }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `Request failed (${res.status})`);
        setStatus('error');
        return;
      }
      setStatus('created');
      // Re-enable after a beat so the operator can create another preview (e.g.
      // a different side) without reopening the drawer — the confirmation shows
      // briefly, then the button returns to idle.
      setTimeout(() => setStatus('idle'), 2500);
    } catch {
      setError('Network error — try again.');
      setStatus('error');
    }
  }

  const sideLabel = side === 'buy' ? 'LONG' : 'SHORT';
  const busy = status === 'creating' || status === 'created';

  return (
    <div
      data-testid="mirror-panel"
      className={css({
        borderTop: '1px solid token(colors.github.border)',
        paddingTop: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      })}
    >
      <span className={css({ fontFamily: 'label', fontSize: '10px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.08em' })}>
        Mirror this →
      </span>
      {coin === null || side === null ? (
        <span className={css({ fontSize: 'xs', color: 'github.textMuted', fontFamily: 'mono' })}>
          No open position to mirror.
        </span>
      ) : (
        <>
          <span className={css({ fontSize: '11px', color: 'github.text', lineHeight: '1.4' })}>
            Mirror their top position ({sideLabel} {coin}) as a preview. Claude can review it; you approve — or force — in the popup.
          </span>
          <button
            type="button"
            data-testid="mirror-preview"
            onClick={() => void createPreview()}
            disabled={busy}
            className={css({
              alignSelf: 'flex-start',
              bg: 'github.bg',
              border: '1px solid token(colors.github.border)',
              borderRadius: '6px',
              color: 'github.textBright',
              fontFamily: 'label',
              fontSize: 'xs',
              fontWeight: 'bold',
              padding: '7px 13px',
              cursor: 'pointer',
              _hover: { borderColor: 'github.link' },
              _disabled: { opacity: 0.6, cursor: 'not-allowed' },
            })}
          >
            {status === 'creating'
              ? 'Creating…'
              : status === 'created'
                ? 'Preview created ✓'
                : `Preview ${sideLabel} ${coin}`}
          </button>
          {status === 'created' && (
            <span data-testid="mirror-created" className={css({ fontSize: '9px', color: 'zone.ok', fontFamily: 'mono' })}>
              Open the approval popup to review &amp; approve (or force) it.
            </span>
          )}
          {status === 'error' && error && (
            <span data-testid="mirror-error" className={css({ fontSize: '9px', color: 'zone.danger', fontFamily: 'mono' })}>
              {error}
            </span>
          )}
          {status !== 'created' && (
            <span className={css({ fontSize: '9px', color: 'github.textMuted', fontFamily: 'mono' })}>
              Creating a preview executes nothing — you approve in the popup.
            </span>
          )}
        </>
      )}
    </div>
  );
}

function fmtNum(v: number | null, dp: number): string {
  return v === null ? '—' : v.toFixed(dp);
}

function fmtFracPct(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(1)}%`;
}
