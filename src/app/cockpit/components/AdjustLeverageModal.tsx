'use client';

/**
 * AdjustLeverageModal — change the leverage on an OPEN position.
 *
 * Changing leverage on an open isolated position does NOT change size; it adjusts the
 * required margin. At the margin floor (margin == notional/leverage) raising moves liq
 * toward the mark and lowering moves it away. But when EXTRA margin has been posted
 * (over-margined), liquidation is set by that margin, not the setting: raising/holding
 * leaves liq UNCHANGED, and only lowering below the effective leverage posts more
 * margin (liq further out) — you can't move liq toward the mark from here. The modal
 * shows the before/after live and gates a danger-band raise behind an ack. Posts to
 * /api/cockpit/adjust-leverage (server re-validates; LIVE pushes updateLeverage to HL).
 *
 * A11y: role=dialog, focus trap, Esc cancels (mirrors ExitModal).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { css } from '@styled-system/css';
import { ZONE_COLORS, GH, fmtPx } from './panel-styles';
import { resolveCoinMaxLeverage, isOverMargined } from '@/lib/trading/leverage-business-logic';
import { adjustLeveragePlan, ADJUST_LIQ_DANGER_PCT } from '@/lib/trading/adjust-leverage-business-logic';

export interface AdjustLeverageTarget {
  coin: string;
  side: 'long' | 'short';
  entryPx: number;
  markPx: number | null;
  currentLeverage: number | null;
  /** REAL HL liquidation now (reflects posted margin) — the honest "current liq". */
  realLiqPx?: number | null;
  /** Effective leverage = notional / margin used (reflects added margin). */
  effLeverage?: number | null;
}

export interface AdjustLeverageModalProps {
  target: AdjustLeverageTarget;
  onClose: () => void;
  /** Called after a successful update so the parent can refresh. */
  onExecuted?: () => void;
}

export default function AdjustLeverageModal({ target, onClose, onExecuted }: AdjustLeverageModalProps) {
  const coinMax = resolveCoinMaxLeverage(target.coin, null);
  const start = Math.min(coinMax, Math.max(1, Math.round(target.currentLeverage ?? 1)));
  const [lev, setLev] = useState(start);
  const [ack, setAck] = useState(false);
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
      dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
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

  const plan = useMemo(
    () =>
      adjustLeveragePlan({
        side: target.side,
        entryPx: target.entryPx,
        markPx: target.markPx,
        currentLeverage: target.currentLeverage,
        requestedLeverage: lev,
        coinMax,
      }),
    [target.side, target.entryPx, target.markPx, target.currentLeverage, lev, coinMax],
  );

  const noChange = !plan.changed;
  // The REAL current liquidation (reflects margin you've posted) — the formula
  // plan.currentLiqPx ignores it. Prefer the real value when we have it.
  const realCurrentLiq = target.realLiqPx ?? plan.currentLiqPx;
  const realCurrentLiqDistPct = realCurrentLiq != null && target.markPx != null && target.markPx > 0
    ? (Math.abs(realCurrentLiq - target.markPx) / target.markPx) * 100 : null;
  const overMargined = isOverMargined(target.effLeverage, target.currentLeverage);

  // CORRECT model for an over-margined isolated position: liquidation is set by the
  // MARGIN you've posted, not the leverage setting. Raising or holding leverage leaves
  // your margin untouched → liq UNCHANGED (the setting just lowers the required-margin
  // floor, which you're already above). Only LOWERING leverage below your effective
  // leverage forces HL to post more margin → liq moves FURTHER from the mark (safer).
  // You can never move liq TOWARD the mark via the leverage setting — so the formula
  // danger guard doesn't apply here.
  const eff = target.effLeverage;
  const postsMoreMargin = overMargined && eff != null && plan.leverage < eff;
  const displayNewLiqPx = !overMargined ? plan.liqPx : postsMoreMargin ? plan.liqPx : realCurrentLiq;
  const displayNewLiqDistPct = !overMargined ? plan.liqDistFromMarkPct : postsMoreMargin ? plan.liqDistFromMarkPct : realCurrentLiqDistPct;
  // Over-margined → leverage can't push liq toward the mark, so no danger-ack ever.
  const dangerNearMark = overMargined ? false : plan.dangerNearMark;
  const blockedByAck = dangerNearMark && !ack;
  // Lowering leverage on an isolated position = posting more margin; HL rejects when
  // free collateral is short. "Add margin" does the same de-risk without that
  // restriction, so nudge toward it when the operator drags leverage DOWN.
  const isLowering = target.currentLeverage != null && plan.leverage < Math.round(target.currentLeverage);

  async function fire(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/cockpit/adjust-leverage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ coin: target.coin, leverage: plan.leverage, ackDanger: ack }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; requiresAck?: boolean };
      if (!res.ok || json.ok === false) {
        if (json.requiresAck) setAck(false); // server wants an explicit ack
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
        data-testid="adjust-lev-modal"
        data-coin={target.coin}
        role="dialog"
        aria-modal="true"
        aria-label={`Adjust ${target.coin} leverage`}
        className={css({ width: '100%', maxWidth: { base: '100%', md: '460px' }, maxHeight: '92vh', overflowY: 'auto', bg: 'cockpit.inset', border: '1px solid token(colors.github.border)', borderRadius: { base: '16px 16px 0 0', md: '16px' }, paddingBottom: { base: 'env(safe-area-inset-bottom)', md: '0' }, display: 'flex', flexDirection: 'column', animation: 'popupIn 0.2s cubic-bezier(0.2,0.8,0.2,1)' })}
        style={{ boxShadow: '0 30px 80px rgba(0,0,0,0.6)' }}
      >
        <header className={css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px', borderBottom: '1px solid token(colors.github.borderSubtle)' })}>
          <h2 className={css({ fontFamily: 'sans', fontSize: '13px', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 'semibold', color: 'github.textBright' })}>
            Adjust {target.coin}-PERP Leverage
          </h2>
          <button type="button" data-testid="adjust-lev-close" aria-label="Cancel" onClick={onClose} className={css({ width: '28px', height: '28px', bg: 'cockpit.button', border: '1px solid token(colors.github.border)', borderRadius: '7px', color: 'github.textMuted', cursor: 'pointer', fontSize: '14px' })}>
            ✕
          </button>
        </header>

        <div className={css({ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: '16px' })}>
          <p className={css({ fontSize: '12px', color: 'github.textMuted', lineHeight: '1.55' })}>
            Leverage only — your position size doesn&apos;t change. This adjusts the isolated margin, which moves your liquidation price.
          </p>

          {/* Slider */}
          <div className={css({ display: 'flex', flexDirection: 'column', gap: '10px' })}>
            <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' })}>
              <span className={css({ fontFamily: 'sans', fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'github.textMuted', fontWeight: 'semibold' })}>
                Leverage
              </span>
              <span data-testid="adjust-lev-value" style={{ fontFeatureSettings: '"tnum"' }} className={css({ fontFamily: 'mono', fontSize: '18px', fontWeight: 'semibold', color: 'github.textBright' })}>
                {plan.leverage}×
              </span>
            </div>
            <input
              type="range"
              data-testid="adjust-lev-slider"
              min={1}
              max={coinMax}
              step={1}
              value={lev}
              onChange={(e) => {
                setLev(Number(e.target.value));
                setAck(false); // any change re-requires the danger ack
              }}
              aria-label="Leverage"
              aria-valuetext={`${plan.leverage} times`}
              className={css({ width: '100%', accentColor: '#5b8cff', cursor: 'pointer' })}
            />
            <div className={css({ display: 'flex', justifyContent: 'space-between' })}>
              <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'cockpit.faint' })}>1×</span>
              <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'cockpit.faint' })}>{coinMax}× max</span>
            </div>
          </div>

          {/* Before / after summary */}
          <div className={css({ bg: 'cockpit.inset', border: '1px solid token(colors.github.border)', borderRadius: '11px', paddingX: '16px' })}>
            <SummaryRow label="Current leverage" value={target.currentLeverage != null ? `${Math.round(target.currentLeverage)}×${overMargined && target.effLeverage != null ? ` · ${target.effLeverage.toFixed(1)}× eff` : ''}` : '—'} color={GH.textMuted} />
            <SummaryRow label="New leverage" value={`${plan.leverage}×`} />
            <SummaryRow label="Current liq" value={`${fmtPx(realCurrentLiq)}${realCurrentLiqDistPct != null ? ` (${realCurrentLiqDistPct.toFixed(1)}%)` : ''}`} color={GH.textMuted} />
            <SummaryRow
              label="New liq"
              value={fmtPx(displayNewLiqPx)}
              color={dangerNearMark ? ZONE_COLORS.danger : GH.text}
              testid="adjust-lev-newliq"
            />
            <SummaryRow
              label="Liq vs mark"
              value={displayNewLiqDistPct == null ? '—' : `${displayNewLiqDistPct.toFixed(1)}% away`}
              color={dangerNearMark ? ZONE_COLORS.danger : GH.textMuted}
              last
            />
          </div>

          {overMargined && (
            <p data-testid="adjust-lev-overmargined" className={css({ fontSize: '11px', lineHeight: '1.5', borderRadius: '9px', padding: '10px 13px' })} style={{ background: 'rgba(217,164,65,0.1)', border: '1px solid rgba(217,164,65,0.34)', color: '#e6c478' }}>
              ℹ Your liquidation here is set by the margin you&apos;ve posted (effective {target.effLeverage?.toFixed(1)}×), not the leverage setting — it sits far out at {fmtPx(realCurrentLiq)}. Raising or holding leverage <strong>won&apos;t move it</strong>; lowering below {target.effLeverage?.toFixed(1)}× posts more margin (liq further out). You can&apos;t bring liquidation closer from here — to free up margin, remove it; to de-risk, use <strong>Add margin</strong>.
            </p>
          )}

          {isLowering && !overMargined && (
            <p data-testid="adjust-lev-derisk-nudge" className={css({ fontSize: '11px', lineHeight: '1.5', borderRadius: '9px', padding: '10px 13px' })} style={{ background: 'rgba(91,140,255,0.08)', border: '1px solid rgba(91,140,255,0.28)', color: '#9ab4ff' }}>
              De-risking? Lowering leverage posts margin, and HL rejects it if your free collateral is short. <strong>Add margin</strong> (in a position&apos;s insights) pushes liquidation away the same way without that restriction.
            </p>
          )}

          {dangerNearMark && (
            <label data-testid="adjust-lev-ack" className={css({ display: 'flex', alignItems: 'flex-start', gap: '9px', padding: '11px 13px', borderRadius: '9px', cursor: 'pointer' })} style={{ background: 'rgba(242,77,94,0.08)', border: '1px solid rgba(242,77,94,0.32)' }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className={css({ marginTop: '2px', accentColor: '#f24d5e', cursor: 'pointer' })} />
              <span className={css({ fontSize: '11.5px', lineHeight: '1.5', color: 'zone.danger' })}>
                At {plan.leverage}× your liquidation sits within {ADJUST_LIQ_DANGER_PCT}% of the current mark — a small adverse move could liquidate. I understand and want to proceed.
              </span>
            </label>
          )}

          {error && <p data-testid="adjust-lev-error" className={css({ fontSize: '12px', color: 'zone.danger' })}>{error}</p>}
        </div>

        <div className={css({ display: 'flex', gap: '10px', padding: '16px 22px', borderTop: '1px solid token(colors.github.borderSubtle)' })}>
          <button
            ref={cancelRef}
            type="button"
            data-testid="adjust-lev-cancel"
            disabled={busy}
            onClick={onClose}
            className={css({ fontFamily: 'sans', fontSize: '13px', fontWeight: 'medium', color: 'github.text', bg: 'cockpit.button', border: '1px solid token(colors.github.border)', borderRadius: '9px', paddingX: '22px', paddingY: '13px', cursor: 'pointer', _disabled: { opacity: 0.5 } })}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="adjust-lev-confirm"
            disabled={busy || blockedByAck || noChange}
            onClick={() => void fire()}
            style={{ background: blockedByAck || noChange ? '#2a3140' : '#5b8cff', color: '#fff' }}
            className={css({ flex: 1, border: 'none', borderRadius: '9px', fontFamily: 'sans', fontSize: '13.5px', fontWeight: 'bold', letterSpacing: '0.03em', paddingY: '13px', cursor: 'pointer', _disabled: { opacity: 0.6, cursor: 'not-allowed' } })}
          >
            {busy ? 'Applying…' : noChange ? 'No change' : `Set ${plan.leverage}×`}
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
