'use client';

/**
 * PositionInsightsModal — the operator's OWN open-position drill-down. Opened by
 * clicking a row in OpenPositionsPanel. Surfaces, in one place: when it was opened
 * + how long held, the entry-vs-market RUN chart, full health (liq distance +
 * alignment vs regime), and the latest ATR insight — where a protective stop should
 * sit given current volatility, and how far liquidation sits beyond it (cushion).
 *
 * Read-only insight surface: the trade actions (Reduce / Close / Adjust leverage)
 * re-use the panel's existing modal seams via callbacks — NO new execution path,
 * no-auto-fire preserved. a11y mirrors the other cockpit dialogs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { css } from '@styled-system/css';
import type { PnlSnapshot, PositionRow } from '@/hooks/realtime-row-mappers';
import { useCandles } from '@/hooks/useCandles';
import type { TradingMode } from '@/types/fill';
import { HOLD_TIMEFRAMES, suggestStopFrac, liquidationCushion, stopPxFromFrac, validateStopPx, type HoldTimeframe } from '@/lib/cockpit/stop-suggestion-business-logic';
import { isOverMargined } from '@/lib/trading/leverage-business-logic';
import { previewAdd, MAX_ADD_MULTIPLE, type AddSizeMode } from '@/lib/trading/add-to-position-business-logic';
import PositionHistoryChart from './left-rail/PositionHistoryChart';
import { positionHealth, uPnlPct, type RegimeDir } from './open-positions-helpers';
import { userPositionDisplay } from './position-panel-helpers';
import { entryLiveConfirmPhrase } from './entry-modal-helpers';
import { GH, ZONE_COLORS, TERM, fmtPx, fmtUsd, fmtCompactUsd } from './panel-styles';

/** A clean, parseable numeric seed for the stop input — 6 sig figs, trailing zeros
 *  stripped, never lossy by a fixed decimal count (works for $63k and $0.49 alike). */
function priceSeed(px: number): string {
  return String(Number(px.toPrecision(6)));
}

/** "held 2d 4h" / "held 3h 12m" from the open timestamp. nowMs injected (no Date in render). */
function heldLabel(openedAtMs: number | null | undefined, nowMs: number): string {
  if (openedAtMs == null) return 'open time unknown';
  const m = Math.max(0, Math.floor((nowMs - openedAtMs) / 60_000));
  if (m < 60) return `held ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `held ${h}h ${m % 60}m`;
  return `held ${Math.floor(h / 24)}d ${h % 24}h`;
}

export interface PositionInsightsModalProps {
  pos: PositionRow;
  pnl: PnlSnapshot | undefined;
  regime: RegimeDir;
  /** Trading mode — drives the LIVE confirm gate on Add-to-position. */
  mode?: TradingMode;
  /** REAL HL liquidation (reflects posted margin); overrides the margin-blind formula. */
  realLiqPx?: number | null;
  /** Effective leverage = notional / margin used (reflects added margin). */
  effLeverage?: number | null;
  /** REAL isolated margin backing the position (HL marginUsed) — makes the add/margin
   *  previews margin-aware (accurate new-liq) instead of the leverage-setting formula. */
  currentMarginUsd?: number | null;
  /** Injected clock (parent ticks it) so "held" updates without a Date() in render. */
  nowMs: number;
  onReduce: () => void;
  onClose: () => void;
  onAdjust: () => void;
  onDismiss: () => void;
}

export default function PositionInsightsModal({
  pos, pnl, regime, mode = 'paper', realLiqPx = null, effLeverage = null, currentMarginUsd = null, nowMs, onReduce, onClose, onAdjust, onDismiss,
}: PositionInsightsModalProps) {
  const d = userPositionDisplay(pos, pnl);
  const side = d.side;
  const sideColor = side === 'long' ? ZONE_COLORS.ok : ZONE_COLORS.danger;

  // Prefer the REAL HL liquidation (reflects posted margin) over the fold's formula.
  const health = positionHealth({ side, entryPx: d.entryPx, markPx: d.markPx, leverage: d.leverage, liqPxOverride: realLiqPx ?? d.liqPx, regime });
  // Drive the health pill off the SAME liq-distance zones as the bar below it
  // (positionHealth.liqColor) so label + bar never disagree on the same number.
  const liqLabel = health.liqDistPct == null ? 'UNKNOWN'
    : health.liqColor === ZONE_COLORS.danger ? 'NEAR LIQ'
    : health.liqColor === ZONE_COLORS.warn ? 'AT RISK' : 'HEALTHY';
  const liqLabelColor = health.liqDistPct == null ? GH.textMuted : health.liqColor;
  const pct = uPnlPct(side, d.entryPx, d.markPx);
  const upnl = d.unrealizedPnlUsd;
  const upnlColor = upnl == null ? GH.text : upnl >= 0 ? ZONE_COLORS.ok : ZONE_COLORS.danger;

  // Protective-stop picker. A hold-timeframe seeds an ATR stop; the operator can
  // WIDEN it (Position TF = wick-resistant) or type any level off the chart. Default
  // 'position' — for a held conviction trade the wide stop is the right protection;
  // the whole point is to NOT get wicked out on a short-term swing.
  const [holdTf, setHoldTf] = useState<HoldTimeframe>('position');
  // Namespace DOM ids by coin so two drill-downs could never collide label↔input.
  const stopInputId = `insights-stop-input-${pos.coin}`;
  const stopInvalidId = `insights-stop-invalid-${pos.coin}`;
  const tfSpec = HOLD_TIMEFRAMES[holdTf];
  const candles = useCandles(pos.coin, tfSpec.interval);
  const suggestedStopFrac = useMemo(
    () => suggestStopFrac(candles.candles, tfSpec.atrMult, tfSpec.atrPeriod),
    [candles.candles, tfSpec.atrMult, tfSpec.atrPeriod],
  );
  const ref = d.markPx ?? d.entryPx;
  const suggestedStopPx = stopPxFromFrac(side, ref, suggestedStopFrac);

  // Editable trigger price. Seeds from the suggestion; once the operator types, we
  // stop clobbering it (stopTouched idiom). Switching timeframe re-seeds — picking a
  // preset is an explicit "give me this stop." (Mirrors EntryModal.)
  const [stopInput, setStopInput] = useState('');
  // 'touched' must drive render (it shows the "use ATR" reset link), so it's STATE,
  // not a ref. seededRef only gates the one-shot seed inside the effect (not in render).
  const [stopTouched, setStopTouched] = useState(false);
  const seededRef = useRef('');
  const seedKey = `${pos.coin}|${holdTf}`;
  useEffect(() => {
    if (suggestedStopPx != null && seededRef.current !== seedKey && !stopTouched) {
      setStopInput(priceSeed(suggestedStopPx));
      seededRef.current = seedKey;
    }
  }, [suggestedStopPx, seedKey, stopTouched]);
  function pickStopTf(tf: HoldTimeframe): void {
    setStopTouched(false);
    seededRef.current = ''; // force re-seed from the new TF's suggestion
    setStopInput(''); // clear stale value while the new TF's candles load (re-seeds on arrival)
    setHoldTf(tf);
  }
  function resetStopToSuggested(): void {
    if (suggestedStopPx == null) return;
    setStopTouched(false);
    seededRef.current = seedKey;
    setStopInput(priceSeed(suggestedStopPx));
  }

  const parsedStopPx = (() => { const n = parseFloat(stopInput); return Number.isFinite(n) && n > 0 ? n : null; })();
  const effectiveStopPx = parsedStopPx ?? suggestedStopPx;
  const stopValidation = validateStopPx(side, ref, effectiveStopPx);
  const effectiveStopFrac = stopValidation.frac;
  const stopCushion = liquidationCushion(ref, effectiveStopPx, health.liqPx);
  // Dollars lost if this stop hits (from the live mark) — makes "wider = more $ at
  // risk" explicit so a wide default can't quietly imply a bigger-than-expected loss.
  const stopLossUsd = stopValidation.ok && effectiveStopPx != null && ref != null ? pos.sz * Math.abs(ref - effectiveStopPx) : null;
  const notionalUsd = ref != null ? ref * pos.sz : null;
  // Whether the reduce/close/adjust actions can build a target (mirrors the row card).
  const canExit = d.entryPx != null && d.markPx != null;
  const canAdjust = d.entryPx != null;

  // Add-margin (de-risk): post collateral to push liquidation away without changing
  // size. Inline reveal → amount → confirm → POST /api/cockpit/add-margin.
  const [marginOpen, setMarginOpen] = useState(false);
  const [marginAmt, setMarginAmt] = useState('');
  const [marginBusy, setMarginBusy] = useState(false);
  const [marginMsg, setMarginMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const amt = parseFloat(marginAmt);
  const amtValid = Number.isFinite(amt) && amt > 0;
  // Projected effective leverage after the add (notional / (oldMargin + amt)).
  // Projected effective leverage after posting `amt` more margin. Use the REAL current
  // margin (marginUsed) so it reflects margin you've already added; fall back to the
  // leverage-setting estimate (notional / lev) only when there's no live read.
  const projectedLev = amtValid && d.markPx != null
    ? (() => {
        const notional = d.markPx * pos.sz;
        const baseMargin = currentMarginUsd != null && currentMarginUsd > 0
          ? currentMarginUsd
          : d.leverage != null && d.leverage > 0 ? notional / d.leverage : null;
        if (baseMargin == null) return null;
        const m = baseMargin + amt;
        return m > 0 ? Math.max(1, notional / m) : null;
      })()
    : null;

  async function submitAddMargin(): Promise<void> {
    if (!amtValid || marginBusy) return;
    setMarginBusy(true);
    setMarginMsg(null);
    try {
      const res = await fetch('/api/cockpit/add-margin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ coin: pos.coin, amountUsd: amt }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; pushed?: boolean };
      if (!res.ok || json.ok === false) setMarginMsg({ ok: false, text: json.error ?? `Failed (${res.status})` });
      else { setMarginMsg({ ok: true, text: json.pushed ? `Added $${amt} margin — liquidation moves away.` : `Recorded $${amt} (paper).` }); setMarginAmt(''); setMarginOpen(false); closeRef.current?.focus(); }
    } catch {
      setMarginMsg({ ok: false, text: 'Network error — retry.' });
    } finally {
      setMarginBusy(false);
    }
  }

  // Add to position (pyramid): increase SIZE into the same side. Real-money OPEN —
  // full safety preview + averaging-down ack + LIVE confirm + explicit Approve.
  const isLive = mode === 'live';
  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<AddSizeMode>('pct');
  const [addValue, setAddValue] = useState('');
  const [ackDown, setAckDown] = useState(false);
  const [addPhrase, setAddPhrase] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addMsg, setAddMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const addVal = parseFloat(addValue);
  const addPreview = d.entryPx != null && d.markPx != null && Number.isFinite(addVal) && addVal > 0
    ? previewAdd({ side, currentSz: pos.sz, currentEntryPx: d.entryPx, markPx: d.markPx, leverage: d.leverage ?? 1, mode: addMode, value: addVal, maxAddMultiple: MAX_ADD_MULTIPLE, currentMarginUsd: currentMarginUsd ?? undefined })
    : null;
  const requiredAddPhrase = entryLiveConfirmPhrase(side === 'long' ? 'buy' : 'sell', pos.coin);
  const addApproveOk = !addBusy && addPreview != null && addPreview.addSz > 0 && addPreview.warnings.length === 0
    && (!addPreview.isAveragingDown || ackDown)
    && (!isLive || addPhrase.trim().toLowerCase() === requiredAddPhrase);

  async function submitAdd(): Promise<void> {
    if (!addApproveOk || addPreview == null) return;
    setAddBusy(true);
    setAddMsg(null);
    try {
      const res = await fetch('/api/cockpit/add-to-position', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ coin: pos.coin, mode: addMode, value: addVal, ackAveragingDown: ackDown, confirmPhrase: isLive ? addPhrase : undefined }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; requiresAck?: boolean; hasStop?: boolean };
      if (!res.ok || json.ok === false) {
        if (json.requiresAck) setAckDown(false);
        if (json.hasStop) void refetchStop(); // a stop appeared (placed elsewhere) — surface it
        setAddMsg({ ok: false, text: json.error ?? `Failed (${res.status})` });
      } else {
        setAddMsg({ ok: true, text: `Added ${addPreview.addSz} ${pos.coin} — new size ${addPreview.newSz}.` });
        setAddValue(''); setAddOpen(false); setAckDown(false); setAddPhrase('');
        closeRef.current?.focus(); // the reveal collapsed — keep focus in the dialog
      }
    } catch {
      setAddMsg({ ok: false, text: 'Network error — retry.' });
    } finally {
      setAddBusy(false);
    }
  }

  // Resting protective stop on HL (place the ATR suggestion / cancel). Fetched on open.
  const [stop, setStop] = useState<{ oid: number; triggerPx: number | null; sz: number } | null>(null);
  const [stopBusy, setStopBusy] = useState(false);
  const [stopMsg, setStopMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Status of the resting-stop lookup: until it loads we must NOT offer "Place stop"
  // (we can't know one isn't already resting on HL — a real-money inconsistency).
  const [stopState, setStopState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const refetchStop = useCallback(async () => {
    try {
      const res = await fetch(`/api/cockpit/position-stop?coin=${encodeURIComponent(pos.coin)}`, { credentials: 'same-origin' });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; stop?: { oid: number; triggerPx: number | null; sz: number } | null };
      if (json.ok) { setStop(json.stop ?? null); setStopState('loaded'); }
      else setStopState('error');
    } catch { setStopState('error'); }
  }, [pos.coin]);
  useEffect(() => {
    let active = true;
    const run = () => { if (active) void refetchStop(); };
    run();
    return () => { active = false; };
  }, [refetchStop]);

  async function placeStop(): Promise<void> {
    // Place the EFFECTIVE stop (operator's custom price, or the seeded ATR suggestion).
    // Guard on the same validation the server enforces so we never fire a 422.
    if (effectiveStopPx == null || !stopValidation.ok || stopBusy) return;
    // Send the raw price — submitStopOrder formats to the coin's HL tick precision.
    // (A blanket 2-decimal round would flip a sub-dollar coin's stop to the wrong side.)
    const triggerPx = effectiveStopPx;
    setStopBusy(true); setStopMsg(null);
    try {
      const res = await fetch('/api/cockpit/position-stop', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'place', coin: pos.coin, triggerPx }) });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; pushed?: boolean };
      if (!res.ok || json.ok === false) setStopMsg({ ok: false, text: json.error ?? `Failed (${res.status})` });
      else { setStopMsg({ ok: true, text: json.pushed ? `Stop placed @ ${fmtPx(triggerPx)}.` : `Stop recorded (paper).` }); await refetchStop(); }
    } catch { setStopMsg({ ok: false, text: 'Network error — retry.' }); } finally { setStopBusy(false); }
  }
  async function cancelStop(): Promise<void> {
    if (stopBusy) return;
    setStopBusy(true); setStopMsg(null);
    try {
      const res = await fetch('/api/cockpit/position-stop', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'cancel', coin: pos.coin }) });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || json.ok === false) setStopMsg({ ok: false, text: json.error ?? `Failed (${res.status})` });
      else { setStopMsg({ ok: true, text: 'Stop canceled.' }); setStop(null); }
    } catch { setStopMsg({ ok: false, text: 'Network error — retry.' }); } finally { setStopBusy(false); }
  }

  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // a11y: focus the close button, inert + hide the background (mirrors EntryModal /
  // TraderDetailDrawer), restore on unmount.
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

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') { e.preventDefault(); onDismiss(); return; }
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
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  return (
    <div
      ref={overlayRef}
      role="presentation"
      onKeyDown={onKeyDown}
      onClick={(e) => { if (e.target === overlayRef.current) onDismiss(); }}
      className={css({ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: { base: 'flex-end', md: 'center' }, justifyContent: 'center', bg: 'rgba(1,4,9,0.72)', padding: { base: '0', md: '16px' }, overflowY: 'auto', animation: 'backdropIn 0.16s ease-out' })}
    >
      <section
        ref={dialogRef}
        data-testid="position-insights-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${pos.coin} position insights`}
        className={css({ width: '100%', maxWidth: { base: '100%', md: '560px' }, maxHeight: { base: '90dvh', md: '92vh' }, overflow: 'hidden', bg: 'github.bgSecondary', border: '1px solid token(colors.github.border)', borderRadius: { base: '14px 14px 0 0', md: '14px' }, padding: 0, display: 'flex', flexDirection: 'column', boxShadow: '0 16px 48px rgba(0,0,0,0.6)', animation: 'popupIn 0.22s cubic-bezier(0.16,1,0.3,1)' })}
      >
        {/* Header — a FIXED (non-scrolling) bar so the ✕ is always reachable; the body
            below scrolls under it (mobile bottom-sheet: you couldn't scroll back up to
            dismiss). flexShrink:0 keeps it from collapsing when the body overflows. */}
        <div className={css({ flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px', bg: 'github.bgSecondary', padding: '16px 18px', borderBottom: '1px solid token(colors.github.borderSubtle)' })}>
          <div className={css({ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 })}>
            <span className={css({ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' })}>
              <span className={css({ fontFamily: 'mono', fontSize: 'md', fontWeight: 'bold', color: 'github.textBright' })}>{pos.coin}-PERP</span>
              <span style={{ color: sideColor, background: `${sideColor}1f` }} className={css({ fontFamily: 'mono', fontSize: '10px', fontWeight: 'bold', letterSpacing: '0.06em', paddingX: '7px', paddingY: '2px', borderRadius: '5px' })}>{side.toUpperCase()}</span>
              <span className={css({ fontFamily: 'mono', fontSize: '11px', color: 'github.textMuted' })}>{pos.sz.toLocaleString('en-US', { maximumFractionDigits: 4 })}{d.leverage != null ? ` · ${d.leverage}×` : ''}{isOverMargined(effLeverage, d.leverage) && effLeverage != null && (<span style={{ color: ZONE_COLORS.ok }}> · {effLeverage.toFixed(1)}× eff</span>)}</span>
            </span>
            <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>{heldLabel(pos.openedAt, nowMs)}{notionalUsd != null ? ` · ≈ ${fmtCompactUsd(notionalUsd)} notional` : ''}</span>
          </div>
          <button
            ref={closeRef}
            type="button"
            data-testid="position-insights-close"
            onClick={onDismiss}
            aria-label="Close position insights"
            className={css({ flexShrink: 0, bg: 'github.bg', border: '1px solid token(colors.github.border)', borderRadius: '6px', color: 'github.text', fontSize: 'sm', fontWeight: 'bold', width: '28px', height: '28px', cursor: 'pointer', _hover: { color: 'github.textBright' } })}
          >✕</button>
        </div>

        {/* Scrolling body — the only scroll region; the header stays fixed above it. */}
        <div className={css({ overflowY: 'auto', overscrollBehavior: 'contain', minHeight: 0, display: 'flex', flexDirection: 'column', gap: '14px', padding: '14px 18px 18px' })}>
        {/* The run: entry line vs candles since open. */}
        <PositionHistoryChart coin={pos.coin} side={side} entryPx={d.entryPx} liquidationPx={health.liqPx} openedAtMs={pos.openedAt ?? null} />

        {/* uPnL / entry / mark */}
        <div className={css({ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px 14px' })}>
          <Stat label="Entry" value={fmtPx(d.entryPx)} />
          <Stat label="Mark" value={fmtPx(d.markPx)} />
          <Stat label="uPnL" value={`${upnl == null ? '—' : fmtUsd(upnl)}${pct == null ? '' : ` (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`}`} color={upnlColor} />
        </div>

        {/* Health */}
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '8px', bg: 'github.bg', border: '1px solid token(colors.github.borderSubtle)', borderRadius: '8px', padding: '11px 13px' })}>
          <div className={css({ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' })}>
            <span style={{ color: liqLabelColor, borderColor: liqLabelColor }} className={css({ fontFamily: 'label', fontSize: '10px', fontWeight: 'bold', letterSpacing: '0.06em', border: '1px solid', borderRadius: '4px', paddingX: '6px', paddingY: '1px' })}>{liqLabel}</span>
            <span data-testid="insights-alignment" style={{ color: health.alignColor, background: `${health.alignColor}1f` }} className={css({ fontFamily: 'mono', fontSize: '10px', fontWeight: 'semibold', letterSpacing: '0.06em', paddingX: '7px', paddingY: '2px', borderRadius: '5px' })}>{health.alignLabel}</span>
            <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>vs {pos.coin} regime</span>
          </div>
          <div className={css({ display: 'flex', justifyContent: 'space-between', fontFamily: 'mono', fontSize: '10px' })}>
            <span className={css({ color: 'github.textMuted' })}>liq {fmtPx(health.liqPx)}</span>
            <span style={{ color: health.liqColor }}>{health.liqDistPct == null ? '—' : `${health.liqDistPct.toFixed(1)}%`} away</span>
          </div>
          <div className={css({ height: '4px', bg: '#1b2230', borderRadius: '3px', overflow: 'hidden' })}>
            <div style={{ width: health.liqBarWidth, height: '100%', background: health.liqColor }} />
          </div>
        </div>

        {/* Protective stop — ADJUSTABLE: pick a hold-timeframe preset (Position = wide,
            wick-resistant) or type any level off the chart. Server re-validates side +
            distance; a wider stop survives short-term swings instead of force-closing. */}
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '7px', bg: 'github.bg', border: '1px solid token(colors.github.borderSubtle)', borderRadius: '8px', padding: '11px 13px' })}>
          <span className={css({ fontFamily: 'label', fontSize: '9px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.06em' })}>Protective stop {stop ? '· resting' : '· not placed'}</span>

          {stopState === 'loading' ? (
            <span className={css({ fontFamily: 'mono', fontSize: '9px', color: 'github.textMuted' })}>checking for a resting stop…</span>
          ) : stopState === 'error' ? (
            <span className={css({ fontFamily: 'mono', fontSize: '9px' })} style={{ color: ZONE_COLORS.warn }}>couldn&apos;t verify resting stops — <button type="button" onClick={() => void refetchStop()} className={css({ color: 'github.link', bg: 'transparent', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' })}>retry</button></span>
          ) : stop ? (
            // A stop already rests — one stop per coin; cancel to re-place wider/tighter.
            <div className={css({ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' })}>
              <span data-testid="insights-stop-placed" className={css({ fontFamily: 'mono', fontSize: '11px' })} style={{ color: ZONE_COLORS.ok }}>✓ resting @ {fmtPx(stop.triggerPx)} (size {stop.sz})</span>
              <button type="button" data-testid="insights-stop-cancel" disabled={stopBusy} onClick={() => void cancelStop()} className={css({ fontFamily: 'mono', fontSize: '10px', color: 'zone.danger', bg: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 2px', textDecoration: 'underline', _disabled: { opacity: 0.5 }, _focusVisible: { outline: '2px solid token(colors.github.link)' } })}>{stopBusy ? '…' : 'cancel / re-place'}</button>
            </div>
          ) : (
            <>
              {/* Timeframe presets — seed the ATR stop. Wider = harder to wick out. */}
              <div role="group" aria-label="Stop timeframe" className={css({ display: 'flex', gap: '4px', borderRadius: '8px', padding: '3px' })} style={{ background: TERM.inset, border: '1px solid rgba(255,255,255,.08)' }}>
                {(Object.keys(HOLD_TIMEFRAMES) as HoldTimeframe[]).map((tf) => {
                  const active = tf === holdTf;
                  return (
                    <button key={tf} type="button" data-testid={`insights-stop-tf-${tf}`} data-active={active} aria-pressed={active} onClick={() => pickStopTf(tf)} title={HOLD_TIMEFRAMES[tf].hint} style={{ background: active ? '#1c2536' : 'transparent', color: active ? '#e8ebf2' : '#8b95a6' }} className={css({ flex: 1, fontFamily: 'mono', fontSize: '11px', fontWeight: 'semibold', paddingY: '6px', borderRadius: '6px', border: 'none', cursor: 'pointer', _focusVisible: { outline: '2px solid token(colors.github.link)' } })}>{HOLD_TIMEFRAMES[tf].label}</button>
                  );
                })}
              </div>
              <span className={css({ fontFamily: 'mono', fontSize: '9px', color: 'github.textMuted' })}>
                {tfSpec.hint} · {suggestedStopPx != null ? `ATR(${tfSpec.interval}) ≈ ${fmtPx(suggestedStopPx)}` : candles.loading ? 'measuring volatility…' : `ATR(${tfSpec.interval}) unavailable — type a level`}
              </span>

              {/* Editable trigger price + live distance. */}
              <div className={css({ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' })}>
                <label htmlFor={stopInputId} className={css({ fontFamily: 'label', fontSize: '9px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.05em' })}>Trigger</label>
                <input
                  id={stopInputId}
                  data-testid="insights-stop-input"
                  inputMode="decimal"
                  value={stopInput}
                  onChange={(e) => { setStopTouched(true); setStopInput(e.target.value); }}
                  placeholder={suggestedStopPx != null ? priceSeed(suggestedStopPx) : '—'}
                  className={css({ fontFamily: 'mono', fontSize: '12px', color: 'github.text', bg: 'github.bgSecondary', border: '1px solid token(colors.github.border)', borderRadius: '6px', paddingX: '8px', paddingY: '7px', width: '96px', _focusVisible: { outline: '2px solid token(colors.github.link)' } })}
                  style={{ fontFeatureSettings: '"tnum"' }}
                />
                {effectiveStopFrac != null && (
                  <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>
                    {(effectiveStopFrac * 100).toFixed(1)}% from mark{stopLossUsd != null ? ` · ${fmtUsd(stopLossUsd)} at risk` : ''}
                  </span>
                )}
                {stopTouched && suggestedStopPx != null && (
                  <button type="button" onClick={resetStopToSuggested} className={css({ fontFamily: 'mono', fontSize: '9px', color: 'github.link', bg: 'transparent', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' })}>use ATR</button>
                )}
              </div>

              {/* Cushion to liquidation OR the validation reason (mirrors server guards).
                  A VALID-but-thin cushion is prefixed "⚠ thin" so its red can't be
                  mistaken for the invalid-stop red (they're mutually exclusive here). */}
              {!stopValidation.ok ? (
                <span id={stopInvalidId} data-testid="insights-stop-invalid" className={css({ fontFamily: 'mono', fontSize: '10px' })} style={{ color: ZONE_COLORS.danger }}>{stopValidation.reason}</span>
              ) : stopCushion != null ? (
                <span data-testid="insights-stop-cushion" style={{ color: stopCushion < 1.5 ? ZONE_COLORS.danger : stopCushion < 2.5 ? ZONE_COLORS.warn : ZONE_COLORS.ok }} className={css({ fontFamily: 'mono', fontSize: '10px' })}>
                  {stopCushion < 1.5 ? '⚠ thin — ' : ''}liquidation sits {stopCushion.toFixed(1)}× beyond this stop
                </span>
              ) : null}

              <button type="button" data-testid="insights-stop-place" disabled={stopBusy || !stopValidation.ok} onClick={() => void placeStop()} aria-describedby={!stopValidation.ok ? stopInvalidId : undefined} title="Places a REAL reduce-only stop order that rests on Hyperliquid" className={css({ alignSelf: 'flex-start', fontFamily: 'sans', fontSize: '10px', fontWeight: 'bold', color: '#06251a', bg: 'zone.ok', border: 'none', borderRadius: '5px', paddingX: '10px', paddingY: '6px', cursor: 'pointer', marginTop: '1px', _disabled: { opacity: 0.45, cursor: 'not-allowed' }, _focusVisible: { outline: '2px solid token(colors.github.link)', outlineOffset: '2px' } })}>{stopBusy ? 'placing…' : effectiveStopPx != null && stopValidation.ok ? `Place stop @ ${fmtPx(effectiveStopPx)} →` : 'Place stop'}</button>
            </>
          )}
          {stopMsg && <span role="status" style={{ color: stopMsg.ok ? ZONE_COLORS.ok : ZONE_COLORS.danger }} className={css({ fontFamily: 'mono', fontSize: '9px', lineHeight: 1.4 })}>{stopMsg.text}</span>}
        </div>

        {/* Add margin — the correct, non-martingale de-risk: post collateral → liq
            moves away, size unchanged. (Lowering leverage hits HL's margin restriction;
            this posts margin directly.) */}
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '7px', bg: 'github.bg', border: '1px solid token(colors.github.borderSubtle)', borderRadius: '8px', padding: '11px 13px' })}>
          <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' })}>
            <span className={css({ fontFamily: 'label', fontSize: '9px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.06em' })}>Add margin · de-risk (liq moves away, size unchanged)</span>
            {!marginOpen && (
              <button type="button" data-testid="insights-add-margin-open" onClick={() => { setMarginOpen(true); setMarginMsg(null); }} className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.link', bg: 'transparent', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline', _focusVisible: { outline: '2px solid token(colors.github.link)' } })}>+ add</button>
            )}
          </div>
          {marginOpen && (
            <div className={css({ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' })}>
              <span className={css({ fontFamily: 'mono', fontSize: '12px', color: 'github.textMuted' })}>$</span>
              <input
                type="number"
                inputMode="decimal"
                data-testid="insights-add-margin-amount" aria-label="Margin amount (USD)"
                value={marginAmt}
                onChange={(e) => setMarginAmt(e.target.value)}
                placeholder="amount"
                min={1}
                className={css({ width: '90px', bg: 'github.bgSecondary', border: '1px solid token(colors.github.border)', borderRadius: '6px', color: 'github.textBright', fontFamily: 'mono', fontSize: '13px', padding: '6px 8px', outline: 'none', _focusVisible: { borderColor: 'github.link' } })}
              />
              {projectedLev != null && <span className={css({ fontFamily: 'mono', fontSize: '9px', color: 'github.textMuted' })}>→ ≈ {projectedLev.toFixed(1)}× eff lev</span>}
              <button type="button" data-testid="insights-add-margin-submit" disabled={!amtValid || marginBusy} onClick={() => void submitAddMargin()} className={css({ fontFamily: 'sans', fontSize: '11px', fontWeight: 'semibold', color: 'github.bg', bg: 'github.link', border: 'none', borderRadius: '6px', paddingX: '12px', paddingY: '6px', cursor: 'pointer', _disabled: { opacity: 0.5, cursor: 'not-allowed' }, _focusVisible: { outline: '2px solid token(colors.github.link)', outlineOffset: '2px' } })}>{marginBusy ? 'adding…' : 'Add margin'}</button>
              <button type="button" data-testid="insights-add-margin-cancel" onClick={() => { setMarginOpen(false); setMarginAmt(''); closeRef.current?.focus(); }} className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted', bg: 'transparent', border: 'none', cursor: 'pointer', padding: '6px' })}>cancel</button>
            </div>
          )}
          {marginMsg && (
            <span role="status" style={{ color: marginMsg.ok ? ZONE_COLORS.ok : ZONE_COLORS.danger }} className={css({ fontFamily: 'mono', fontSize: '9.5px', lineHeight: 1.4 })}>{marginMsg.text}</span>
          )}
        </div>

        {/* Add to position — increases SIZE (pyramid). Real-money OPEN with the full
            safety preview: new size/avg/liq, $-at-risk growth, averaging-down gate. */}
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '8px', bg: 'github.bg', border: '1px solid token(colors.github.borderSubtle)', borderRadius: '8px', padding: '11px 13px' })}>
          <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' })}>
            <span className={css({ fontFamily: 'label', fontSize: '9px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.06em' })}>Add to position · pyramid (increases size + risk)</span>
            {!addOpen && (
              <button type="button" data-testid="insights-add-pos-open" onClick={() => { setAddOpen(true); setAddMsg(null); }} className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.link', bg: 'transparent', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline', _focusVisible: { outline: '2px solid token(colors.github.link)' } })}>+ add</button>
            )}
          </div>
          {addOpen && (
            <>
              {stop && (
                <span data-testid="insights-add-blocked-stop" className={css({ fontFamily: 'mono', fontSize: '9.5px', lineHeight: 1.45, borderRadius: '6px', padding: '8px 10px' })} style={{ background: 'rgba(242,77,94,0.08)', border: '1px solid rgba(242,77,94,0.3)', color: '#ff9aa6' }}>
                  ⚠ A stop is resting @ {fmtPx(stop.triggerPx)} (covers {stop.sz}). Cancel it above before adding — then re-place it at the new average entry.
                </span>
              )}
              <div className={css({ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' })}>
                <div role="group" aria-label="Add size mode" className={css({ display: 'flex', gap: '2px', bg: 'github.bgSecondary', border: '1px solid token(colors.github.border)', borderRadius: '6px', padding: '2px' })}>
                  {(['pct', 'usd'] as AddSizeMode[]).map((m) => (
                    <button key={m} type="button" data-testid={`insights-add-mode-${m}`} aria-pressed={addMode === m} onClick={() => setAddMode(m)} style={{ background: addMode === m ? '#1c2536' : 'transparent', color: addMode === m ? '#e8ebf2' : '#8b95a6' }} className={css({ fontFamily: 'mono', fontSize: '10px', fontWeight: 'semibold', paddingX: '8px', paddingY: '4px', borderRadius: '4px', border: 'none', cursor: 'pointer' })}>{m === 'pct' ? '% of size' : '$ notional'}</button>
                  ))}
                </div>
                <input type="number" inputMode="decimal" data-testid="insights-add-value" aria-label="Add size" value={addValue} onChange={(e) => setAddValue(e.target.value)} placeholder={addMode === 'pct' ? '%' : '$'} min={0} className={css({ width: '80px', bg: 'github.bgSecondary', border: '1px solid token(colors.github.border)', borderRadius: '6px', color: 'github.textBright', fontFamily: 'mono', fontSize: '13px', padding: '6px 8px', outline: 'none', _focusVisible: { borderColor: 'github.link' } })} />
                {addMode === 'pct' && [25, 50, 100].map((p) => (
                  <button key={p} type="button" onClick={() => setAddValue(String(p))} className={css({ fontFamily: 'mono', fontSize: '9px', color: 'github.textMuted', bg: 'transparent', border: '1px solid token(colors.github.borderSubtle)', borderRadius: '4px', paddingX: '5px', paddingY: '3px', cursor: 'pointer', _hover: { borderColor: 'github.link' } })}>{p}%</button>
                ))}
              </div>

              {addPreview && addPreview.addSz > 0 && (
                <div className={css({ display: 'flex', flexDirection: 'column', gap: '3px', fontFamily: 'mono', fontSize: '10px', color: 'github.text', bg: 'github.bgSecondary', borderRadius: '6px', padding: '8px 10px' })} style={{ fontFeatureSettings: '"tnum"' }}>
                  <div className={css({ display: 'flex', justifyContent: 'space-between' })}><span className={css({ color: 'github.textMuted' })}>add</span><span>+{addPreview.addSz} {pos.coin} · ≈{fmtCompactUsd(addPreview.addNotionalUsd)} · margin {fmtCompactUsd(addPreview.addMarginUsd)}</span></div>
                  <div className={css({ display: 'flex', justifyContent: 'space-between' })}><span className={css({ color: 'github.textMuted' })}>size → / avg →</span><span>{pos.sz} → <strong>{addPreview.newSz}</strong> · avg {fmtPx(addPreview.newAvgEntryPx)}</span></div>
                  <div className={css({ display: 'flex', justifyContent: 'space-between' })}><span className={css({ color: 'github.textMuted' })}>new liq</span><span>{fmtPx(addPreview.newLiqPx)} {addPreview.newLiqDistPct != null ? `(${addPreview.newLiqDistPct.toFixed(1)}% away)` : ''} · {addPreview.newEffLeverage.toFixed(1)}× eff</span></div>
                  <div className={css({ display: 'flex', justifyContent: 'space-between' })}><span className={css({ color: 'github.textMuted' })}>$ at risk (at liq)</span><span style={{ color: ZONE_COLORS.warn }}>{fmtCompactUsd(addPreview.riskAtLiqUsd)}{currentMarginUsd != null && currentMarginUsd > 0 ? ` (was ${fmtCompactUsd(currentMarginUsd)})` : ''}</span></div>
                </div>
              )}

              {addPreview?.isAveragingDown && (
                <label data-testid="insights-add-avgdown-ack" className={css({ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '9px 11px', borderRadius: '7px', cursor: 'pointer' })} style={{ background: 'rgba(242,77,94,0.08)', border: '1px solid rgba(242,77,94,0.32)' }}>
                  <input type="checkbox" checked={ackDown} onChange={(e) => setAckDown(e.target.checked)} className={css({ marginTop: '2px', accentColor: '#f24d5e', cursor: 'pointer' })} />
                  <span style={{ color: ZONE_COLORS.danger }} className={css({ fontFamily: 'mono', fontSize: '9.5px', lineHeight: 1.45 })}>⚠ This adds to a <strong>LOSING</strong> position (averaging down) — the martingale pattern that blows up accounts. I understand and want to proceed.</span>
                </label>
              )}

              {isLive && (
                <label className={css({ display: 'flex', flexDirection: 'column', gap: '4px' })}>
                  <span className={css({ fontFamily: 'mono', fontSize: '9px', color: 'zone.danger' })}>LIVE — type <code style={{ color: GH.textBright }}>{requiredAddPhrase}</code> to enable</span>
                  <input data-testid="insights-add-phrase" value={addPhrase} onChange={(e) => setAddPhrase(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={requiredAddPhrase} className={css({ bg: 'github.bgSecondary', border: '1px solid token(colors.github.border)', borderRadius: '6px', color: 'github.textBright', fontFamily: 'mono', fontSize: '12px', padding: '6px 8px', outline: 'none' })} />
                </label>
              )}

              <div className={css({ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' })}>
                <button type="button" data-testid="insights-add-submit" disabled={!addApproveOk || stop != null} onClick={() => void submitAdd()} style={{ background: addApproveOk && !stop ? (isLive ? ZONE_COLORS.danger : ZONE_COLORS.ok) : undefined }} className={css({ fontFamily: 'sans', fontSize: '11px', fontWeight: 'bold', color: addApproveOk && !stop ? '#06251a' : 'github.textMuted', bg: addApproveOk && !stop ? undefined : 'github.bgSecondary', border: 'none', borderRadius: '6px', paddingX: '14px', paddingY: '7px', cursor: addApproveOk && !stop ? 'pointer' : 'not-allowed', _disabled: { opacity: 0.6, cursor: 'not-allowed' } })}>{addBusy ? 'adding…' : isLive ? 'Approve LIVE add' : `Add ${addPreview?.addSz ?? ''} ${pos.coin}`}</button>
                <button type="button" data-testid="insights-add-cancel" onClick={() => { setAddOpen(false); setAddValue(''); setAckDown(false); closeRef.current?.focus(); }} className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted', bg: 'transparent', border: 'none', cursor: 'pointer', padding: '6px' })}>cancel</button>
                {stop && <span className={css({ fontFamily: 'mono', fontSize: '9px', color: 'zone.danger' })}>cancel the resting stop first ↑</span>}
              </div>
            </>
          )}
          {addMsg && (
            <span role="status" style={{ color: addMsg.ok ? ZONE_COLORS.ok : ZONE_COLORS.danger }} className={css({ fontFamily: 'mono', fontSize: '9.5px', lineHeight: 1.4 })}>{addMsg.text}</span>
          )}
        </div>

        {/* Actions — reuse the panel's existing reduce-only / leverage seams. */}
        <div className={css({ display: 'flex', gap: '8px', flexWrap: 'wrap' })}>
          <button type="button" data-testid="insights-adjust" disabled={!canAdjust} onClick={onAdjust} className={css({ fontFamily: 'sans', fontSize: '12px', fontWeight: 'medium', color: 'cockpit.accent', bg: 'cockpit.button', border: '1px solid', borderColor: 'rgba(91,140,255,0.32)', borderRadius: '7px', paddingX: '14px', paddingY: '9px', cursor: 'pointer', _disabled: { opacity: 0.5, cursor: 'not-allowed' } })}>
            {d.leverage != null ? `${d.leverage}× lev` : 'Set lev'}
          </button>
          <button type="button" data-testid="insights-reduce" disabled={!canExit} onClick={onReduce} className={css({ fontFamily: 'sans', fontSize: '12px', fontWeight: 'medium', color: 'github.text', bg: 'cockpit.button', border: '1px solid token(colors.github.border)', borderRadius: '7px', paddingX: '14px', paddingY: '9px', cursor: 'pointer', _disabled: { opacity: 0.5, cursor: 'not-allowed' } })}>Reduce</button>
          <button type="button" data-testid="insights-close-position" disabled={!canExit} onClick={onClose} style={{ color: ZONE_COLORS.danger, background: 'rgba(242,77,94,0.08)', borderColor: 'rgba(242,77,94,0.32)' }} className={css({ fontFamily: 'sans', fontSize: '12px', fontWeight: 'semibold', border: '1px solid', borderRadius: '7px', paddingX: '16px', paddingY: '9px', cursor: 'pointer', _disabled: { opacity: 0.5, cursor: 'not-allowed' } })}>Close</button>
        </div>
        <span className={css({ fontFamily: 'mono', fontSize: '8px', color: 'github.textMuted' })} style={{ color: TERM.faint }}>Insights are read-only; Reduce/Close still run through the approved reduce-only seam.</span>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span className={css({ display: 'flex', flexDirection: 'column', gap: '1px' })}>
      <span className={css({ fontFamily: 'label', fontSize: '8px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.05em' })}>{label}</span>
      <span style={{ color: color ?? GH.textBright, fontFeatureSettings: '"tnum"' }} className={css({ fontFamily: 'mono', fontSize: '13px', fontWeight: 'bold' })}>{value}</span>
    </span>
  );
}
