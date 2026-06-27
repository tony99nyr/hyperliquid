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
import PositionHistoryChart from './left-rail/PositionHistoryChart';
import PositionAdjustActions from './PositionAdjustActions';
import { positionHealth, uPnlPct, type RegimeDir } from './open-positions-helpers';
import { userPositionDisplay } from './position-panel-helpers';
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
  const tpInputId = `insights-tp-input-${pos.coin}`;
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

  // Take-profit (the profit-side sibling of the stop). Suggest a 2R target off the
  // chosen stop (entry ∓ 2×stop-distance, on the profit side); the operator can type
  // any target. Seeds once from the suggestion (tpTouched idiom); profit-side validated.
  const [tpInput, setTpInput] = useState('');
  const [tpTouched, setTpTouched] = useState(false);
  const suggestedTpPx = effectiveStopPx != null && d.entryPx != null && stopValidation.ok
    ? (() => { const r = Math.abs(d.entryPx - effectiveStopPx); return side === 'long' ? d.entryPx + 2 * r : d.entryPx - 2 * r; })()
    : null;
  // No seeding effect — the suggestion is the input PLACEHOLDER and the fallback
  // (effectiveTpPx below), so an empty field already means "use the 2R target".
  const parsedTpPx = (() => { const n = parseFloat(tpInput); return Number.isFinite(n) && n > 0 ? n : null; })();
  const effectiveTpPx = parsedTpPx ?? suggestedTpPx;
  const tpDistFrac = effectiveTpPx != null && ref != null && ref > 0 ? Math.abs(ref - effectiveTpPx) / ref : null;
  // A long's TP sits ABOVE the mark, a short's BELOW (profit side) — mirrors the route.
  const tpValid = effectiveTpPx != null && ref != null
    && (side === 'long' ? effectiveTpPx > ref : effectiveTpPx < ref)
    && tpDistFrac != null && tpDistFrac >= 0.005 && tpDistFrac <= 0.5;
  const tpProfitUsd = tpValid && effectiveTpPx != null && ref != null ? pos.sz * Math.abs(effectiveTpPx - ref) : null;

  const notionalUsd = ref != null ? ref * pos.sz : null;
  // Whether the reduce/close/adjust actions can build a target (mirrors the row card).
  const canExit = d.entryPx != null && d.markPx != null;
  const canAdjust = d.entryPx != null;


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

  // Resting take-profit on HL (mirrors the stop's fetch/place/cancel).
  const [tp, setTp] = useState<{ oid: number; triggerPx: number | null; sz: number } | null>(null);
  const [tpBusy, setTpBusy] = useState(false);
  const [tpMsg, setTpMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tpStateStatus, setTpStateStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const refetchTp = useCallback(async () => {
    try {
      const res = await fetch(`/api/cockpit/position-tp?coin=${encodeURIComponent(pos.coin)}`, { credentials: 'same-origin' });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; tp?: { oid: number; triggerPx: number | null; sz: number } | null };
      if (json.ok) { setTp(json.tp ?? null); setTpStateStatus('loaded'); }
      else setTpStateStatus('error');
    } catch { setTpStateStatus('error'); }
  }, [pos.coin]);
  useEffect(() => {
    let active = true;
    const run = () => { if (active) void refetchTp(); };
    run();
    return () => { active = false; };
  }, [refetchTp]);

  async function placeTp(): Promise<void> {
    if (effectiveTpPx == null || !tpValid || tpBusy) return;
    const triggerPx = effectiveTpPx;
    setTpBusy(true); setTpMsg(null);
    try {
      const res = await fetch('/api/cockpit/position-tp', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'place', coin: pos.coin, triggerPx }) });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; pushed?: boolean };
      if (!res.ok || json.ok === false) setTpMsg({ ok: false, text: json.error ?? `Failed (${res.status})` });
      else { setTpMsg({ ok: true, text: json.pushed ? `Take-profit placed @ ${fmtPx(triggerPx)}.` : `TP recorded (paper).` }); await refetchTp(); }
    } catch { setTpMsg({ ok: false, text: 'Network error — retry.' }); } finally { setTpBusy(false); }
  }
  async function cancelTp(): Promise<void> {
    if (tpBusy) return;
    setTpBusy(true); setTpMsg(null);
    try {
      const res = await fetch('/api/cockpit/position-tp', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'cancel', coin: pos.coin }) });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || json.ok === false) setTpMsg({ ok: false, text: json.error ?? `Failed (${res.status})` });
      else { setTpMsg({ ok: true, text: 'Take-profit canceled.' }); setTp(null); }
    } catch { setTpMsg({ ok: false, text: 'Network error — retry.' }); } finally { setTpBusy(false); }
  }

  // Native OCO bracket: place the chosen stop AND target as one mutually-cancelling
  // unit (HL positionTpsl). Available only when both are valid and neither rests yet.
  const [bracketBusy, setBracketBusy] = useState(false);
  const [bracketMsg, setBracketMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const bracketReady = stopState === 'loaded' && tpStateStatus === 'loaded' && !stop && !tp
    && stopValidation.ok && effectiveStopPx != null && tpValid && effectiveTpPx != null;
  async function placeBracket(): Promise<void> {
    if (!bracketReady || effectiveStopPx == null || effectiveTpPx == null || bracketBusy) return;
    setBracketBusy(true); setBracketMsg(null);
    try {
      const res = await fetch('/api/cockpit/position-bracket', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ coin: pos.coin, stopPx: effectiveStopPx, tpPx: effectiveTpPx }) });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; pushed?: boolean };
      if (!res.ok || json.ok === false) setBracketMsg({ ok: false, text: json.error ?? `Failed (${res.status})` });
      else { setBracketMsg({ ok: true, text: json.pushed ? `Bracket placed — stop ${fmtPx(effectiveStopPx)} / target ${fmtPx(effectiveTpPx)} (OCO).` : 'Bracket recorded (paper).' }); await refetchStop(); await refetchTp(); }
    } catch { setBracketMsg({ ok: false, text: 'Network error — retry.' }); } finally { setBracketBusy(false); }
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

        {/* Take-profit — a resting reduce-only target on HL (the profit-side sibling of
            the stop). Suggested at 2R off the stop; the operator can type any target. */}
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '7px', bg: 'github.bg', border: '1px solid token(colors.github.borderSubtle)', borderRadius: '8px', padding: '11px 13px' })}>
          <span className={css({ fontFamily: 'label', fontSize: '9px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.06em' })}>Take-profit {tp ? '· resting' : '· not placed'}</span>

          {tpStateStatus === 'loading' ? (
            <span className={css({ fontFamily: 'mono', fontSize: '9px', color: 'github.textMuted' })}>checking for a resting target…</span>
          ) : tpStateStatus === 'error' ? (
            <span className={css({ fontFamily: 'mono', fontSize: '9px' })} style={{ color: ZONE_COLORS.warn }}>couldn&apos;t verify resting targets — <button type="button" onClick={() => void refetchTp()} className={css({ color: 'github.link', bg: 'transparent', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' })}>retry</button></span>
          ) : tp ? (
            <div className={css({ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' })}>
              <span data-testid="insights-tp-placed" className={css({ fontFamily: 'mono', fontSize: '11px' })} style={{ color: ZONE_COLORS.ok }}>✓ target @ {fmtPx(tp.triggerPx)} (size {tp.sz})</span>
              <button type="button" data-testid="insights-tp-cancel" disabled={tpBusy} onClick={() => void cancelTp()} className={css({ fontFamily: 'mono', fontSize: '10px', color: 'zone.danger', bg: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 2px', textDecoration: 'underline', _disabled: { opacity: 0.5 }, _focusVisible: { outline: '2px solid token(colors.github.link)' } })}>{tpBusy ? '…' : 'cancel / re-place'}</button>
            </div>
          ) : (
            <>
              <div className={css({ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' })}>
                <label htmlFor={tpInputId} className={css({ fontFamily: 'label', fontSize: '9px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.05em' })}>Target</label>
                <input
                  id={tpInputId}
                  data-testid="insights-tp-input"
                  inputMode="decimal"
                  value={tpInput}
                  onChange={(e) => { setTpTouched(true); setTpInput(e.target.value); }}
                  placeholder={suggestedTpPx != null && suggestedTpPx > 0 ? priceSeed(suggestedTpPx) : '—'}
                  className={css({ fontFamily: 'mono', fontSize: '12px', color: 'github.text', bg: 'github.bgSecondary', border: '1px solid token(colors.github.border)', borderRadius: '6px', paddingX: '8px', paddingY: '7px', width: '96px', _focusVisible: { outline: '2px solid token(colors.github.link)' } })}
                  style={{ fontFeatureSettings: '"tnum"' }}
                />
                {tpDistFrac != null && (
                  <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>
                    {(tpDistFrac * 100).toFixed(1)}% from mark{tpProfitUsd != null ? ` · +${fmtUsd(tpProfitUsd)} profit` : ''}
                  </span>
                )}
                {suggestedTpPx != null && suggestedTpPx > 0 && tpTouched && (
                  <button type="button" onClick={() => { setTpTouched(false); setTpInput(''); }} className={css({ fontFamily: 'mono', fontSize: '9px', color: 'github.link', bg: 'transparent', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' })}>use 2R</button>
                )}
              </div>
              {!tpValid && tpInput !== '' && (
                <span data-testid="insights-tp-invalid" className={css({ fontFamily: 'mono', fontSize: '10px' })} style={{ color: ZONE_COLORS.danger }}>
                  Target must be {side === 'long' ? 'above' : 'below'} the mark (profit side), 0.5–50% away.
                </span>
              )}
              <button type="button" data-testid="insights-tp-place" disabled={tpBusy || !tpValid} onClick={() => void placeTp()} title="Places a REAL reduce-only take-profit order that rests on Hyperliquid" className={css({ alignSelf: 'flex-start', fontFamily: 'sans', fontSize: '10px', fontWeight: 'bold', color: '#06251a', bg: 'zone.ok', border: 'none', borderRadius: '5px', paddingX: '10px', paddingY: '6px', cursor: 'pointer', marginTop: '1px', _disabled: { opacity: 0.45, cursor: 'not-allowed' }, _focusVisible: { outline: '2px solid token(colors.github.link)', outlineOffset: '2px' } })}>{tpBusy ? 'placing…' : effectiveTpPx != null && tpValid ? `Place target @ ${fmtPx(effectiveTpPx)} →` : 'Place target'}</button>
            </>
          )}
          {tpMsg && <span role="status" style={{ color: tpMsg.ok ? ZONE_COLORS.ok : ZONE_COLORS.danger }} className={css({ fontFamily: 'mono', fontSize: '9px', lineHeight: 1.4 })}>{tpMsg.text}</span>}
        </div>

        {/* OCO bracket — the RECOMMENDED protective path: place the stop + target as ONE
            mutually-cancelling unit (HL positionTpsl) so hitting one cancels the other +
            both auto-cancel when the position closes (no orphan). ALWAYS mounted (no
            keystroke flicker / focus loss / lost success message); the button enables
            only when both legs are valid and neither already rests. The single-leg
            buttons above are the escape hatch. */}
        {stopState === 'loaded' && tpStateStatus === 'loaded' && (
          <div className={css({ display: 'flex', flexDirection: 'column', gap: '6px', bg: 'github.bg', border: '1px solid', borderColor: 'rgba(91,140,255,0.28)', borderRadius: '8px', padding: '10px 13px' })}>
            <span className={css({ fontFamily: 'label', fontSize: '9px', color: 'cockpit.accent', textTransform: 'uppercase', letterSpacing: '0.06em' })}>Protective bracket · recommended</span>
            <span className={css({ fontFamily: 'mono', fontSize: '9.5px', color: 'github.textMuted', lineHeight: 1.45 })}>
              {bracketReady
                ? <>⛓ Place stop {fmtPx(effectiveStopPx)} + target {fmtPx(effectiveTpPx)} as one <strong>OCO unit</strong> — hitting one cancels the other; both auto-cancel when the position closes. (The single-leg buttons above place just that leg.)</>
                : (stop || tp) ? 'Cancel the resting order above to place a fresh OCO bracket (stop + target together).'
                : 'Set a valid stop and target above, then place them together here as one mutually-cancelling OCO bracket.'}
            </span>
            <button type="button" data-testid="insights-bracket-place" disabled={bracketBusy || !bracketReady} onClick={() => void placeBracket()} className={css({ alignSelf: 'flex-start', fontFamily: 'sans', fontSize: '10px', fontWeight: 'bold', color: '#cfe0ff', bg: 'rgba(91,140,255,0.16)', border: '1px solid', borderColor: 'rgba(91,140,255,0.45)', borderRadius: '5px', paddingX: '10px', paddingY: '6px', cursor: 'pointer', _disabled: { opacity: 0.45, cursor: 'not-allowed' }, _focusVisible: { outline: '2px solid token(colors.github.link)', outlineOffset: '2px' } })}>{bracketBusy ? 'placing…' : 'Place both (OCO) →'}</button>
            {bracketMsg && <span role="status" style={{ color: bracketMsg.ok ? ZONE_COLORS.ok : ZONE_COLORS.danger }} className={css({ fontFamily: 'mono', fontSize: '9px', lineHeight: 1.4 })}>{bracketMsg.text}</span>}
          </div>
        )}

        <PositionAdjustActions
          coin={pos.coin}
          sz={pos.sz}
          side={side}
          markPx={d.markPx}
          entryPx={d.entryPx}
          leverage={d.leverage}
          mode={mode}
          currentMarginUsd={currentMarginUsd}
          hasStop={stop != null}
          stopTriggerPx={stop?.triggerPx ?? null}
          stopSz={stop?.sz ?? null}
          onStopAppeared={refetchStop}
          onCollapse={() => closeRef.current?.focus()}
        />

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
