'use client';

/**
 * ApprovalPopup — the animated web replacement for the terminal confirm gate.
 *
 * Subscribes to the session's `pending_actions` (realtime, via usePendingActions)
 * and, whenever a row is 'pending', renders a polished dark order-confirmation
 * CARD (Item 2): the trade as tabular data rows, a prominent PAPER/LIVE badge,
 * the leader being followed, an operator LEVERAGE control (Item 3), and properly
 * weighted Approve / Reject controls. Approving POSTs /api/cockpit/approve WITH
 * the chosen leverage; rejecting POSTs /api/cockpit/reject; the polling skill
 * (requireApproval) observes the decision and executes (approve) or aborts.
 *
 * THE INVARIANT: LIVE needs a STRONGER confirm than paper. PAPER = one-tap
 * Approve. LIVE = the operator must type the exact "side sz coin" phrase before
 * Approve enables (isApproveEnabled, unit-tested). Nothing here can fire a trade
 * on its own — it only flips a row the skill is polling. Dismisses on resolve.
 *
 * LEVERAGE is the operator's risk decision: the slider drives a LIVE margin/liq/
 * ROE read and a SAFETY GUARD (liquidation-inside-stop). Notional stays risk-sized
 * — leverage governs margin/liq/ROE only. The chosen value is server-validated.
 *
 * SAFETY GATE: when liquidation would trigger at/before the stop, Approve is
 * BLOCKED (no one-tap shipping of a knowingly-broken risk plan) until the operator
 * reduces leverage (warning clears) or ticks the explicit acknowledge checkbox —
 * PAPER and LIVE both. The LIVE typed-phrase gate is still required on top.
 *
 * LOOK: re-skinned to the HL Cockpit design handoff "Confirm Order" modal —
 * 520px centered card on a blurred scrim, a LONG/SHORT segmented READOUT (the
 * proposal's side is fixed, NOT user-editable — flipping it would change the
 * validated intent), a size READOUT (risk-sized, not editable), the re-styled
 * leverage control, a summary box, and a colored risk-note callout. The wiring,
 * a11y, safety gate, and every data-testid are preserved verbatim.
 */

import { useEffect, useRef, useState } from 'react';
import { css } from '@styled-system/css';
import type { PendingAction } from '@/types/cockpit';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';
import { usePendingActions } from '@/hooks/usePendingActions';
import {
  clampLeverage,
  deriveLeverageRead,
  liquidationInsideStop,
  resolveCoinMaxLeverage,
  halfLeaderLeverage,
} from '@/lib/trading/leverage-business-logic';
import { leaderPositionForCoin } from './leader-alignment-helpers';
import { isApproveEnabled, liveConfirmPhrase, summarizeProposal } from './approval-popup-helpers';
import { LeverageControl, SideSegment, SummaryRow } from './approval-popup-parts';
import { GH, ZONE_COLORS, TERM, fmtPx, fmtUsd, fmtCompactUsd } from './panel-styles';

/** Verdict → zone color for the Claude-review block on operator previews. */
function reviewColor(verdict: 'endorse' | 'caution' | 'avoid'): string {
  return verdict === 'endorse' ? ZONE_COLORS.ok : verdict === 'avoid' ? ZONE_COLORS.danger : ZONE_COLORS.warn;
}

export interface ApprovalPopupProps {
  sessionId: string | null;
  /** Leader being followed (label + leverage source for Match-leader). */
  leaderAddress?: string | null;
  /** Leader's live positions (server-fetched) — used for Match-leader leverage. */
  leaderPositions?: HlPosition[];
  /** Test/RSC seed: render this action instead of subscribing. */
  actionOverride?: PendingAction | null;
}

export default function ApprovalPopup({
  sessionId,
  leaderAddress,
  leaderPositions = [],
  actionOverride,
}: ApprovalPopupProps) {
  const live = usePendingActions(actionOverride === undefined ? sessionId : null);
  // Skill 'pending' rows take priority over operator previews (they rarely
  // coexist). The MODAL renders only one row at a time; PopupBody routes by the
  // rendered row's own origin/status, so a preview never hits the skill gate.
  const action = actionOverride !== undefined ? actionOverride : (live.pending ?? live.preview);

  if (!action) return null;
  return (
    <PopupBody
      key={action.id}
      action={action}
      leaderAddress={leaderAddress ?? action.proposal.display.leaderAddress ?? null}
      leaderPositions={leaderPositions}
    />
  );
}

function PopupBody({
  action,
  leaderAddress,
  leaderPositions,
}: {
  action: PendingAction;
  leaderAddress: string | null;
  leaderPositions: HlPosition[];
}) {
  const { display, intent } = action.proposal;
  const isLive = action.mode === 'live';
  const isOpening = intent.reduceOnly !== true && action.kind !== 'exit';
  // Operator previews route to /api/cockpit/preview/decide (execute/discard), NOT
  // the skill approve/reject gate. Derived strictly from the rendered row.
  const isPreview = action.status === 'preview' && action.origin === 'operator';

  // Leverage state (Item 3) — only meaningful for OPENING orders.
  const leaderPos = leaderPositionForCoin(leaderPositions, display.coin);
  const leaderLev = display.leaderLeverage ?? leaderPos?.leverage ?? null;
  const coinMax =
    display.coinMaxLeverage ?? resolveCoinMaxLeverage(display.coin, leaderPos?.maxLeverage ?? null);
  const defaultLev = clampLeverage(display.leverage ?? intent.leverage ?? 1, coinMax);
  const [leverage, setLeverage] = useState<number>(defaultLev);

  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Explicit acknowledgement of a knowingly-broken risk plan (liq inside stop).
  const [ackLiqInsideStop, setAckLiqInsideStop] = useState(false);

  // Derived leverage read — recomputed every render off the slider value.
  const entryPx = display.estPx ?? null;
  const read = deriveLeverageRead({
    side: display.side,
    entryPx: entryPx ?? 0,
    sz: display.sz,
    leverage,
    stopPx: display.stopPx,
  });
  const liqInsideStop = liquidationInsideStop(display.side, read.liqPx, display.stopPx);
  const halfLev = halfLeaderLeverage(leaderLev);

  // SAFETY GATE (Item / Fix 2): a one-tap approve must NOT ship a plan where the
  // position liquidates at/before the stop. While `liqInsideStop`:
  //   LIVE  — Approve stays disabled until the operator either reduces leverage
  //           (the warning clears) OR ticks the explicit acknowledge checkbox.
  //           The LIVE typed-phrase gate (isApproveEnabled) is required IN ADDITION.
  //   PAPER — the same acknowledge checkbox is required before Approve enables.
  // When the warning is NOT showing, this gate is a no-op and prior behavior holds.
  const liqGateCleared = !liqInsideStop || ackLiqInsideStop;
  const approveEnabled = !busy && liqGateCleared && isApproveEnabled(action.mode, display, typed);

  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A11y: on open, move focus INTO the dialog (the typed-phrase input for LIVE,
  // else the Reject button — the safe default) and INERT the rest of the page so
  // screen readers announce only the dialog and Tab can't escape to the
  // background. The cleanup restores the background when the popup unmounts.
  useEffect(() => {
    (isLive ? inputRef.current : rejectRef.current)?.focus();

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
  }, [isLive]);

  // Trap Tab within the dialog and let Esc reject/dismiss (keyboard escape from
  // a modal is an a11y expectation; rejecting is the safe outcome).
  function onKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!busy) void decide('reject');
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

  async function decide(path: 'approve' | 'reject'): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      let res: Response;
      if (isPreview) {
        // OPERATOR PREVIEW → the route-driven execute/discard path (NOT the skill
        // approve gate). Approve = execute (sends leverage + the LIVE typed phrase
        // the server re-validates); Cancel = discard. NO-AUTO-FIRE: this fires only
        // on the operator's explicit click.
        const body: {
          id: string;
          decision: 'execute' | 'discard';
          leverage?: number;
          confirmPhrase?: string;
        } = { id: action.id, decision: path === 'approve' ? 'execute' : 'discard' };
        if (path === 'approve' && isOpening) body.leverage = leverage;
        if (path === 'approve' && isLive) body.confirmPhrase = typed;
        res = await fetch('/api/cockpit/preview/decide', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        // Skill 'pending' row → the hardened approve/reject gate (UNCHANGED).
        // Approving an OPENING order sends the operator-chosen leverage; the server
        // re-validates it to [1, coinMax]. Reject + reduce-only exits send only id.
        const body: { id: string; leverage?: number } = { id: action.id };
        if (path === 'approve' && isOpening) body.leverage = leverage;
        res = await fetch(`/api/cockpit/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setError(json.error ?? `Request failed (${res.status})`);
        setBusy(false);
        return;
      }
      // On success the row flips; the realtime hook drops it from `pending` and
      // the popup unmounts. Leave busy=true so buttons stay disabled until then.
    } catch {
      setError('Network error — try again.');
      setBusy(false);
    }
  }

  const sideLong = display.side === 'buy';
  // A reduce-only intent CLOSES/REDUCES exposure — it must NOT be presented with the
  // open-style Long/Short vocabulary (a reduce-only close of a long has side 'sell',
  // which would otherwise read as "Short"). The human is the last line of defense.
  const isReduceOnly = action.proposal.intent.reduceOnly === true;
  const kindTitle =
    action.kind === 'exit' ? 'Confirm Exit' : action.kind === 'entry' ? 'Confirm Order' : 'Confirm Action';

  // Summary-box derived values.
  const notionalUsd = read.notionalUsd;
  const liqPx = read.liqPx;
  // Distance of the liquidation price from entry, as a percent — colors the liq
  // row + the risk callout (red <6 · gold <14 · neutral otherwise).
  const liqDistPct =
    liqPx != null && entryPx != null && entryPx !== 0
      ? (Math.abs(liqPx - entryPx) / entryPx) * 100
      : null;
  const liqDistColor =
    liqDistPct == null ? GH.text : liqDistPct < 6 ? ZONE_COLORS.danger : liqDistPct < 14 ? ZONE_COLORS.warn : GH.text;
  const takerFeeUsd = notionalUsd > 0 ? notionalUsd * 0.00035 : null;

  // Risk callout color: red when liquidation is inside the stop (the plan is
  // broken), else amber (a neutral advisory tone). No regime data is invented.
  const riskIsDanger = liqInsideStop;
  const riskColor = riskIsDanger ? ZONE_COLORS.danger : ZONE_COLORS.warn;
  const riskBg = riskIsDanger ? 'rgba(242,77,94,0.08)' : 'rgba(217,164,65,0.08)';
  const riskBorder = riskIsDanger ? 'rgba(242,77,94,0.3)' : 'rgba(217,164,65,0.3)';

  const szStr = display.sz.toLocaleString('en-US', { maximumFractionDigits: 6 });
  const approveLabel = busy
    ? 'Submitting…'
    : isLive
      ? 'Approve LIVE'
      : isReduceOnly
        ? `Approve & Reduce ${szStr} ${display.coin}`
        : `Approve & ${sideLong ? 'Long' : 'Short'} ${szStr} ${display.coin}`;

  return (
    <div
      ref={overlayRef}
      role="presentation"
      onKeyDown={onKeyDown}
      className={css({
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: { base: 'flex-end', md: 'center' },
        justifyContent: 'center',
        padding: { base: '0', md: '16px' },
        animation: 'backdropIn 0.15s ease',
        overflowY: 'auto',
      })}
      style={{ background: 'rgba(4,6,10,.65)', backdropFilter: 'blur(3px)' }}
    >
      <section
        ref={dialogRef}
        data-testid="approval-popup"
        role="dialog"
        aria-modal="true"
        aria-label={isPreview ? 'Trade preview approval' : 'Trade approval'}
        className={css({
          width: '100%',
          maxWidth: { base: '100%', md: '520px' },
          maxHeight: '94vh',
          overflowY: 'auto',
          borderRadius: { base: '16px 16px 0 0', md: '16px' },
          paddingBottom: { base: 'env(safe-area-inset-bottom)', md: '0' },
          display: 'flex',
          flexDirection: 'column',
          animation: 'popupIn 0.2s cubic-bezier(0.2, 0.8, 0.2, 1)',
        })}
        style={{
          background: '#0e131c',
          border: '1px solid rgba(255,255,255,.12)',
          boxShadow: '0 30px 80px rgba(0,0,0,.6)',
        }}
      >
        {/* Header: title · caption · mode badge · close */}
        <header
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '11px',
            padding: '18px 22px',
            borderBottom: '1px solid token(colors.github.border)',
          })}
        >
          <h2
            className={css({
              fontFamily: 'sans',
              fontSize: '13px',
              fontWeight: 'semibold',
              color: 'github.textBright',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
            })}
          >
            {kindTitle}
          </h2>
          <span
            className={css({ fontFamily: 'mono', fontSize: '10px' })}
            style={{ color: TERM.faint }}
          >
            {isPreview ? 'PREVIEW · you approve · you execute' : 'you approve · you execute'}
          </span>
          {/* Hidden machine-readable summary (preserves the proposal-summary testid). */}
          <span data-testid="proposal-summary" className={css({ srOnly: true })}>
            {summarizeProposal(display, {
              kind: action.kind,
              mode: action.mode,
              reduceOnly: intent.reduceOnly,
            })}
          </span>
          <div className={css({ flex: 1 })} />
          {isPreview && (
            <span
              data-testid="preview-pill"
              className={css({ fontFamily: 'sans', fontSize: 'xs', fontWeight: 'bold', letterSpacing: '0.1em', borderRadius: '6px', paddingX: '9px', paddingY: '5px', flex: 'none' })}
              style={{ color: '#0b0e14', background: ZONE_COLORS.warn }}
            >
              PREVIEW
            </span>
          )}
          <span
            data-testid="mode-badge"
            data-mode={action.mode}
            style={{
              color: isLive ? '#fff' : GH.textBright,
              background: isLive ? ZONE_COLORS.danger : TERM.button,
              boxShadow: isLive ? `0 0 0 3px rgba(248,81,73,0.22)` : undefined,
            }}
            className={css({
              fontFamily: 'sans',
              fontSize: 'xs',
              fontWeight: 'bold',
              letterSpacing: '0.1em',
              borderRadius: '6px',
              paddingX: '10px',
              paddingY: '5px',
              flex: 'none',
            })}
          >
            {isLive ? 'LIVE' : 'PAPER'}
          </span>
          <button
            type="button"
            aria-label="Reject and close"
            onClick={() => void decide('reject')}
            disabled={busy}
            className={css({
              width: '28px',
              height: '28px',
              borderRadius: '7px',
              flex: 'none',
              fontSize: '14px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '1px solid rgba(255,255,255,0.1)',
              _disabled: { opacity: 0.5, cursor: 'not-allowed' },
            })}
            style={{ background: TERM.button, color: GH.textMuted }}
          >
            ✕
          </button>
        </header>

        {/* Scrollable body */}
        <div className={css({ padding: '20px 22px', overflowY: 'auto' })}>
          {/* Side READOUT (segmented, non-editable) + market box */}
          <div className={css({ display: 'flex', gap: '12px', marginBottom: '18px' })}>
            <div
              className={css({
                display: 'flex',
                gap: '4px',
                borderRadius: '9px',
                padding: '4px',
                flex: 1,
              })}
              style={{ background: TERM.inset, border: '1px solid rgba(255,255,255,.08)' }}
            >
              {isReduceOnly ? (
                <SideSegment label={`REDUCE ${display.coin}`} active activeColor={ZONE_COLORS.warn} testid="approval-side" />
              ) : (
                <>
                  <SideSegment label="LONG" active={sideLong} activeColor={ZONE_COLORS.ok} testid={sideLong ? 'approval-side' : undefined} />
                  <SideSegment label="SHORT" active={!sideLong} activeColor={ZONE_COLORS.danger} testid={!sideLong ? 'approval-side' : undefined} />
                </>
              )}
            </div>
            <div
              className={css({
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                borderRadius: '9px',
                padding: '0 14px',
              })}
              style={{ background: TERM.inset, border: '1px solid rgba(255,255,255,.08)' }}
            >
              <span className={css({ fontFamily: 'mono', fontSize: '14px', fontWeight: 'semibold', color: 'github.textBright' })}>
                {display.coin}
              </span>
            </div>
          </div>

          {/* Size READOUT (risk-sized, fixed — not editable) */}
          <div className={css({ marginBottom: '18px' })}>
            <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '9px' })}>
              <span className={css({ fontFamily: 'sans', fontSize: '10.5px', fontWeight: 'semibold', textTransform: 'uppercase', letterSpacing: '0.1em' })} style={{ color: '#9aa4b5' }}>
                Size
              </span>
              <span className={css({ fontFamily: 'mono', fontSize: '12px', color: 'github.textMuted' })} style={{ fontFeatureSettings: '"tnum"' }}>
                ≈ {notionalUsd > 0 ? fmtCompactUsd(notionalUsd) : '—'} notional
              </span>
            </div>
            <div
              className={css({
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                borderRadius: '9px',
                padding: '11px 14px',
              })}
              style={{ background: TERM.inset, border: '1px solid rgba(255,255,255,.08)' }}
            >
              <span
                className={css({ flex: 1, fontFamily: 'mono', fontSize: '16px', fontWeight: 'semibold', color: 'github.textBright' })}
                style={{ fontFeatureSettings: '"tnum"' }}
              >
                {szStr}
              </span>
              <span className={css({ fontFamily: 'mono', fontSize: '12px' })} style={{ color: TERM.faint }}>
                {display.coin}
              </span>
            </div>
          </div>

          {/* Leverage control (OPENING orders only) */}
          {isOpening && (
            <LeverageControl
              coin={display.coin}
              coinMax={coinMax}
              leverage={leverage}
              setLeverage={(v) => setLeverage(clampLeverage(v, coinMax))}
              marginUsd={read.marginUsd}
              liqPx={read.liqPx}
              roeAtStopPct={read.roeAtStopPct}
              roeAtTargetPct={read.roeAtTargetPct}
              liqInsideStop={liqInsideStop}
              ackLiqInsideStop={ackLiqInsideStop}
              setAckLiqInsideStop={setAckLiqInsideStop}
              leaderLev={leaderLev}
              halfLev={halfLev}
            />
          )}

          {/* Summary box */}
          <div
            className={css({ borderRadius: '11px', padding: '6px 16px', marginBottom: '16px' })}
            style={{ background: TERM.inset, border: '1px solid token(colors.github.border)' }}
          >
            <SummaryRow label={action.kind === 'exit' ? 'Exit (market)' : 'Entry (market)'} value={fmtPx(entryPx)} />
            <SummaryRow label="Notional" value={notionalUsd > 0 ? fmtCompactUsd(notionalUsd) : '—'} color={GH.textBright} />
            {isOpening && <SummaryRow label="Margin required" value={fmtUsd(read.marginUsd).replace('+', '')} color={GH.textBright} />}
            <SummaryRow
              label="Liquidation price"
              value={liqPx == null ? '—' : `${fmtPx(liqPx)}${liqDistPct == null ? '' : ` (${liqDistPct.toFixed(1)}% away)`}`}
              color={liqDistColor}
            />
            {display.stopPx != null && <SummaryRow label="Stop" value={fmtPx(display.stopPx)} color={ZONE_COLORS.warn} />}
            {takerFeeUsd != null && <SummaryRow label="Est. taker fee" value={fmtUsd(takerFeeUsd).replace('+', '')} color={GH.textMuted} last />}
          </div>

          {/* Leader followed */}
          {leaderAddress && (
            <div
              data-testid="approval-leader"
              className={css({
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontFamily: 'mono',
                fontSize: 'xs',
                borderRadius: '9px',
                padding: '10px 14px',
                marginBottom: '12px',
              })}
              style={{ background: TERM.inset, border: '1px solid token(colors.github.border)' }}
            >
              <span className={css({ color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.05em' })}>
                Following leader
              </span>
              <span className={css({ color: 'github.link' })}>
                {leaderAddress.slice(0, 6)}…{leaderAddress.slice(-4)}
                {leaderLev != null && <span className={css({ color: 'github.textMuted' })}> · {leaderLev}×</span>}
              </span>
            </div>
          )}

          {/* Claude review (operator PREVIEW only): the verdict + note, or an
              honest "not reviewed yet" — approving while unreviewed is the
              operator's deliberate "force" call (NO-AUTO-FIRE: Claude can never
              execute; only this Approve does). */}
          {isPreview && (
            <div
              data-testid="preview-review"
              className={css({ display: 'flex', flexDirection: 'column', gap: '4px', padding: '11px 14px', borderRadius: '9px', marginBottom: '12px' })}
              style={{
                background: TERM.inset,
                // Reviewed → solid verdict-colored border. UNREVIEWED → a dashed
                // amber border so "force" (approving before Claude weighs in) reads
                // as a deliberate, distinct act, not a default.
                border: action.review
                  ? `1px solid ${reviewColor(action.review.verdict)}55`
                  : `1px dashed ${ZONE_COLORS.warn}66`,
              }}
            >
              {action.review ? (
                <>
                  <span className={css({ fontFamily: 'mono', fontSize: '10px', fontWeight: 'bold', letterSpacing: '0.06em' })} style={{ color: reviewColor(action.review.verdict) }}>
                    CLAUDE · {action.review.verdict.toUpperCase()}
                  </span>
                  <span className={css({ fontSize: '11.5px', lineHeight: '1.5', color: 'github.text' })}>
                    {action.review.note}
                  </span>
                </>
              ) : (
                <span className={css({ fontSize: '11.5px', lineHeight: '1.5', color: 'github.textMuted' })}>
                  ⏳ Claude hasn’t reviewed this yet — approving now is your call (force).
                </span>
              )}
            </div>
          )}

          {/* Risk note callout (colored dot + rationale) */}
          <div
            className={css({ display: 'flex', gap: '10px', padding: '11px 14px', borderRadius: '9px' })}
            style={{ background: riskBg, border: `1px solid ${riskBorder}` }}
          >
            <span className={css({ fontSize: '14px', lineHeight: '1.4', flex: 'none' })} style={{ color: riskColor }} aria-hidden>
              ●
            </span>
            <span className={css({ fontSize: '11.5px', lineHeight: '1.5', color: 'github.text' })}>
              {display.rationale}
            </span>
          </div>

          {/* LIVE typed-phrase gate */}
          {isLive && (
            <label className={css({ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '14px' })}>
              <span className={css({ fontSize: 'xs', color: 'zone.danger', fontWeight: 'semibold' })}>
                LIVE ORDER — type{' '}
                <code className={css({ fontFamily: 'mono', color: 'github.textBright' })}>{liveConfirmPhrase(display)}</code>{' '}
                to enable Approve
              </span>
              <input
                ref={inputRef}
                data-testid="live-confirm-input"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={liveConfirmPhrase(display)}
                className={css({
                  borderRadius: '9px',
                  color: 'github.textBright',
                  fontFamily: 'mono',
                  fontSize: 'sm',
                  padding: '10px 12px',
                })}
                style={{ background: TERM.inset, border: '1px solid rgba(255,255,255,.08)' }}
              />
            </label>
          )}

          {error && (
            <p data-testid="approval-error" className={css({ fontSize: 'xs', color: 'zone.danger', marginTop: '10px' })}>
              {error}
            </p>
          )}
        </div>

        {/* Footer: Cancel (Reject) quiet · Approve prominent (green / red-live). */}
        <div
          className={css({ display: 'flex', gap: '10px', padding: '16px 22px' })}
          style={{ borderTop: '1px solid rgba(255,255,255,.07)' }}
        >
          <button
            ref={rejectRef}
            type="button"
            data-testid="reject-button"
            disabled={busy}
            onClick={() => void decide('reject')}
            className={css({
              fontFamily: 'sans',
              fontSize: '13px',
              fontWeight: 'medium',
              borderRadius: '9px',
              padding: '13px 22px',
              cursor: 'pointer',
              _hover: { borderColor: 'github.textMuted' },
              _disabled: { opacity: 0.5, cursor: 'not-allowed' },
            })}
            style={{ background: TERM.button, color: GH.text, border: '1px solid rgba(255,255,255,.1)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="approve-button"
            disabled={!approveEnabled}
            onClick={() => void decide('approve')}
            style={{
              background: approveEnabled ? (isLive ? ZONE_COLORS.danger : ZONE_COLORS.ok) : TERM.button,
              color: approveEnabled ? (isLive ? '#fff' : TERM.darkText) : GH.textMuted,
            }}
            className={css({
              flex: 1,
              border: 'none',
              borderRadius: '9px',
              fontFamily: 'sans',
              fontSize: '13.5px',
              fontWeight: 'bold',
              letterSpacing: '0.03em',
              padding: '13px',
              cursor: 'pointer',
              _disabled: { opacity: 0.6, cursor: 'not-allowed' },
            })}
          >
            {approveLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

