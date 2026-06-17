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
import { WarningTriangle } from './WarningTriangle';
import { isApproveEnabled, liveConfirmPhrase, summarizeProposal } from './approval-popup-helpers';
import { GH, ZONE_COLORS, fmtPx, fmtUsd, fmtCompactUsd, fmtPctSigned } from './panel-styles';

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
  const action = actionOverride !== undefined ? actionOverride : live.pending;

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
      // Approving an OPENING order sends the operator-chosen leverage; the server
      // re-validates it to [1, coinMax]. Reject + reduce-only exits send only id.
      const body: { id: string; leverage?: number } = { id: action.id };
      if (path === 'approve' && isOpening) body.leverage = leverage;
      const res = await fetch(`/api/cockpit/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
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
  const sideColor = sideLong ? ZONE_COLORS.ok : ZONE_COLORS.danger;
  const kindLabel = action.kind === 'entry' ? 'Entry' : action.kind === 'exit' ? 'Exit' : 'Action';

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
        alignItems: 'center',
        justifyContent: 'center',
        bg: 'rgba(1, 4, 9, 0.78)',
        padding: '16px',
        animation: 'backdropIn 0.18s ease-out',
        overflowY: 'auto',
      })}
    >
      <section
        ref={dialogRef}
        data-testid="approval-popup"
        role="dialog"
        aria-modal="true"
        aria-label="Trade approval"
        className={css({
          width: '100%',
          maxWidth: '460px',
          maxHeight: '94vh',
          overflowY: 'auto',
          bg: 'github.bgSecondary',
          border: '1px solid token(colors.github.border)',
          borderRadius: '14px',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0,0,0,0.7)',
          animation: 'popupIn 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
        })}
      >
        {/* Header band: title · side · mode badge */}
        <header
          className={css({
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '10px',
            padding: '16px 18px',
            borderBottom: '1px solid token(colors.github.border)',
          })}
        >
          <div className={css({ display: 'flex', flexDirection: 'column', gap: '2px' })}>
            <h2
              className={css({
                fontFamily: 'label',
                fontSize: 'sm',
                fontWeight: 'bold',
                color: 'github.textBright',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              })}
            >
              Confirm {kindLabel}
            </h2>
            <span data-testid="proposal-summary" className={css({ fontSize: '10px', color: 'github.textMuted', fontFamily: 'mono' })}>
              {summarizeProposal(display, {
                kind: action.kind,
                mode: action.mode,
                reduceOnly: intent.reduceOnly,
              })}
            </span>
          </div>
          <span
            data-testid="mode-badge"
            data-mode={action.mode}
            style={{
              color: isLive ? '#fff' : GH.textBright,
              background: isLive ? ZONE_COLORS.danger : GH.border,
              boxShadow: isLive ? `0 0 0 3px rgba(248,81,73,0.22)` : undefined,
            }}
            className={css({
              fontFamily: 'label',
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
        </header>

        {/* Tabular trade data */}
        <div className={css({ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: '0' })}>
          <DataRow label="Coin" value={display.coin} strong />
          <DataRow
            label="Side"
            value={sideLong ? 'LONG (buy)' : 'SHORT (sell)'}
            color={sideColor}
            testid="approval-side"
          />
          <DataRow label="Size" value={display.sz.toLocaleString('en-US', { maximumFractionDigits: 6 })} />
          <DataRow label={action.kind === 'exit' ? 'Est. px' : 'Entry / est. px'} value={entryPx == null ? '—' : fmtPx(entryPx)} />
          {display.stopPx != null && <DataRow label="Stop" value={fmtPx(display.stopPx)} color={ZONE_COLORS.warn} />}
          <DataRow label="Notional" value={read.notionalUsd > 0 ? fmtCompactUsd(read.notionalUsd) : '—'} />
          {isOpening && (
            <DataRow label="Leverage" value={`${leverage.toLocaleString('en-US', { maximumFractionDigits: 1 })}×`} color={GH.textBright} testid="approval-leverage-row" strong />
          )}
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

        {/* Leader followed */}
        {leaderAddress && (
          <div
            data-testid="approval-leader"
            className={css({
              padding: '10px 18px',
              borderTop: '1px solid token(colors.github.borderSubtle)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontFamily: 'mono',
              fontSize: 'xs',
            })}
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

        {/* Rationale */}
        <p className={css({ padding: '12px 18px', fontSize: 'sm', color: 'github.text', lineHeight: '1.5', borderTop: '1px solid token(colors.github.borderSubtle)' })}>
          {display.rationale}
        </p>

        {/* LIVE typed-phrase gate */}
        {isLive && (
          <label className={css({ display: 'flex', flexDirection: 'column', gap: '6px', padding: '0 18px 12px' })}>
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
                bg: 'github.bg',
                border: '1px solid token(colors.github.border)',
                borderRadius: '6px',
                color: 'github.textBright',
                fontFamily: 'mono',
                fontSize: 'sm',
                padding: '8px 10px',
              })}
            />
          </label>
        )}

        {error && (
          <p data-testid="approval-error" className={css({ fontSize: 'xs', color: 'zone.danger', padding: '0 18px 8px' })}>
            {error}
          </p>
        )}

        {/* Actions — weighted: Reject quiet, Approve prominent (green / red-live). */}
        <div className={css({ display: 'flex', gap: '10px', padding: '14px 18px 18px' })}>
          <button
            ref={rejectRef}
            type="button"
            data-testid="reject-button"
            disabled={busy}
            onClick={() => void decide('reject')}
            className={css({
              flex: '0 0 38%',
              bg: 'github.bg',
              border: '1px solid token(colors.github.border)',
              borderRadius: '8px',
              color: 'github.text',
              fontFamily: 'label',
              fontSize: 'sm',
              fontWeight: 'semibold',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              paddingY: '12px',
              cursor: 'pointer',
              _hover: { bg: 'github.bgSecondary', borderColor: 'github.textMuted' },
              _disabled: { opacity: 0.5, cursor: 'not-allowed' },
            })}
          >
            Reject
          </button>
          <button
            type="button"
            data-testid="approve-button"
            disabled={!approveEnabled}
            onClick={() => void decide('approve')}
            style={{ background: approveEnabled ? (isLive ? ZONE_COLORS.danger : ZONE_COLORS.ok) : GH.border }}
            className={css({
              flex: 1,
              border: 'none',
              borderRadius: '8px',
              color: isLive && approveEnabled ? '#fff' : '#010409',
              fontFamily: 'label',
              fontSize: 'sm',
              fontWeight: 'bold',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              paddingY: '12px',
              cursor: 'pointer',
              _disabled: { opacity: 0.6, cursor: 'not-allowed', color: GH.textMuted },
            })}
          >
            {busy ? 'Submitting…' : isLive ? 'Approve LIVE' : 'Approve'}
          </button>
        </div>
      </section>
    </div>
  );
}

/** One label/value row in the tabular trade body. */
function DataRow({
  label,
  value,
  color,
  strong,
  testid,
}: {
  label: string;
  value: string;
  color?: string;
  strong?: boolean;
  testid?: string;
}) {
  return (
    <div
      className={css({
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        paddingY: '5px',
        borderBottom: '1px solid token(colors.github.borderSubtle)',
        _last: { borderBottom: 'none' },
      })}
    >
      <span className={css({ fontFamily: 'label', fontSize: '10px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.06em' })}>
        {label}
      </span>
      <span
        data-testid={testid}
        style={{ color: color ?? GH.text, fontFeatureSettings: '"tnum"' }}
        className={css({ fontFamily: 'mono', fontSize: strong ? 'sm' : 'xs', fontWeight: strong ? 'bold' : 'normal' })}
      >
        {value}
      </span>
    </div>
  );
}

/** The leverage slider + presets + live margin/liq/ROE read + safety guard. */
function LeverageControl({
  coin,
  coinMax,
  leverage,
  setLeverage,
  marginUsd,
  liqPx,
  roeAtStopPct,
  roeAtTargetPct,
  liqInsideStop,
  ackLiqInsideStop,
  setAckLiqInsideStop,
  leaderLev,
  halfLev,
}: {
  coin: string;
  coinMax: number;
  leverage: number;
  setLeverage: (v: number) => void;
  marginUsd: number;
  liqPx: number | null;
  roeAtStopPct: number | null;
  roeAtTargetPct: number | null;
  liqInsideStop: boolean;
  ackLiqInsideStop: boolean;
  setAckLiqInsideStop: (v: boolean) => void;
  leaderLev: number | null;
  halfLev: number | null;
}) {
  // A11y (Fix 5): announce the CONSEQUENCE of the slider, not just the multiplier.
  const liqText = liqPx == null ? 'n/a' : fmtPx(liqPx);
  const roeTargetText = roeAtTargetPct == null ? 'n/a' : fmtPctSigned(roeAtTargetPct);
  const sliderValueText = `${leverage}×, margin ${fmtUsd(marginUsd).replace('+', '')}, est. liq ${liqText}, ROE at target ${roeTargetText}`;
  return (
    <div
      data-testid="leverage-control"
      className={css({
        padding: '12px 18px',
        borderTop: '1px solid token(colors.github.border)',
        bg: 'github.bg',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      })}
    >
      <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' })}>
        <span className={css({ fontFamily: 'label', fontSize: '10px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.07em' })}>
          Leverage · your risk decision
        </span>
        <span data-testid="leverage-value" style={{ fontFeatureSettings: '"tnum"' }} className={css({ fontFamily: 'mono', fontSize: 'lg', fontWeight: 'bold', color: 'github.textBright' })}>
          {leverage.toLocaleString('en-US', { maximumFractionDigits: 1 })}×
        </span>
      </div>

      <input
        type="range"
        data-testid="leverage-slider"
        min={1}
        max={coinMax}
        step={1}
        value={leverage}
        onChange={(e) => setLeverage(Number(e.target.value))}
        aria-label={`Leverage, 1 to ${coinMax} times`}
        aria-valuetext={sliderValueText}
        className={css({ width: '100%', accentColor: '#58a6ff', cursor: 'pointer' })}
      />
      <div className={css({ display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: 'github.textMuted', fontFamily: 'mono' })}>
        <span>1×</span>
        <span>{coinMax}× max ({coin})</span>
      </div>

      {/* Presets: Match leader (N×) + ½ leader. */}
      {(leaderLev != null || halfLev != null) && (
        <div className={css({ display: 'flex', gap: '8px' })}>
          {leaderLev != null && (
            <PresetButton testid="match-leader-button" label={`Match leader (${leaderLev}×)`} onClick={() => setLeverage(leaderLev)} />
          )}
          {halfLev != null && (
            <PresetButton testid="half-leader-button" label={`½ leader (${halfLev}×)`} onClick={() => setLeverage(halfLev)} />
          )}
        </div>
      )}

      {/* Live derived read: margin / liq / ROE@stop / ROE@target. */}
      <div className={css({ display: 'flex', gap: '10px', flexWrap: 'wrap' })}>
        <ReadCell label="Margin" value={fmtUsd(marginUsd).replace('+', '')} testid="leverage-margin" />
        <ReadCell label="Est. liq" value={fmtPx(liqPx)} color={liqInsideStop ? ZONE_COLORS.danger : GH.text} testid="leverage-liq" />
        <ReadCell label="ROE @ stop" value={roeAtStopPct == null ? '—' : fmtPctSigned(roeAtStopPct)} color={roeAtStopPct != null && roeAtStopPct < 0 ? ZONE_COLORS.danger : GH.text} testid="leverage-roe-stop" />
        {roeAtTargetPct != null && (
          <ReadCell label="ROE @ target" value={fmtPctSigned(roeAtTargetPct)} color={ZONE_COLORS.ok} testid="leverage-roe-target" />
        )}
      </div>

      {/* SAFETY GUARD — liquidation inside the stop. role="alert" so a screen
          reader dragging the slider HEARS the message on state change (Fix 4). */}
      {liqInsideStop && (
        <div
          data-testid="liq-inside-stop-warning"
          role="alert"
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            bg: 'rgba(248,81,73,0.12)',
            border: '1px solid token(colors.zone.danger)',
            borderRadius: '6px',
            padding: '8px 10px',
          })}
        >
          <div className={css({ display: 'flex', gap: '8px', alignItems: 'flex-start' })}>
            {/* Font-independent SVG warning triangle (no emoji → no tofu, Fix 1). */}
            <WarningTriangle />
            <span className={css({ fontSize: 'xs', color: 'zone.danger', fontWeight: 'semibold', lineHeight: '1.4' })}>
              Liquidation before stop — at {leverage}× the position liquidates before your stop can trigger. Reduce leverage.
            </span>
          </div>
          {/* Approve is GATED while this warning shows (Fix 2): clear it by
              reducing leverage, or explicitly acknowledge the broken risk plan. */}
          <label
            data-testid="liq-ack-label"
            className={css({ display: 'flex', gap: '7px', alignItems: 'flex-start', cursor: 'pointer' })}
          >
            <input
              type="checkbox"
              data-testid="liq-ack-checkbox"
              checked={ackLiqInsideStop}
              onChange={(e) => setAckLiqInsideStop(e.target.checked)}
              className={css({ marginTop: '2px', accentColor: '#f85149', cursor: 'pointer' })}
            />
            <span className={css({ fontSize: '11px', color: 'github.text', lineHeight: '1.4' })}>
              I understand liquidation is inside my stop
            </span>
          </label>
        </div>
      )}
    </div>
  );
}

function PresetButton({ label, onClick, testid }: { label: string; onClick: () => void; testid: string }) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      className={css({
        flex: 1,
        bg: 'github.bgSecondary',
        border: '1px solid token(colors.github.border)',
        borderRadius: '6px',
        color: 'github.text',
        fontFamily: 'mono',
        fontSize: '11px',
        paddingY: '7px',
        cursor: 'pointer',
        _hover: { borderColor: 'github.link', color: 'github.textBright' },
      })}
    >
      {label}
    </button>
  );
}

function ReadCell({ label, value, color, testid }: { label: string; value: string; color?: string; testid: string }) {
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '1px', minWidth: '64px' })}>
      <span className={css({ fontFamily: 'label', fontSize: '8px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.06em' })}>
        {label}
      </span>
      <span data-testid={testid} style={{ color: color ?? GH.text, fontFeatureSettings: '"tnum"' }} className={css({ fontFamily: 'mono', fontSize: 'sm', fontWeight: 'bold' })}>
        {value}
      </span>
    </div>
  );
}
