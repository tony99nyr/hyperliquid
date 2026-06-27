'use client';

/**
 * EntryModal — the SELF-SERVICE manual entry ticket ("＋ New Position").
 *
 * The cockpit-native parallel to the Claude-skill → approval-popup path: the
 * operator hand-builds an OPENING order here and Approves it; the proposal then
 * executes through the same /api/cockpit/open-position → executeIntent seam. This
 * NEVER auto-fires — nothing leaves the modal until the operator clicks Approve.
 *
 * Form: coin selector (ETH/BTC/HYPE) · LONG/SHORT toggle · risk-$ + stop-frac
 * sizing (risk-based, the SAME buildOpenProposal the skill uses) · the REUSED
 * LeverageControl (live margin/liq/ROE, Match-leader / ½-leader presets, and the
 * liquidation-inside-stop warning that GATES Approve) · optional thesis. The
 * summary shows entry / notional / margin / liq / est-fee / ROE. The current coin
 * bias is surfaced as advisory context. LIVE requires the exact typed phrase
 * before Approve enables (parity with the approval popup + terminal gate).
 *
 * Matches the dark terminal aesthetic and the ApprovalPopup a11y contract:
 * role=dialog, focus trap, Esc cancels, background inert.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { css } from '@styled-system/css';
import type { OrderSide, TradingMode } from '@/types/fill';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';
import type { RegimeDir } from './open-positions-helpers';
import { useCandles } from '@/hooks/useCandles';
import {
  resolveCoinMaxLeverage,
  halfLeaderLeverage,
} from '@/lib/trading/leverage-business-logic';
import {
  HOLD_TIMEFRAMES,
  suggestStopFrac,
  liquidationCushion,
  type HoldTimeframe,
} from '@/lib/cockpit/stop-suggestion-business-logic';
import { leaderPositionForCoin } from './leader-alignment-helpers';
import { LeverageControl, SideSegment, SummaryRow, NumberField } from './approval-popup-parts';
import {
  ENTRY_COINS,
  buildEntryPreview,
  clampLeverage,
  defaultEntryForm,
  entryLeverageRead,
  entryLiqInsideStop,
  entryLiveConfirmPhrase,
  entryTriggerError,
  isEntryApproveEnabled,
  type EntryFormState,
} from './entry-modal-helpers';
import { GH, ZONE_COLORS, TERM, fmtPx, fmtUsd, fmtCompactUsd, fmtPctSigned, regimeAbbrev, regimeColor } from './panel-styles';

export interface EntryModalProps {
  /** The trading mode (paper/live) — drives the LIVE typed-phrase gate. */
  mode: TradingMode;
  /** The coin the cockpit is currently on (opens the form on it). */
  coin: string;
  /** Side to seed the form with (e.g. an opportunity's SHORT). Defaults to buy/long. */
  initialSide?: OrderSide;
  /** Coins the operator can pick from. */
  coins?: string[];
  /** Current mark for the selected coin (entry price; sizing needs it). */
  entryPx: number | null;
  /** Net regime bias per coin (advisory context). */
  regimeByCoin?: Record<string, RegimeDir>;
  /** Leader's live positions (Match-leader / ½-leader leverage presets). */
  leaderPositions?: HlPosition[];
  /** Called when the operator switches the form's coin (so the parent can repoint the price feed). */
  onCoinChange?: (coin: string) => void;
  onClose: () => void;
  /** Called after a successful open so the parent can react (refresh / toast). */
  onExecuted?: (result: { coin: string; side: OrderSide; sessionId: string }) => void;
}

export default function EntryModal({
  mode,
  coin,
  initialSide = 'buy',
  coins = [...ENTRY_COINS],
  entryPx,
  regimeByCoin = {},
  leaderPositions = [],
  onCoinChange,
  onClose,
  onExecuted,
}: EntryModalProps) {
  const isLive = mode === 'live';
  const [form, setForm] = useState<EntryFormState>(() => defaultEntryForm(coin, initialSide));
  const [typed, setTyped] = useState('');
  const [ackLiqInsideStop, setAckLiqInsideStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const coinMax = useMemo(() => {
    const leaderPos = leaderPositionForCoin(leaderPositions, form.coin);
    return resolveCoinMaxLeverage(form.coin, leaderPos?.maxLeverage ?? null);
  }, [leaderPositions, form.coin]);
  const leaderLev = useMemo(() => {
    const leaderPos = leaderPositionForCoin(leaderPositions, form.coin);
    return leaderPos?.leverage ?? null;
  }, [leaderPositions, form.coin]);
  const halfLev = halfLeaderLeverage(leaderLev);

  // Holding timeframe → ATR-based stop suggestion + a leverage CEILING (longer holds
  // use lower leverage). The effective max is the tighter of the coin cap and the TF
  // cap; the server independently re-clamps the same way.
  const tfSpec = HOLD_TIMEFRAMES[form.timeframe];
  const tfCoinMax = Math.min(coinMax, tfSpec.maxLeverage);
  const tfCandles = useCandles(form.coin, tfSpec.interval);
  const suggestedStop = useMemo(
    () => suggestStopFrac(tfCandles.candles, tfSpec.atrMult, tfSpec.atrPeriod),
    [tfCandles.candles, tfSpec.atrMult, tfSpec.atrPeriod],
  );

  // Seed the stop from ATR ONCE per (coin, timeframe) when candles land — replacing
  // the old flat 4% default that wicked out. setState lives in a useCallback the
  // effect CALLS (keeps it out of the effect body; mirrors useTraderEvaluation).
  // The operator can override afterward; a new coin/TF re-seeds.
  const seedKey = `${form.coin}:${form.timeframe}`;
  const seededRef = useRef<string | null>(null);
  // True once the operator has hand-edited the stop for the CURRENT (coin,TF) — then
  // the auto-seed must not clobber it (covers the race where they type while candles
  // are still loading). Reset on a coin/TF change so the new TF can re-seed.
  const stopTouchedRef = useRef(false);
  const applySeed = useCallback(() => {
    if (suggestedStop != null && seededRef.current !== seedKey && !stopTouchedRef.current) {
      seededRef.current = seedKey;
      setForm((f) => ({ ...f, stopFrac: suggestedStop }));
    }
  }, [suggestedStop, seedKey]);
  useEffect(() => { applySeed(); }, [applySeed]);
  const onStopEdit = (frac: number) => { stopTouchedRef.current = true; patch({ stopFrac: frac }); };

  // Keep leverage within the EFFECTIVE band (coin ∧ timeframe). The slider clamps on
  // drag; clamp the READ too so the preview never reflects an out-of-band value.
  const effectiveLev = clampLeverage(form.leverage, tfCoinMax);
  const formForPreview = effectiveLev === form.leverage ? form : { ...form, leverage: effectiveLev };

  // A resting breakout/breakdown trigger fills at the TRIGGER level, not the current
  // mark — so when it's a valid trigger, the whole preview (size / liq / stop / ROE)
  // is computed off triggerPx. The direction check still uses the live mark (entryPx).
  const isTrigger = form.entryType === 'trigger';
  const triggerErr = isTrigger ? entryTriggerError(form.side, form.triggerPx, entryPx) : null;
  const previewPx = isTrigger && triggerErr == null ? form.triggerPx : entryPx;

  const proposal = buildEntryPreview(formForPreview, previewPx);
  const read = entryLeverageRead(formForPreview, proposal, previewPx);
  const liqInsideStop = entryLiqInsideStop(formForPreview, proposal, previewPx);
  const approveEnabled =
    !busy && isEntryApproveEnabled(mode, proposal, liqInsideStop, ackLiqInsideStop, typed, triggerErr);

  const dialogRef = useRef<HTMLElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // A11y: focus into the dialog, inert the background, restore on unmount.
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
      if (!busy) onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
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

  function patch(p: Partial<EntryFormState>): void {
    setForm((f) => ({ ...f, ...p }));
  }

  function setCoin(c: string): void {
    const norm = c.trim().toUpperCase();
    // Re-clamp leverage into the NEW coin's band, also honoring the TF ceiling.
    const nextLeaderPos = leaderPositionForCoin(leaderPositions, norm);
    const nextMax = Math.min(resolveCoinMaxLeverage(norm, nextLeaderPos?.maxLeverage ?? null), tfSpec.maxLeverage);
    stopTouchedRef.current = false; // new key → allow the ATR stop to re-seed
    patch({ coin: norm, leverage: clampLeverage(form.leverage, nextMax) });
    setTyped('');
    setAckLiqInsideStop(false);
    onCoinChange?.(norm);
  }

  function setTimeframe(tf: HoldTimeframe): void {
    // Switching hold timeframe re-clamps leverage to the new ceiling and re-seeds the
    // ATR stop for the new TF (clear the latch + the manual-edit flag).
    const nextMax = Math.min(coinMax, HOLD_TIMEFRAMES[tf].maxLeverage);
    stopTouchedRef.current = false;
    patch({ timeframe: tf, leverage: clampLeverage(form.leverage, nextMax) });
  }

  async function submit(): Promise<void> {
    if (!proposal) return;
    setBusy(true);
    setError(null);
    try {
      // Two seams: a MARKET-now open (executes immediately via the approval pipeline)
      // vs a resting breakout/breakdown TRIGGER (rests on HL, opens on the cross). BOTH
      // send the risk inputs (riskUsd + stopFrac) — the server sizes off them (never a
      // client coin count); the trigger path sizes against triggerPx, the level it fills.
      const res = isTrigger
        ? await fetch('/api/cockpit/entry-trigger', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              action: 'place',
              coin: form.coin,
              side: form.side === 'buy' ? 'long' : 'short',
              triggerPx: form.triggerPx,
              riskUsd: form.riskUsd,
              stopFrac: form.stopFrac,
              timeframe: form.timeframe,
              leverage: effectiveLev,
              confirmPhrase: isLive ? typed : undefined,
            }),
          })
        : await fetch('/api/cockpit/open-position', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              coin: form.coin,
              side: form.side,
              timeframe: form.timeframe,
              riskUsd: form.riskUsd,
              stopFrac: form.stopFrac,
              entryPx,
              leverage: effectiveLev,
              thesis: form.thesis,
              confirmPhrase: isLive ? typed : undefined,
            }),
          });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; sessionId?: string };
      if (!res.ok || json.ok === false) {
        setError(json.error ?? `Failed (${res.status})`);
        setBusy(false);
        return;
      }
      onExecuted?.({ coin: form.coin, side: form.side, sessionId: json.sessionId ?? '' });
      onClose();
    } catch {
      setError('Network error — retry.');
      setBusy(false);
    }
  }

  const sideLong = form.side === 'buy';
  const notionalUsd = read?.notionalUsd ?? 0;
  const liqPx = read?.liqPx ?? null;
  const stopPx = proposal?.stopPx ?? null;
  const cushion = liquidationCushion(previewPx, stopPx, liqPx);
  const dollarRisk = proposal?.dollarRisk ?? null;
  const takerFeeUsd = notionalUsd > 0 ? notionalUsd * 0.00035 : null;
  const szStr = proposal ? proposal.intent.sz.toLocaleString('en-US', { maximumFractionDigits: 6 }) : '—';
  const bias = regimeByCoin[form.coin] ?? null;

  const requiredPhrase = proposal ? entryLiveConfirmPhrase(form.side, form.coin) : '';
  const approveLabel = busy
    ? 'Submitting…'
    : isTrigger
      ? isLive
        ? 'Approve LIVE trigger'
        : `Arm ${sideLong ? 'Long' : 'Short'} trigger · ${szStr} ${form.coin}`
      : isLive
        ? 'Approve LIVE'
        : `Approve & ${sideLong ? 'Long' : 'Short'} ${szStr} ${form.coin}`;

  return (
    <div
      ref={overlayRef}
      role="presentation"
      onKeyDown={onKeyDown}
      className={css({ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: { base: 'flex-end', md: 'center' }, justifyContent: 'center', padding: { base: '0', md: '16px' }, overflowY: 'auto', animation: 'backdropIn 0.15s ease' })}
      style={{ background: 'rgba(4,6,10,.65)', backdropFilter: 'blur(3px)' }}
    >
      <section
        ref={dialogRef}
        data-testid="entry-modal"
        role="dialog"
        aria-modal="true"
        aria-label="New position"
        className={css({ width: '100%', maxWidth: { base: '100%', md: '520px' }, maxHeight: '94vh', overflowY: 'auto', borderRadius: { base: '16px 16px 0 0', md: '16px' }, paddingBottom: { base: 'env(safe-area-inset-bottom)', md: '0' }, display: 'flex', flexDirection: 'column', animation: 'popupIn 0.2s cubic-bezier(0.2, 0.8, 0.2, 1)' })}
        style={{ background: '#0e131c', border: '1px solid rgba(255,255,255,.12)', boxShadow: '0 30px 80px rgba(0,0,0,.6)' }}
      >
        {/* Header */}
        <header className={css({ display: 'flex', alignItems: 'center', gap: '11px', padding: '18px 22px', borderBottom: '1px solid token(colors.github.border)' })}>
          <h2 className={css({ fontFamily: 'sans', fontSize: '13px', fontWeight: 'semibold', color: 'github.textBright', textTransform: 'uppercase', letterSpacing: '0.1em' })}>
            New Position
          </h2>
          <span className={css({ fontFamily: 'mono', fontSize: '10px' })} style={{ color: TERM.faint }}>
            you build · you approve · you execute
          </span>
          <div className={css({ flex: 1 })} />
          <span
            data-testid="entry-mode-badge"
            data-mode={mode}
            style={{
              color: isLive ? '#fff' : GH.textBright,
              background: isLive ? ZONE_COLORS.danger : TERM.button,
              boxShadow: isLive ? `0 0 0 3px rgba(248,81,73,0.22)` : undefined,
            }}
            className={css({ fontFamily: 'sans', fontSize: 'xs', fontWeight: 'bold', letterSpacing: '0.1em', borderRadius: '6px', paddingX: '10px', paddingY: '5px', flex: 'none' })}
          >
            {isLive ? 'LIVE' : 'PAPER'}
          </span>
          <button
            ref={closeRef}
            type="button"
            data-testid="entry-close"
            aria-label="Cancel and close"
            onClick={onClose}
            disabled={busy}
            className={css({ width: '28px', height: '28px', borderRadius: '7px', flex: 'none', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,255,255,0.1)', _disabled: { opacity: 0.5, cursor: 'not-allowed' } })}
            style={{ background: TERM.button, color: GH.textMuted }}
          >
            ✕
          </button>
        </header>

        {/* Body */}
        <div className={css({ padding: '20px 22px', overflowY: 'auto' })}>
          {/* Coin selector + side toggle */}
          <div className={css({ display: 'flex', gap: '12px', marginBottom: '18px', flexWrap: 'wrap' })}>
            <div role="group" aria-label="Select coin" className={css({ display: 'flex', gap: '4px', borderRadius: '9px', padding: '4px', flex: 1, minWidth: '180px' })} style={{ background: TERM.inset, border: '1px solid rgba(255,255,255,.08)' }}>
              {coins.map((c) => {
                const active = c === form.coin;
                return (
                  <button
                    key={c}
                    type="button"
                    data-testid={`entry-coin-${c}`}
                    data-active={active}
                    aria-pressed={active}
                    onClick={() => setCoin(c)}
                    style={{ background: active ? '#1c2536' : 'transparent', color: active ? '#e8ebf2' : '#8b95a6' }}
                    className={css({ flex: 1, fontFamily: 'mono', fontSize: '13px', fontWeight: 'semibold', paddingY: '8px', borderRadius: '6px', border: 'none', cursor: 'pointer' })}
                  >
                    {c}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Side toggle (LONG / SHORT) — editable here (unlike the approval readout). */}
          <div className={css({ display: 'flex', gap: '4px', borderRadius: '9px', padding: '4px', marginBottom: '18px' })} style={{ background: TERM.inset, border: '1px solid rgba(255,255,255,.08)' }}>
            <button type="button" data-testid="entry-side-long" data-active={sideLong} aria-pressed={sideLong} onClick={() => patch({ side: 'buy' })} className={css({ display: 'flex', flex: 1, border: 'none', cursor: 'pointer', borderRadius: '6px', padding: '0' })} style={{ background: 'transparent' }}>
              <SideSegment label="LONG" active={sideLong} activeColor={ZONE_COLORS.ok} />
            </button>
            <button type="button" data-testid="entry-side-short" data-active={!sideLong} aria-pressed={!sideLong} onClick={() => patch({ side: 'sell' })} className={css({ display: 'flex', flex: 1, border: 'none', cursor: 'pointer', borderRadius: '6px', padding: '0' })} style={{ background: 'transparent' }}>
              <SideSegment label="SHORT" active={!sideLong} activeColor={ZONE_COLORS.danger} />
            </button>
          </div>

          {/* Entry type — fill at the market NOW, or rest a breakout/breakdown trigger. */}
          <div className={css({ marginBottom: '16px' })}>
            <span className={css({ fontFamily: 'sans', fontSize: '10.5px', fontWeight: 'semibold', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: '7px' })} style={{ color: '#9aa4b5' }}>Entry type</span>
            <div role="group" aria-label="Entry type" className={css({ display: 'flex', gap: '4px', borderRadius: '9px', padding: '4px' })} style={{ background: TERM.inset, border: '1px solid rgba(255,255,255,.08)' }}>
              {([['market', 'Market now'], ['trigger', 'Trigger (rest on break)']] as const).map(([t, label]) => {
                const active = t === form.entryType;
                return (
                  <button
                    key={t}
                    type="button"
                    data-testid={`entry-type-${t}`}
                    data-active={active}
                    aria-pressed={active}
                    onClick={() => { patch({ entryType: t }); setTyped(''); }}
                    style={{ background: active ? '#1c2536' : 'transparent', color: active ? '#e8ebf2' : '#8b95a6' }}
                    className={css({ flex: 1, fontFamily: 'mono', fontSize: '12px', fontWeight: 'semibold', paddingY: '7px', borderRadius: '6px', border: 'none', cursor: 'pointer' })}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {isTrigger && (
              <div className={css({ marginTop: '10px' })}>
                <div className={css({ display: 'flex', alignItems: 'center', gap: '8px', borderRadius: '9px', padding: '9px 12px' })} style={{ background: TERM.inset, border: `1px solid ${triggerErr ? 'rgba(248,81,73,.4)' : 'rgba(255,255,255,.08)'}` }}>
                  <span className={css({ fontFamily: 'mono', fontSize: '11px', flex: 'none' })} style={{ color: TERM.faint }}>Trigger @</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    data-testid="entry-trigger-px"
                    value={form.triggerPx ?? ''}
                    step="any"
                    min={0}
                    onChange={(e) => {
                      const n = parseFloat(e.target.value);
                      patch({ triggerPx: Number.isFinite(n) ? n : null });
                    }}
                    placeholder={entryPx != null ? `e.g. ${sideLong ? (entryPx * 1.01).toFixed(2) : (entryPx * 0.99).toFixed(2)}` : 'price'}
                    className={css({ flex: 1, width: '100%', background: 'transparent', border: 'none', outline: 'none', color: 'github.textBright', fontFamily: 'mono', fontSize: '15px', fontWeight: 'semibold' })}
                    style={{ fontFeatureSettings: '"tnum"' }}
                  />
                </div>
                <span data-testid="entry-trigger-hint" className={css({ fontFamily: 'mono', fontSize: '9.5px', display: 'block', marginTop: '5px' })} style={{ color: triggerErr ? ZONE_COLORS.danger : ZONE_COLORS.warn }}>
                  {triggerErr ?? `Rests on HL · fires a market ${sideLong ? 'long on a break ABOVE' : 'short on a break BELOW'} ${fmtPx(form.triggerPx)}.`}
                </span>
              </div>
            )}
          </div>

          {/* Hold timeframe — drives the ATR stop + leverage ceiling (fixes wick-outs). */}
          <div className={css({ marginBottom: '16px' })}>
            <span className={css({ fontFamily: 'sans', fontSize: '10.5px', fontWeight: 'semibold', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: '7px' })} style={{ color: '#9aa4b5' }}>Hold timeframe</span>
            <div role="group" aria-label="Hold timeframe" className={css({ display: 'flex', gap: '4px', borderRadius: '9px', padding: '4px' })} style={{ background: TERM.inset, border: '1px solid rgba(255,255,255,.08)' }}>
              {(Object.keys(HOLD_TIMEFRAMES) as HoldTimeframe[]).map((tf) => {
                const active = tf === form.timeframe;
                return (
                  <button
                    key={tf}
                    type="button"
                    data-testid={`entry-tf-${tf}`}
                    data-active={active}
                    aria-pressed={active}
                    onClick={() => setTimeframe(tf)}
                    title={HOLD_TIMEFRAMES[tf].hint}
                    style={{ background: active ? '#1c2536' : 'transparent', color: active ? '#e8ebf2' : '#8b95a6' }}
                    className={css({ flex: 1, fontFamily: 'mono', fontSize: '12px', fontWeight: 'semibold', paddingY: '7px', borderRadius: '6px', border: 'none', cursor: 'pointer' })}
                  >
                    {HOLD_TIMEFRAMES[tf].label}
                  </button>
                );
              })}
            </div>
            <span className={css({ fontFamily: 'mono', fontSize: '9px', color: 'github.textMuted', display: 'block', marginTop: '5px' })}>
              {tfSpec.hint} · stop ≈ {tfSpec.atrMult}× ATR({tfSpec.interval}) · max {tfSpec.maxLeverage}×
            </span>
          </div>

          {/* Advisory regime bias */}
          {bias && (
            <div data-testid="entry-bias" className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontFamily: 'mono', fontSize: 'xs', borderRadius: '9px', padding: '8px 14px', marginBottom: '16px' })} style={{ background: TERM.inset, border: '1px solid token(colors.github.border)' }}>
              <span className={css({ color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.05em' })}>{form.coin} regime (advisory)</span>
              <span style={{ color: regimeColor(bias) }}>{regimeAbbrev(bias)}</span>
            </div>
          )}

          {/* Sizing: risk $ + stop frac */}
          <div className={css({ display: 'flex', gap: '12px', marginBottom: '18px', flexWrap: 'wrap' })}>
            <NumberField
              label="Risk ($)"
              testid="entry-risk"
              value={form.riskUsd}
              step={5}
              min={1}
              onChange={(v) => patch({ riskUsd: v })}
            />
            <NumberField
              label="Stop (%)"
              testid="entry-stop"
              value={Math.round(form.stopFrac * 1000) / 10}
              step={0.5}
              min={0.1}
              max={99}
              suffix="%"
              onChange={(v) => onStopEdit(v / 100)}
            />
          </div>

          {/* ATR stop hint — the stop seeds from ATR at the hold timeframe; show the
              suggestion + a one-click re-apply if the operator drifted off it. */}
          <div data-testid="entry-atr-hint" className={css({ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '-8px', marginBottom: '18px', fontFamily: 'mono', fontSize: '9.5px', color: 'github.textMuted' })}>
            {suggestedStop != null ? (
              (() => {
                const drifted = Math.abs(suggestedStop - form.stopFrac) > 0.002;
                return (
                  <>
                    <span>
                      {drifted
                        ? <>ATR({tfSpec.interval}) suggests <strong style={{ color: GH.text }}>{(suggestedStop * 100).toFixed(1)}%</strong> — beyond typical noise</>
                        : <>stop set from ATR({tfSpec.interval}) <span style={{ color: ZONE_COLORS.ok }}>✓</span> — beyond typical noise</>}
                    </span>
                    {/* Mounted-but-disabled (not conditionally removed) so focus never
                        falls out of the trap when the operator edits back onto it. */}
                    <button
                      type="button"
                      data-testid="entry-atr-apply"
                      disabled={!drifted}
                      onClick={() => patch({ stopFrac: suggestedStop })}
                      className={css({ fontFamily: 'mono', fontSize: '9.5px', color: 'github.link', bg: 'transparent', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline', _disabled: { opacity: 0, pointerEvents: 'none' }, _focusVisible: { outline: '2px solid token(colors.github.link)' } })}
                    >
                      use
                    </button>
                  </>
                );
              })()
            ) : (
              <span>{tfCandles.loading ? 'measuring volatility…' : 'ATR unavailable — set the stop at a structural level (beyond the recent swing).'}</span>
            )}
          </div>

          {/* Computed size readout */}
          <div className={css({ marginBottom: '18px' })}>
            <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '9px' })}>
              <span className={css({ fontFamily: 'sans', fontSize: '10.5px', fontWeight: 'semibold', textTransform: 'uppercase', letterSpacing: '0.1em' })} style={{ color: '#9aa4b5' }}>Size (risk-sized)</span>
              <span className={css({ fontFamily: 'mono', fontSize: '12px', color: 'github.textMuted' })} style={{ fontFeatureSettings: '"tnum"' }}>≈ {notionalUsd > 0 ? fmtCompactUsd(notionalUsd) : '—'} notional</span>
            </div>
            <div className={css({ display: 'flex', alignItems: 'center', gap: '10px', borderRadius: '9px', padding: '11px 14px' })} style={{ background: TERM.inset, border: '1px solid rgba(255,255,255,.08)' }}>
              <span data-testid="entry-size" className={css({ flex: 1, fontFamily: 'mono', fontSize: '16px', fontWeight: 'semibold', color: 'github.textBright' })} style={{ fontFeatureSettings: '"tnum"' }}>{szStr}</span>
              <span className={css({ fontFamily: 'mono', fontSize: '12px' })} style={{ color: TERM.faint }}>{form.coin}</span>
            </div>
          </div>

          {/* Leverage control (REUSED from the approval flow) */}
          {read && proposal && (
            <LeverageControl
              coin={form.coin}
              coinMax={tfCoinMax}
              leverage={effectiveLev}
              setLeverage={(v) => patch({ leverage: clampLeverage(v, tfCoinMax) })}
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

          {/* Optional thesis */}
          <label className={css({ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '16px' })}>
            <span className={css({ fontFamily: 'sans', fontSize: '10.5px', fontWeight: 'semibold', textTransform: 'uppercase', letterSpacing: '0.1em' })} style={{ color: '#9aa4b5' }}>Thesis (optional)</span>
            <input
              data-testid="entry-thesis"
              value={form.thesis}
              onChange={(e) => patch({ thesis: e.target.value })}
              placeholder="What are you betting on?"
              className={css({ borderRadius: '9px', color: 'github.textBright', fontFamily: 'sans', fontSize: 'sm', padding: '10px 12px' })}
              style={{ background: TERM.inset, border: '1px solid rgba(255,255,255,.08)' }}
            />
          </label>

          {/* A resting trigger OPENS the position but attaches NO stop — make that
              impossible to miss (the stop/risk rows below are only a PLAN to execute
              after the fill, not an order that will exist). */}
          {isTrigger && (
            <div data-testid="entry-naked-warning" role="alert" className={css({ display: 'flex', alignItems: 'flex-start', gap: '8px', borderRadius: '10px', padding: '10px 13px', marginBottom: '12px' })} style={{ background: 'rgba(248,81,73,.1)', border: `1px solid rgba(248,81,73,.4)` }}>
              <span aria-hidden className={css({ fontSize: '13px', lineHeight: 1.3 })} style={{ color: ZONE_COLORS.danger }}>⚠</span>
              <span className={css({ fontFamily: 'sans', fontSize: '11px', lineHeight: 1.45 })} style={{ color: '#f5c2c0' }}>
                Opens <strong>without a protective stop</strong>. If it fires while you&rsquo;re away, the position is naked until you place a stop. The stop / risk / ROE below are your <strong>plan to execute after the fill</strong> — not part of this order.
              </span>
            </div>
          )}

          {/* Summary box */}
          <div className={css({ borderRadius: '11px', padding: '6px 16px', marginBottom: '16px' })} style={{ background: TERM.inset, border: '1px solid token(colors.github.border)' }}>
            <SummaryRow label={isTrigger ? 'Entry (on trigger)' : 'Entry (market)'} value={fmtPx(previewPx)} />
            <SummaryRow label="Notional" value={notionalUsd > 0 ? fmtCompactUsd(notionalUsd) : '—'} color={GH.textBright} />
            <SummaryRow label="Margin required" value={read ? fmtUsd(read.marginUsd).replace('+', '') : '—'} color={GH.textBright} />
            <SummaryRow label="Liquidation price" value={liqPx == null ? '—' : fmtPx(liqPx)} color={liqInsideStop ? ZONE_COLORS.danger : GH.text} />
            <SummaryRow
              label="Liq cushion"
              value={cushion == null ? '—' : `${cushion.toFixed(1)}× stop`}
              // danger <1.5× aligns with the liq-inside-stop gate (which acks at ≤1×):
              // red means "near the gate," not a benign 2×. warn 1.5–2.5×, ok ≥2.5×.
              color={cushion == null ? GH.textMuted : cushion < 1.5 ? ZONE_COLORS.danger : cushion < 2.5 ? ZONE_COLORS.warn : ZONE_COLORS.ok}
            />
            {/* In trigger mode these describe the stop the operator must place AFTER the
                fill — labeled "(after fill)" so they're never read as part of the order. */}
            <SummaryRow label={isTrigger ? 'Stop price (after fill)' : 'Stop price'} value={fmtPx(stopPx)} color={ZONE_COLORS.warn} />
            <SummaryRow label={isTrigger ? 'Risk at stop (planned)' : 'Risk at stop'} value={dollarRisk == null ? '—' : fmtUsd(-Math.abs(dollarRisk))} color={ZONE_COLORS.danger} />
            <SummaryRow label="ROE @ stop" value={read?.roeAtStopPct == null ? '—' : fmtPctSigned(read.roeAtStopPct)} color={ZONE_COLORS.danger} />
            {takerFeeUsd != null && <SummaryRow label="Est. taker fee" value={fmtUsd(takerFeeUsd).replace('+', '')} color={GH.textMuted} last />}
          </div>

          {/* LIVE typed-phrase gate */}
          {isLive && (
            <label className={css({ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '4px' })}>
              <span className={css({ fontSize: 'xs', color: 'zone.danger', fontWeight: 'semibold' })}>
                LIVE ORDER — type <code className={css({ fontFamily: 'mono', color: 'github.textBright' })}>{requiredPhrase}</code> to enable Approve
              </span>
              <input
                data-testid="entry-live-confirm-input"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={requiredPhrase}
                className={css({ borderRadius: '9px', color: 'github.textBright', fontFamily: 'mono', fontSize: 'sm', padding: '10px 12px' })}
                style={{ background: TERM.inset, border: '1px solid rgba(255,255,255,.08)' }}
              />
            </label>
          )}

          {entryPx == null && (
            <p data-testid="entry-no-price" className={css({ fontSize: 'xs', color: 'zone.warn', marginTop: '8px' })}>
              Waiting for a live {form.coin} mark — sizing is blocked until the price feed lands.
            </p>
          )}
          {error && (
            <p data-testid="entry-error" className={css({ fontSize: 'xs', color: 'zone.danger', marginTop: '10px' })}>{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className={css({ display: 'flex', gap: '10px', padding: '16px 22px' })} style={{ borderTop: '1px solid rgba(255,255,255,.07)' }}>
          <button
            type="button"
            data-testid="entry-cancel"
            disabled={busy}
            onClick={onClose}
            className={css({ fontFamily: 'sans', fontSize: '13px', fontWeight: 'medium', borderRadius: '9px', padding: '13px 22px', cursor: 'pointer', _hover: { borderColor: 'github.textMuted' }, _disabled: { opacity: 0.5, cursor: 'not-allowed' } })}
            style={{ background: TERM.button, color: GH.text, border: '1px solid rgba(255,255,255,.1)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="entry-approve"
            disabled={!approveEnabled}
            onClick={() => void submit()}
            style={{
              background: approveEnabled ? (isLive ? ZONE_COLORS.danger : ZONE_COLORS.ok) : TERM.button,
              color: approveEnabled ? (isLive ? '#fff' : TERM.darkText) : GH.textMuted,
            }}
            className={css({ flex: 1, border: 'none', borderRadius: '9px', fontFamily: 'sans', fontSize: '13.5px', fontWeight: 'bold', letterSpacing: '0.03em', padding: '13px', cursor: 'pointer', _disabled: { opacity: 0.6, cursor: 'not-allowed' } })}
          >
            {approveLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
