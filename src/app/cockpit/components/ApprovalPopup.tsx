'use client';

/**
 * ApprovalPopup — the animated web replacement for the terminal confirm gate.
 *
 * Subscribes to the session's `pending_actions` (realtime, via usePendingActions)
 * and, whenever a row is 'pending', renders an animated modal summarizing the
 * proposed trade (coin / side / size / est px / stop / rationale + a PAPER/LIVE
 * badge) with Approve / Reject. Approving POSTs /api/cockpit/approve; rejecting
 * POSTs /api/cockpit/reject; the polling skill (requireApproval) then observes
 * the decision and executes (approve) or aborts (reject).
 *
 * THE INVARIANT: LIVE needs a STRONGER confirm than paper. PAPER = one-tap
 * Approve. LIVE = the operator must type the exact "side sz coin" phrase before
 * Approve enables (isApproveEnabled, unit-tested). Nothing here can fire a trade
 * on its own — it only flips a row the skill is polling. Dismisses on resolve.
 */

import { useEffect, useRef, useState } from 'react';
import { css } from '@styled-system/css';
import type { PendingAction } from '@/types/cockpit';
import { usePendingActions } from '@/hooks/usePendingActions';
import { isApproveEnabled, liveConfirmPhrase, summarizeProposal } from './approval-popup-helpers';
import { GH, ZONE_COLORS } from './panel-styles';

export interface ApprovalPopupProps {
  sessionId: string | null;
  /** Test/RSC seed: render this action instead of subscribing. */
  actionOverride?: PendingAction | null;
}

export default function ApprovalPopup({ sessionId, actionOverride }: ApprovalPopupProps) {
  const live = usePendingActions(actionOverride === undefined ? sessionId : null);
  const action = actionOverride !== undefined ? actionOverride : live.pending;

  if (!action) return null;
  return <PopupBody key={action.id} action={action} />;
}

function PopupBody({ action }: { action: PendingAction }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { display } = action.proposal;
  const isLive = action.mode === 'live';
  const approveEnabled = !busy && isApproveEnabled(action.mode, display, typed);

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
      const res = await fetch(`/api/cockpit/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: action.id }),
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
        bg: 'rgba(1, 4, 9, 0.72)',
        padding: '16px',
        animation: 'backdropIn 0.18s ease-out',
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
          maxWidth: '440px',
          bg: 'github.bgSecondary',
          border: '1px solid token(colors.github.border)',
          borderRadius: '12px',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
          boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
          animation: 'popupIn 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
        })}
      >
        <header className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' })}>
          <h2 className={css({ fontSize: 'md', fontWeight: 'bold', color: 'github.textBright' })}>
            Confirm {action.kind === 'entry' ? 'Entry' : action.kind === 'exit' ? 'Exit' : 'Action'}
          </h2>
          <span
            data-testid="mode-badge"
            data-mode={action.mode}
            style={{
              color: isLive ? '#fff' : GH.text,
              background: isLive ? ZONE_COLORS.danger : GH.border,
            }}
            className={css({
              fontSize: 'xs',
              fontWeight: 'bold',
              letterSpacing: '0.06em',
              borderRadius: '6px',
              paddingX: '8px',
              paddingY: '3px',
            })}
          >
            {isLive ? 'LIVE' : 'PAPER'}
          </span>
        </header>

        <p data-testid="proposal-summary" className={css({ fontSize: 'lg', fontWeight: 'semibold', color: 'github.textBright', fontFamily: 'mono' })}>
          {summarizeProposal(display, {
            kind: action.kind,
            mode: action.mode,
            reduceOnly: action.proposal.intent.reduceOnly,
          })}
        </p>

        <p className={css({ fontSize: 'sm', color: 'github.text', lineHeight: '1.5' })}>{display.rationale}</p>

        {isLive && (
          <label className={css({ display: 'flex', flexDirection: 'column', gap: '6px' })}>
            <span className={css({ fontSize: 'xs', color: 'zone.danger', fontWeight: 'semibold' })}>
              LIVE ORDER — type{' '}
              <code className={css({ fontFamily: 'mono', color: 'github.textBright' })}>
                {liveConfirmPhrase(display)}
              </code>{' '}
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
          <p data-testid="approval-error" className={css({ fontSize: 'xs', color: 'zone.danger' })}>
            {error}
          </p>
        )}

        <div className={css({ display: 'flex', gap: '10px' })}>
          <button
            ref={rejectRef}
            type="button"
            data-testid="reject-button"
            disabled={busy}
            onClick={() => void decide('reject')}
            className={css({
              flex: 1,
              bg: 'github.bg',
              border: '1px solid token(colors.github.border)',
              borderRadius: '8px',
              color: 'github.text',
              fontSize: 'sm',
              fontWeight: 'semibold',
              paddingY: '10px',
              cursor: 'pointer',
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
            style={{ background: approveEnabled ? ZONE_COLORS.ok : GH.border }}
            className={css({
              flex: 1,
              border: 'none',
              borderRadius: '8px',
              color: '#010409',
              fontSize: 'sm',
              fontWeight: 'bold',
              paddingY: '10px',
              cursor: 'pointer',
              _disabled: { opacity: 0.6, cursor: 'not-allowed', color: GH.textMuted },
            })}
          >
            {busy ? 'Submitting…' : 'Approve'}
          </button>
        </div>
      </section>
    </div>
  );
}
