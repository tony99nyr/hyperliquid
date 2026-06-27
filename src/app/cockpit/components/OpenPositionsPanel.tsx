'use client';

/**
 * OpenPositionsPanel (design handoff FOCAL panel) — the in-trade command center.
 *
 * Brighter focal surface + accent border + top gradient bar + soft shadow. Header
 * shows count + total unrealized + a "＋ New Position" button. Each open position
 * is a 4-column row:
 *   1. market + side pill + size·leverage
 *   2. entry / mark / uPnL (uPnL colored, with %)
 *   3. HEALTH block: ALIGNED ✓ / FIGHTING ⚠ vs the coin's regime + a
 *      liquidation-distance bar (green >14% / amber 6–14% / red <6%)
 *   4. Reduce + Close actions → ExitModal (reduce-only, hardened seam)
 * Below the rows: a red-tinted Safe-Exit strip with SAFE-EXIT ALL (closes every
 * position independently of Claude — the dead-man's switch).
 *
 * Wired to REAL data: positions/marks from usePositionPnl (Supabase realtime),
 * regime direction per coin supplied by the parent (useRegimeStrip). Reduce/Close/
 * Safe-Exit ALL all execute through /api/cockpit/safe-exit (reduce-only). NO entry
 * is opened here — "＋ New Position" surfaces the operator's intent to the parent.
 */

import { useEffect, useState } from 'react';
import { css } from '@styled-system/css';
import { usePositionPnl } from '@/hooks/usePositionPnl';
import { useStops } from '@/hooks/useStops';
import { useAccountRisk } from '@/hooks/useAccountRisk';
import type { RestingStop } from '@/lib/trading/stop-order-service';
import type { AccountRisk } from '@/lib/trading/account-risk-service';
import type { TradingMode } from '@/types/fill';
import type { PnlSnapshot, PositionRow } from '@/hooks/realtime-row-mappers';
import { ZONE_COLORS, TERM, GH, fmtUsd, fmtPx } from './panel-styles';
import { positionHealth, stopStatus, uPnlPct, type RegimeDir } from './open-positions-helpers';
import { userPositionDisplay } from './position-panel-helpers';
import ExitModal, { type ExitTarget } from './ExitModal';
import AdjustLeverageModal, { type AdjustLeverageTarget } from './AdjustLeverageModal';
import PositionInsightsModal from './PositionInsightsModal';

/** "held 3h" inline label from the open timestamp + the ticking clock. */
function heldShort(openedAtMs: number | null | undefined, nowMs: number): string {
  if (openedAtMs == null) return '';
  const m = Math.max(0, Math.floor((nowMs - openedAtMs) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

export interface OpenPositionsPanelProps {
  sessionId: string | null;
  /** Trading mode — drives the LIVE confirm gate on Add-to-position. */
  mode?: TradingMode;
  /** Map of coin → regime direction (bullish/bearish/neutral) for alignment. */
  regimeByCoin?: Record<string, RegimeDir>;
  /** Current account equity (cash + unrealized) for exit-modal math. */
  currentEquityUsd?: number;
  /** Open the approval flow for a fresh entry (no-auto-fire — parent decides). */
  onNewPosition?: () => void;
  /** Test/RSC seed: render fixed positions instead of subscribing. */
  positionsOverride?: { positions: PositionRow[]; latestPnlByCoin: Record<string, PnlSnapshot> };
  /** Test/RSC seed for resting stops (only used alongside positionsOverride). */
  stopsOverride?: Record<string, RestingStop>;
  /** Test/RSC seed for real account risk (only used alongside positionsOverride). */
  riskOverride?: Record<string, AccountRisk>;
}

interface ExitRequest {
  target: ExitTarget;
  initialPct: number;
}

export default function OpenPositionsPanel({
  sessionId,
  mode = 'paper',
  regimeByCoin = {},
  currentEquityUsd = 0,
  onNewPosition,
  positionsOverride,
  stopsOverride,
  riskOverride,
}: OpenPositionsPanelProps) {
  const live = usePositionPnl(positionsOverride ? null : sessionId);
  const positions = positionsOverride ? positionsOverride.positions : live.positions;
  const pnlByCoin = positionsOverride ? positionsOverride.latestPnlByCoin : live.latestPnlByCoin;

  // Resting protective stops (one HL call for the whole panel). Skip polling when a
  // test/RSC seed is supplied; until the first fetch resolves, rows show "checking…"
  // rather than falsely claiming "no stop".
  const liveStops = useStops(!positionsOverride);
  const stopsByCoin = positionsOverride ? (stopsOverride ?? {}) : liveStops.stopsByCoin;
  const stopsLoaded = positionsOverride ? true : liveStops.loaded;

  // REAL liquidation + effective leverage from HL (reflects posted margin). The fold's
  // liq formula (entry×lev-setting) ignores margin you add, so it shows a static,
  // pessimistic distance; this overrides it with the true number. Test seed via
  // riskOverride. Falls back to the formula per-coin when there's no real read.
  const liveRisk = useAccountRisk(!positionsOverride);
  const riskByCoin = positionsOverride ? (riskOverride ?? {}) : liveRisk.riskByCoin;

  const [exitReq, setExitReq] = useState<ExitRequest | null>(null);
  const [adjustReq, setAdjustReq] = useState<AdjustLeverageTarget | null>(null);
  const [closeAll, setCloseAll] = useState(false);
  // Coin of the open position whose insights drill-down is showing (click a row).
  const [insightsCoin, setInsightsCoin] = useState<string | null>(null);
  // Ticking clock for the "held" labels (lazy init keeps Date out of render purity).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const open = positions.filter((p) => p.side !== 'flat');
  const totalUpnl = open.reduce((s, p) => {
    const d = userPositionDisplay(p, pnlByCoin[p.coin]);
    return s + (d.unrealizedPnlUsd ?? 0);
  }, 0);

  return (
    <section
      data-testid="open-positions-panel"
      className={css({ bg: 'cockpit.focal', border: '1px solid', borderColor: 'rgba(91,140,255,0.22)', borderRadius: '12px', overflow: 'hidden', position: 'relative', flexShrink: 0 })}
      style={{ boxShadow: '0 0 0 1px rgba(91,140,255,0.04), 0 8px 30px rgba(0,0,0,0.25)' }}
    >
      {/* Top accent gradient strip. */}
      <div aria-hidden style={{ height: '2px', background: 'linear-gradient(90deg, #5b8cff, transparent)' }} />

      <header className={css({ display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 16px 12px', flexWrap: 'wrap' })}>
        <h2 className={css({ fontFamily: 'sans', fontSize: '12px', letterSpacing: '0.13em', textTransform: 'uppercase', color: 'github.text', fontWeight: 'semibold' })}>
          Open Positions
        </h2>
        <span data-testid="open-count" className={css({ fontFamily: 'mono', fontSize: '11px', color: 'cockpit.faint' })}>
          {open.length} open
        </span>
        <div className={css({ flex: 1 })} />
        <div className={css({ textAlign: 'right' })}>
          <div className={css({ fontFamily: 'sans', fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'cockpit.faint', fontWeight: 'semibold' })}>
            Unrealized
          </div>
          <div data-testid="total-upnl" style={{ color: totalUpnl > 0 ? ZONE_COLORS.ok : totalUpnl < 0 ? ZONE_COLORS.danger : GH.textMuted, fontFeatureSettings: '"tnum"' }} className={css({ fontFamily: 'mono', fontSize: '15px', fontWeight: 'semibold' })}>
            {fmtUsd(totalUpnl)}
          </div>
        </div>
        <button
          type="button"
          data-testid="new-position-button"
          onClick={onNewPosition}
          style={{ background: TERM.accent, color: TERM.darkText }}
          className={css({ fontFamily: 'sans', fontSize: '12px', fontWeight: 'semibold', border: 'none', borderRadius: '7px', paddingX: '13px', paddingY: '7px', cursor: 'pointer', _hover: { opacity: 0.92 } })}
        >
          ＋ New Position
        </button>
      </header>

      {open.length === 0 ? (
        <div data-testid="positions-empty" className={css({ padding: '34px 16px 40px', textAlign: 'center' })}>
          <p className={css({ fontFamily: 'mono', fontSize: '13px', color: 'cockpit.faint' })}>
            Flat — no open positions. Safe-Exit idle.
          </p>
          <button
            type="button"
            data-testid="empty-open-position"
            onClick={onNewPosition}
            style={{ background: TERM.accent, color: TERM.darkText }}
            className={css({ marginTop: '14px', fontFamily: 'sans', fontSize: '12px', fontWeight: 'semibold', border: 'none', borderRadius: '7px', paddingX: '16px', paddingY: '9px', cursor: 'pointer' })}
          >
            ＋ Open a position
          </button>
        </div>
      ) : (
        <div className={css({ padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: '8px' })}>
          {open.map((p) => (
            <PositionRowCard
              key={p.coin}
              pos={p}
              pnl={pnlByCoin[p.coin]}
              regime={regimeByCoin[p.coin] ?? 'neutral'}
              mode={mode}
              stop={stopsByCoin[p.coin]}
              stopsLoaded={stopsLoaded}
              risk={riskByCoin[p.coin]}
              nowMs={nowMs}
              onOpenInsights={() => setInsightsCoin(p.coin)}
              onReduce={(t) => setExitReq({ target: t, initialPct: 25 })}
              onClose={(t) => setExitReq({ target: t, initialPct: 100 })}
              onAdjust={(t) => setAdjustReq(t)}
            />
          ))}
        </div>
      )}

      {/* Safe-Exit strip — SAFE-EXIT ALL (dead-man's switch). */}
      {open.length > 0 && (
        <div className={css({ margin: '0 12px 12px', display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', padding: '12px 14px', bg: 'rgba(242,77,94,0.05)', border: '1px solid', borderColor: 'rgba(242,77,94,0.22)', borderRadius: '10px' })}>
          <div className={css({ flex: 1, minWidth: '200px' })}>
            <div className={css({ display: 'flex', alignItems: 'baseline', gap: '8px' })}>
              <span className={css({ fontFamily: 'mono', fontSize: '12px', fontWeight: 'semibold', color: 'zone.danger' })}>SAFE-EXIT</span>
              <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>independent of Claude · reduce-only</span>
            </div>
            <p className={css({ fontSize: '11.5px', color: 'github.textMuted', marginTop: '3px', lineHeight: '1.4' })}>
              Market-close every open position immediately. Use if the plan goes stale or Claude is offline.
            </p>
          </div>
          <button
            type="button"
            data-testid="safe-exit-all"
            onClick={() => setCloseAll(true)}
            style={{ background: TERM.safeExit, color: '#fff', boxShadow: '0 4px 14px rgba(226,58,77,0.3)' }}
            className={css({ fontFamily: 'sans', fontSize: '12.5px', fontWeight: 'bold', letterSpacing: '0.04em', border: 'none', borderRadius: '8px', paddingX: '26px', paddingY: '11px', cursor: 'pointer', animation: 'dangerPulse 2.4s ease-in-out infinite', _hover: { opacity: 0.92 } })}
          >
            SAFE-EXIT ALL
          </button>
        </div>
      )}

      {exitReq && (
        <ExitModal
          target={exitReq.target}
          scope="single"
          currentEquityUsd={currentEquityUsd || totalUpnl}
          initialPct={exitReq.initialPct}
          onClose={() => setExitReq(null)}
        />
      )}
      {closeAll && (
        <ExitModal
          target={null}
          scope="all"
          openCount={open.length}
          currentEquityUsd={currentEquityUsd}
          onClose={() => setCloseAll(false)}
        />
      )}
      {adjustReq && (
        <AdjustLeverageModal
          target={adjustReq}
          onClose={() => setAdjustReq(null)}
        />
      )}
      {(() => {
        const ip = insightsCoin ? open.find((p) => p.coin === insightsCoin) : null;
        if (!ip) return null;
        const d = userPositionDisplay(ip, pnlByCoin[ip.coin]);
        const t: ExitTarget | null = d.entryPx != null && d.markPx != null
          ? { coin: ip.coin, side: d.side, size: ip.sz, entryPx: d.entryPx, markPx: d.markPx } : null;
        const at: AdjustLeverageTarget | null = d.entryPx != null
          ? { coin: ip.coin, side: d.side, entryPx: d.entryPx, markPx: d.markPx, currentLeverage: d.leverage } : null;
        return (
          <PositionInsightsModal
            pos={ip}
            pnl={pnlByCoin[ip.coin]}
            regime={regimeByCoin[ip.coin] ?? 'neutral'}
            mode={mode}
            realLiqPx={riskByCoin[ip.coin]?.liqPx ?? null}
            effLeverage={riskByCoin[ip.coin]?.effLeverage ?? null}
            currentMarginUsd={riskByCoin[ip.coin]?.marginUsed ?? null}
            nowMs={nowMs}
            onReduce={() => { if (t) { setInsightsCoin(null); setExitReq({ target: t, initialPct: 25 }); } }}
            onClose={() => { if (t) { setInsightsCoin(null); setExitReq({ target: t, initialPct: 100 }); } }}
            onAdjust={() => { if (at) { setInsightsCoin(null); setAdjustReq(at); } }}
            onDismiss={() => setInsightsCoin(null)}
          />
        );
      })()}
    </section>
  );
}

function PositionRowCard({
  pos,
  pnl,
  regime,
  mode,
  stop,
  stopsLoaded,
  risk,
  nowMs,
  onOpenInsights,
  onReduce,
  onClose,
  onAdjust,
}: {
  pos: PositionRow;
  pnl: PnlSnapshot | undefined;
  regime: RegimeDir;
  mode: TradingMode;
  stop: RestingStop | undefined;
  stopsLoaded: boolean;
  risk: AccountRisk | undefined;
  nowMs: number;
  onOpenInsights: () => void;
  onReduce: (t: ExitTarget) => void;
  onClose: (t: ExitTarget) => void;
  onAdjust: (t: AdjustLeverageTarget) => void;
}) {
  const d = userPositionDisplay(pos, pnl);
  const side = d.side;
  const sideColor = side === 'long' ? ZONE_COLORS.ok : ZONE_COLORS.danger;
  const sideBg = side === 'long' ? 'rgba(25,201,138,0.12)' : 'rgba(242,77,94,0.12)';

  const health = positionHealth({
    side,
    entryPx: d.entryPx,
    markPx: d.markPx,
    leverage: d.leverage,
    // Prefer the REAL HL liquidation (reflects posted margin); fall back to the fold's
    // formula only when there's no live account read (paper / no address).
    liqPxOverride: risk?.liqPx ?? d.liqPx,
    regime,
  });
  const stopState = stopStatus(stop, d.markPx, mode);
  const pct = uPnlPct(side, d.entryPx, d.markPx);
  const upnl = d.unrealizedPnlUsd;
  const upnlColor = upnl == null ? GH.text : upnl >= 0 ? ZONE_COLORS.ok : ZONE_COLORS.danger;

  const target: ExitTarget | null =
    d.entryPx != null && d.markPx != null
      ? { coin: pos.coin, side, size: pos.sz, entryPx: d.entryPx, markPx: d.markPx }
      : null;

  // Adjusting leverage needs only an entry price (the liq math); a missing mark
  // just disables the mark-relative danger guard, not the action.
  const adjustTarget: AdjustLeverageTarget | null =
    d.entryPx != null
      ? { coin: pos.coin, side, entryPx: d.entryPx, markPx: d.markPx, currentLeverage: d.leverage }
      : null;

  return (
    <div
      data-testid="position-row"
      data-coin={pos.coin}
      className={css({ display: 'flex', flexDirection: 'column', gap: '10px', padding: '13px 14px', bg: 'cockpit.row', border: '1px solid token(colors.github.borderSubtle)', borderRadius: '10px' })}
    >
      {/* Col 1 — market + side + size·lev. The market header is a button that opens
          the insights drill-down (chart + health + ATR stop); action buttons below
          are separate so this isn't a nested-interactive trap. */}
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '6px' })}>
        <button
          type="button"
          data-testid="position-open-insights"
          onClick={onOpenInsights}
          aria-label={`Open ${pos.coin} position insights`}
          className={css({ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '7px', minHeight: '32px', bg: 'transparent', border: 'none', paddingY: '4px', paddingX: 0, cursor: 'pointer', _hover: { '& > span:first-child': { textDecoration: 'underline' } }, _focusVisible: { outline: '2px solid token(colors.github.link)', outlineOffset: '2px', borderRadius: '4px' } })}
        >
          <span className={css({ fontFamily: 'mono', fontSize: '14px', fontWeight: 'semibold', color: 'github.textBright' })}>{pos.coin}-PERP</span>
          <span aria-hidden className={css({ fontFamily: 'mono', fontSize: '11px', color: 'cockpit.accent' })}>insights ›</span>
        </button>
        <span className={css({ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' })}>
          <span data-testid="position-side" style={{ color: sideColor, background: sideBg }} className={css({ fontFamily: 'mono', fontSize: '10px', fontWeight: 'semibold', letterSpacing: '0.08em', paddingX: '7px', paddingY: '2px', borderRadius: '5px' })}>
            {side.toUpperCase()}
          </span>
          <span className={css({ fontFamily: 'mono', fontSize: '11px', color: 'github.textMuted' })}>
            {pos.sz.toLocaleString('en-US', { maximumFractionDigits: 4 })}{d.leverage != null ? ` · ${d.leverage}×` : ''}
            {/* Effective leverage when posted margin pulls it meaningfully below the
                setting (≥10% lower) — shows the de-risk that the lev-setting hides. */}
            {risk?.effLeverage != null && d.leverage != null && risk.effLeverage < d.leverage * 0.9 && (
              <span data-testid="position-eff-lev" style={{ color: ZONE_COLORS.ok }}> · {risk.effLeverage.toFixed(1)}× eff</span>
            )}
          </span>
          {pos.openedAt != null && (
            <span data-testid="position-held" className={css({ fontFamily: 'mono', fontSize: '10px', color: 'cockpit.faint' })}>· held {heldShort(pos.openedAt, nowMs)}</span>
          )}
        </span>
      </div>

      {/* Col 2 — entry / mark / uPnL */}
      <div className={css({ display: 'flex', gap: '24px', flexWrap: 'wrap' })}>
        <Cell label="Entry" value={fmtPx(d.entryPx)} />
        <Cell label="Mark" value={fmtPx(d.markPx)} />
        <Cell
          label="uPnL"
          value={`${upnl == null ? '—' : fmtUsd(upnl)}${pct == null ? '' : ` (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`}`}
          color={upnlColor}
          strong
          testid="position-upnl"
        />
      </div>

      {/* Col 3 — health block */}
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '7px' })}>
        {/* Protection — is a resting stop guarding this position? The headline health
            signal: ✓ protected / ⚠ no stop (live, clickable → set one) / n/a (paper). */}
        {!stopsLoaded ? (
          <span data-testid="stop-status" data-state="loading" className={css({ fontFamily: 'mono', fontSize: '10px', color: 'cockpit.faint' })}>stop · checking…</span>
        ) : stopState.state === 'protected' ? (
          <span data-testid="stop-status" data-state="protected" style={{ color: ZONE_COLORS.ok }} className={css({ fontFamily: 'mono', fontSize: '10px', fontWeight: 'semibold' })}>
            ✓ stop {fmtPx(stopState.triggerPx)}{stopState.distPct != null ? ` · ${stopState.distPct.toFixed(1)}% away` : ''}
          </span>
        ) : stopState.state === 'unprotected' ? (
          <button
            type="button"
            data-testid="stop-status"
            data-state="unprotected"
            onClick={onOpenInsights}
            aria-label={`${pos.coin} has no protective stop — open insights to set one`}
            style={{ color: ZONE_COLORS.warn, background: 'rgba(217,164,65,0.10)', borderColor: 'rgba(217,164,65,0.34)' }}
            className={css({ alignSelf: 'flex-start', fontFamily: 'mono', fontSize: '10px', fontWeight: 'semibold', border: '1px solid', borderRadius: '5px', paddingX: '7px', paddingY: '3px', cursor: 'pointer', _hover: { textDecoration: 'underline' }, _focusVisible: { outline: '2px solid token(colors.github.link)', outlineOffset: '2px' } })}
          >
            ⚠ no stop — set one ›
          </button>
        ) : (
          <span data-testid="stop-status" data-state="na" title="Paper trading has no resting exchange stops" className={css({ fontFamily: 'mono', fontSize: '10px', color: 'cockpit.faint' })}>stop n/a · paper</span>
        )}
        <span className={css({ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' })}>
          <span data-testid="alignment-badge" data-aligned={health.aligned} style={{ color: health.alignColor, background: `${health.alignColor}1f` }} className={css({ fontFamily: 'mono', fontSize: '10px', fontWeight: 'semibold', letterSpacing: '0.06em', paddingX: '7px', paddingY: '2px', borderRadius: '5px' })}>
            {health.alignLabel}
          </span>
          <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'cockpit.faint' })}>vs {pos.coin} regime</span>
        </span>
        <div className={css({ display: 'flex', justifyContent: 'space-between' })}>
          <span className={css({ fontFamily: 'mono', fontSize: '9.5px', color: 'cockpit.faint' })}>liq {fmtPx(health.liqPx)}</span>
          <span data-testid="liq-dist" style={{ color: health.liqColor }} className={css({ fontFamily: 'mono', fontSize: '9.5px' })}>
            {health.liqDistPct == null ? '—' : `${health.liqDistPct.toFixed(1)}%`} away
          </span>
        </div>
        <div className={css({ height: '4px', bg: '#1b2230', borderRadius: '3px', overflow: 'hidden' })}>
          <div data-testid="liq-bar" style={{ width: health.liqBarWidth, height: '100%', background: health.liqColor }} />
        </div>
      </div>

      {/* Actions */}
      <div className={css({ display: 'flex', gap: '6px', justifyContent: 'flex-start' })}>
        <button
          type="button"
          data-testid="position-adjust-lev"
          disabled={!adjustTarget}
          onClick={() => adjustTarget && onAdjust(adjustTarget)}
          className={css({ fontFamily: 'sans', fontSize: '11px', fontWeight: 'medium', color: 'cockpit.accent', bg: 'cockpit.button', border: '1px solid', borderColor: 'rgba(91,140,255,0.32)', borderRadius: '6px', paddingX: '11px', paddingY: '7px', cursor: 'pointer', _disabled: { opacity: 0.5, cursor: 'not-allowed' } })}
        >
          {d.leverage != null ? `${d.leverage}× lev` : 'Set lev'}
        </button>
        <button
          type="button"
          data-testid="position-reduce"
          disabled={!target}
          onClick={() => target && onReduce(target)}
          className={css({ fontFamily: 'sans', fontSize: '11px', fontWeight: 'medium', color: 'github.text', bg: 'cockpit.button', border: '1px solid token(colors.github.border)', borderRadius: '6px', paddingX: '11px', paddingY: '7px', cursor: 'pointer', _disabled: { opacity: 0.5, cursor: 'not-allowed' } })}
        >
          Reduce
        </button>
        <button
          type="button"
          data-testid="position-close"
          disabled={!target}
          onClick={() => target && onClose(target)}
          style={{ color: ZONE_COLORS.danger, background: 'rgba(242,77,94,0.08)', borderColor: 'rgba(242,77,94,0.32)' }}
          className={css({ fontFamily: 'sans', fontSize: '11px', fontWeight: 'semibold', border: '1px solid', borderRadius: '6px', paddingX: '13px', paddingY: '7px', cursor: 'pointer', _disabled: { opacity: 0.5, cursor: 'not-allowed' } })}
        >
          Close
        </button>
      </div>
    </div>
  );
}

function Cell({ label, value, color, strong, testid }: { label: string; value: string; color?: string; strong?: boolean; testid?: string }) {
  return (
    <div className={css({ display: 'flex', flexDirection: 'column' })}>
      <span className={css({ fontFamily: 'sans', fontSize: '9.5px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'cockpit.faint', fontWeight: 'semibold', marginBottom: '3px' })}>{label}</span>
      <span data-testid={testid} style={{ color: color ?? GH.text, fontFeatureSettings: '"tnum"' }} className={css({ fontFamily: 'mono', fontSize: '13px', fontWeight: strong ? 'semibold' : 'normal' })}>
        {value}
      </span>
    </div>
  );
}
