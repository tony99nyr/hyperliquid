'use client';

/**
 * ExitModal (design handoff) — the verify-every-exit gate.
 *
 * Two modes:
 *   - single-position Close / Reduce: a close-amount slider (5–100%) + 25/50/75/
 *     100 presets, a live summary (closing amount / exit mark / entry / est.
 *     realized PnL / est. fee / resulting equity), and a red confirm.
 *   - "Safe-Exit · Close All": NO slider; closes every open position. Delegates
 *     to the hardened SafeExitButton fire path (full close, dead-man's switch).
 *
 * Execution rides the SAME hardened server route as the panic button
 * (/api/cockpit/safe-exit): reduce-only, server-resolved live position, ONE seam.
 * A partial close posts `{ coin, fraction }`; a full single close posts
 * `{ coin }`; close-all posts `{}`. Nothing here can open or grow exposure.
 *
 * A11y: role=dialog, focus trap, Esc cancels (mirrors ApprovalPopup).
 */

import { useEffect, useRef, useState } from 'react';
import { css } from '@styled-system/css';
import { ZONE_COLORS, TERM, GH, fmtUsd, fmtPx } from './panel-styles';
import { quoteExit } from './open-positions-helpers';

export interface ExitTarget {
  coin: string;
  side: 'long' | 'short';
  size: number;
  entryPx: number;
  markPx: number;
}

export interface ExitModalProps {
  /** A single position to close/reduce, or null for the close-all scope. */
  target: ExitTarget | null;
  /** Scope: a position close/reduce, or close-all. */
  scope: 'single' | 'all';
  /** Number of open positions (for the close-all summary). */
  openCount?: number;
  /** Current account equity before the close (for resulting-equity math). */
  currentEquityUsd: number;
  /** Initial close percent (Reduce opens at 25, Close at 100). */
  initialPct?: number;
  onClose: () => void;
  /** Called after a successful fire so the parent can refresh. */
  onExecuted?: () => void;
}

function pxDecimals(coin: string): number {
  if (coin === 'BTC') return 0;
  if (coin === 'HYPE' || coin === 'LTC') return 2;
  return 1;
}

export default function ExitModal({
  target,
  scope,
  openCount = 0,
  currentEquityUsd,
  initialPct = 100,
  onClose,
  onExecuted,
}: ExitModalProps) {
  const [pct, setPct] = useState(scope === 'all' ? 100 : initialPct);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
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
      if (!busy) onClose();
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

  const frac = pct / 100;
  const isAll = scope === 'all';
  const hasSlider = !isAll && frac < 1.0001; // single shows the slider
  const isReduce = !isAll && frac < 1;

  const quote =
    target != null
      ? quoteExit({ side: target.side, size: target.size, entryPx: target.entryPx, markPx: target.markPx, frac, currentEquityUsd })
      : null;

  const dec = target ? pxDecimals(target.coin) : 1;
  const title = isAll
    ? 'Safe-Exit · Close All'
    : target
      ? `${isReduce ? 'Reduce' : 'Close'} ${target.coin}-PERP`
      : 'Exit';

  async function fire(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const body: { coin?: string; fraction?: number } = {};
      if (!isAll && target) {
        body.coin = target.coin;
        if (isReduce) body.fraction = frac;
      }
      const res = await fetch('/api/cockpit/safe-exit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || json.ok === false) {
        setError(json.error ?? `Failed (${res.status})`);
        setBusy(false);
        return;
      }
      onExecuted?.();
      onClose();
    } catch {
      setError('Network error — retry.');
      setBusy(false);
    }
  }

  const confirmLabel = isAll
    ? 'SAFE-EXIT ALL'
    : isReduce
      ? `Reduce ${target?.side === 'long' ? 'Long' : 'Short'}`
      : `Close ${target?.side === 'long' ? 'Long' : 'Short'}`;

  return (
    <div
      ref={overlayRef}
      role="presentation"
      onKeyDown={onKeyDown}
      className={css({ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: { base: 'flex-end', md: 'center' }, justifyContent: 'center', padding: { base: '0', md: '16px' }, overflowY: 'auto', animation: 'backdropIn 0.15s ease' })}
      style={{ background: 'rgba(4,6,10,0.65)', backdropFilter: 'blur(3px)' }}
    >
      <section
        ref={dialogRef}
        data-testid="exit-modal"
        data-scope={scope}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={css({ width: '100%', maxWidth: { base: '100%', md: '480px' }, maxHeight: '92vh', overflowY: 'auto', bg: 'cockpit.inset', border: '1px solid', borderColor: 'rgba(242,77,94,0.3)', borderRadius: { base: '16px 16px 0 0', md: '16px' }, paddingBottom: { base: 'env(safe-area-inset-bottom)', md: '0' }, display: 'flex', flexDirection: 'column', animation: 'popupIn 0.2s cubic-bezier(0.2,0.8,0.2,1)' })}
        style={{ boxShadow: '0 30px 80px rgba(0,0,0,0.6)' }}
      >
        <header className={css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px', borderBottom: '1px solid token(colors.github.borderSubtle)' })}>
          <h2 data-testid="exit-title" className={css({ fontFamily: 'sans', fontSize: '13px', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 'semibold', color: 'zone.danger' })}>
            {title}
          </h2>
          <button type="button" data-testid="exit-close" aria-label="Cancel" onClick={onClose} className={css({ width: '28px', height: '28px', bg: 'cockpit.button', border: '1px solid token(colors.github.border)', borderRadius: '7px', color: 'github.textMuted', cursor: 'pointer', fontSize: '14px' })}>
            ✕
          </button>
        </header>

        <div className={css({ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: '16px' })}>
          <p className={css({ fontSize: '12px', color: 'github.textMuted', lineHeight: '1.55' })}>
            {isAll
              ? `Market-close all ${openCount} open position${openCount === 1 ? '' : 's'} immediately (reduce-only). This runs independently of Claude.`
              : target
                ? `Market ${isReduce ? 'reduce' : 'close'} your ${target.side} at the current mark of ${fmtPx(target.markPx)}.`
                : ''}
          </p>

          {hasSlider && target && (
            <div className={css({ display: 'flex', flexDirection: 'column', gap: '10px' })}>
              <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' })}>
                <span className={css({ fontFamily: 'sans', fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'github.textMuted', fontWeight: 'semibold' })}>
                  Close amount
                </span>
                <span data-testid="exit-pct" style={{ fontFeatureSettings: '"tnum"' }} className={css({ fontFamily: 'mono', fontSize: '18px', fontWeight: 'semibold', color: 'zone.danger' })}>
                  {pct}%
                </span>
              </div>
              <input
                type="range"
                data-testid="exit-slider"
                min={5}
                max={100}
                step={5}
                value={pct}
                onChange={(e) => setPct(Number(e.target.value))}
                aria-label="Close amount percent"
                className={css({ width: '100%', accentColor: '#f24d5e', cursor: 'pointer' })}
              />
              <div className={css({ display: 'flex', gap: '8px' })}>
                {[25, 50, 75, 100].map((p) => (
                  <button
                    key={p}
                    type="button"
                    data-testid={`exit-preset-${p}`}
                    onClick={() => setPct(p)}
                    className={css({ flex: 1, fontFamily: 'mono', fontSize: '11px', color: 'github.textMuted', bg: 'cockpit.focal', border: '1px solid token(colors.github.border)', borderRadius: '6px', paddingY: '7px', cursor: 'pointer', _hover: { borderColor: 'cockpit.accent' } })}
                  >
                    {p}%
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Summary box */}
          <div className={css({ bg: 'cockpit.inset', border: '1px solid token(colors.github.border)', borderRadius: '11px', paddingX: '16px' })}>
            {!isAll && target && quote ? (
              <>
                <SummaryRow label="Closing" value={`${quote.closeSize.toLocaleString('en-US', { maximumFractionDigits: target.coin === 'BTC' ? 3 : 2 })} ${target.coin} (${pct}%)`} />
                <SummaryRow label="Exit (mark)" value={target.markPx.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })} />
                <SummaryRow label="Entry" value={target.entryPx.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })} color={GH.textMuted} />
                <SummaryRow label="Est. realized PnL" value={fmtUsd(quote.realizedNetUsd)} color={quote.realizedNetUsd >= 0 ? ZONE_COLORS.ok : ZONE_COLORS.danger} testid="exit-realized" />
                <SummaryRow label="Est. fee" value={`$${quote.feeUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} color={GH.textMuted} />
                <SummaryRow label="Resulting equity" value={`$${quote.resultingEquityUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} last />
              </>
            ) : (
              <>
                <SummaryRow label="Positions closed" value={String(openCount)} />
                <SummaryRow label="Mode" value="Market · reduce-only" color={GH.textMuted} />
                <SummaryRow label="Resulting equity" value={`$${currentEquityUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} last />
              </>
            )}
          </div>

          {error && (
            <p data-testid="exit-error" className={css({ fontSize: '12px', color: 'zone.danger' })}>{error}</p>
          )}
        </div>

        <div className={css({ display: 'flex', gap: '10px', padding: '16px 22px', borderTop: '1px solid token(colors.github.borderSubtle)' })}>
          <button
            ref={cancelRef}
            type="button"
            data-testid="exit-cancel"
            disabled={busy}
            onClick={onClose}
            className={css({ fontFamily: 'sans', fontSize: '13px', fontWeight: 'medium', color: 'github.text', bg: 'cockpit.button', border: '1px solid token(colors.github.border)', borderRadius: '9px', paddingX: '22px', paddingY: '13px', cursor: 'pointer', _disabled: { opacity: 0.5 } })}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="exit-confirm"
            disabled={busy}
            onClick={() => void fire()}
            style={{ background: TERM.safeExit, color: '#fff' }}
            className={css({ flex: 1, border: 'none', borderRadius: '9px', fontFamily: 'sans', fontSize: '13.5px', fontWeight: 'bold', letterSpacing: '0.03em', paddingY: '13px', cursor: 'pointer', _disabled: { opacity: 0.6, cursor: 'not-allowed' } })}
          >
            {busy ? 'Exiting…' : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function SummaryRow({ label, value, color, last, testid }: { label: string; value: string; color?: string; last?: boolean; testid?: string }) {
  return (
    <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', paddingY: '9px', borderBottom: last ? 'none' : '1px solid token(colors.github.borderSubtle)' })}>
      <span className={css({ fontSize: '12px', color: 'github.textMuted' })}>{label}</span>
      <span data-testid={testid} style={{ color: color ?? GH.text, fontFeatureSettings: '"tnum"' }} className={css({ fontFamily: 'mono', fontSize: '12.5px', fontWeight: 'medium' })}>
        {value}
      </span>
    </div>
  );
}
