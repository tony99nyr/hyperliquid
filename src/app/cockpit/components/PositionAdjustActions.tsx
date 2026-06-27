'use client';

/**
 * PositionAdjustActions — the two position-modifying actions from the insights modal,
 * extracted so the modal stays focused on read-only insight + protective orders:
 *   - Add margin (de-risk): post collateral → liquidation moves away, size unchanged.
 *   - Add to position (pyramid): increase SIZE into the same side — a real-money OPEN
 *     with the full safety preview (new size/avg/liq, $-at-risk growth, averaging-down
 *     ack, LIVE typed-phrase). BLOCKED while a stop rests (the stop only covers the old
 *     size; cancel + re-place at the new average first). NO-AUTO-FIRE: explicit Approve.
 */

import { useState } from 'react';
import { css } from '@styled-system/css';
import type { TradingMode } from '@/types/fill';
import { previewAdd, MAX_ADD_MULTIPLE, type AddSizeMode } from '@/lib/trading/add-to-position-business-logic';
import { entryLiveConfirmPhrase } from './entry-modal-helpers';
import { ZONE_COLORS, GH, fmtPx, fmtCompactUsd } from './panel-styles';

export interface PositionAdjustActionsProps {
  coin: string;
  sz: number;
  side: 'long' | 'short';
  markPx: number | null;
  entryPx: number | null;
  leverage: number | null;
  mode: TradingMode;
  /** REAL isolated margin (HL marginUsed) — makes the add/margin previews margin-aware. */
  currentMarginUsd: number | null;
  /** Whether a protective stop rests (adds are blocked until it's cancelled). */
  hasStop: boolean;
  stopTriggerPx: number | null;
  stopSz: number | null;
  /** Called when the add route reports a stop appeared elsewhere (re-fetch it). */
  onStopAppeared: () => void;
  /** Called after a reveal collapses, to restore focus into the dialog. */
  onCollapse: () => void;
}

export default function PositionAdjustActions({
  coin, sz, side, markPx, entryPx, leverage, mode, currentMarginUsd, hasStop, stopTriggerPx, stopSz, onStopAppeared, onCollapse,
}: PositionAdjustActionsProps) {
  // ── Add margin ──
  const [marginOpen, setMarginOpen] = useState(false);
  const [marginAmt, setMarginAmt] = useState('');
  const [marginBusy, setMarginBusy] = useState(false);
  const [marginMsg, setMarginMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const amt = parseFloat(marginAmt);
  const amtValid = Number.isFinite(amt) && amt > 0;
  // Projected effective leverage after posting `amt` more margin. Use the REAL current
  // margin so it reflects margin already added; fall back to the setting estimate.
  const projectedLev = amtValid && markPx != null
    ? (() => {
        const notional = markPx * sz;
        const baseMargin = currentMarginUsd != null && currentMarginUsd > 0
          ? currentMarginUsd
          : leverage != null && leverage > 0 ? notional / leverage : null;
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
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ coin, amountUsd: amt }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; pushed?: boolean };
      if (!res.ok || json.ok === false) setMarginMsg({ ok: false, text: json.error ?? `Failed (${res.status})` });
      else { setMarginMsg({ ok: true, text: json.pushed ? `Added $${amt} margin — liquidation moves away.` : `Recorded $${amt} (paper).` }); setMarginAmt(''); setMarginOpen(false); onCollapse(); }
    } catch {
      setMarginMsg({ ok: false, text: 'Network error — retry.' });
    } finally {
      setMarginBusy(false);
    }
  }

  // ── Add to position (pyramid) ──
  const isLive = mode === 'live';
  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<AddSizeMode>('pct');
  const [addValue, setAddValue] = useState('');
  const [ackDown, setAckDown] = useState(false);
  const [addPhrase, setAddPhrase] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addMsg, setAddMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const addVal = parseFloat(addValue);
  const addPreview = entryPx != null && markPx != null && Number.isFinite(addVal) && addVal > 0
    ? previewAdd({ side, currentSz: sz, currentEntryPx: entryPx, markPx, leverage: leverage ?? 1, mode: addMode, value: addVal, maxAddMultiple: MAX_ADD_MULTIPLE, currentMarginUsd: currentMarginUsd ?? undefined })
    : null;
  const requiredAddPhrase = entryLiveConfirmPhrase(side === 'long' ? 'buy' : 'sell', coin);
  const addApproveOk = !addBusy && addPreview != null && addPreview.addSz > 0 && addPreview.warnings.length === 0
    && (!addPreview.isAveragingDown || ackDown)
    && (!isLive || addPhrase.trim().toLowerCase() === requiredAddPhrase);

  async function submitAdd(): Promise<void> {
    if (!addApproveOk || addPreview == null) return;
    setAddBusy(true);
    setAddMsg(null);
    try {
      const res = await fetch('/api/cockpit/add-to-position', {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ coin, mode: addMode, value: addVal, ackAveragingDown: ackDown, confirmPhrase: isLive ? addPhrase : undefined }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; requiresAck?: boolean; hasStop?: boolean };
      if (!res.ok || json.ok === false) {
        if (json.requiresAck) setAckDown(false);
        if (json.hasStop) onStopAppeared(); // a stop appeared (placed elsewhere) — surface it
        setAddMsg({ ok: false, text: json.error ?? `Failed (${res.status})` });
      } else {
        setAddMsg({ ok: true, text: `Added ${addPreview.addSz} ${coin} — new size ${addPreview.newSz}.` });
        setAddValue(''); setAddOpen(false); setAckDown(false); setAddPhrase('');
        onCollapse();
      }
    } catch {
      setAddMsg({ ok: false, text: 'Network error — retry.' });
    } finally {
      setAddBusy(false);
    }
  }

  return (
    <>
      {/* Add margin — the correct, non-martingale de-risk: post collateral → liq moves
          away, size unchanged. (Lowering leverage hits HL's margin restriction.) */}
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
              type="number" inputMode="decimal" data-testid="insights-add-margin-amount" aria-label="Margin amount (USD)"
              value={marginAmt} onChange={(e) => setMarginAmt(e.target.value)} placeholder="amount" min={1}
              className={css({ width: '90px', bg: 'github.bgSecondary', border: '1px solid token(colors.github.border)', borderRadius: '6px', color: 'github.textBright', fontFamily: 'mono', fontSize: '13px', padding: '6px 8px', outline: 'none', _focusVisible: { borderColor: 'github.link' } })}
            />
            {projectedLev != null && <span className={css({ fontFamily: 'mono', fontSize: '9px', color: 'github.textMuted' })}>→ ≈ {projectedLev.toFixed(1)}× eff lev</span>}
            <button type="button" data-testid="insights-add-margin-submit" disabled={!amtValid || marginBusy} onClick={() => void submitAddMargin()} className={css({ fontFamily: 'sans', fontSize: '11px', fontWeight: 'semibold', color: 'github.bg', bg: 'github.link', border: 'none', borderRadius: '6px', paddingX: '12px', paddingY: '6px', cursor: 'pointer', _disabled: { opacity: 0.5, cursor: 'not-allowed' }, _focusVisible: { outline: '2px solid token(colors.github.link)', outlineOffset: '2px' } })}>{marginBusy ? 'adding…' : 'Add margin'}</button>
            <button type="button" data-testid="insights-add-margin-cancel" onClick={() => { setMarginOpen(false); setMarginAmt(''); onCollapse(); }} className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted', bg: 'transparent', border: 'none', cursor: 'pointer', padding: '6px' })}>cancel</button>
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
            {hasStop && (
              <span data-testid="insights-add-blocked-stop" className={css({ fontFamily: 'mono', fontSize: '9.5px', lineHeight: 1.45, borderRadius: '6px', padding: '8px 10px' })} style={{ background: 'rgba(242,77,94,0.08)', border: '1px solid rgba(242,77,94,0.3)', color: '#ff9aa6' }}>
                ⚠ A stop is resting @ {fmtPx(stopTriggerPx)} (covers {stopSz}). Cancel it above before adding — then re-place it at the new average entry.
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
                <div className={css({ display: 'flex', justifyContent: 'space-between' })}><span className={css({ color: 'github.textMuted' })}>add</span><span>+{addPreview.addSz} {coin} · ≈{fmtCompactUsd(addPreview.addNotionalUsd)} · margin {fmtCompactUsd(addPreview.addMarginUsd)}</span></div>
                <div className={css({ display: 'flex', justifyContent: 'space-between' })}><span className={css({ color: 'github.textMuted' })}>size → / avg →</span><span>{sz} → <strong>{addPreview.newSz}</strong> · avg {fmtPx(addPreview.newAvgEntryPx)}</span></div>
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
              <button type="button" data-testid="insights-add-submit" disabled={!addApproveOk || hasStop} onClick={() => void submitAdd()} style={{ background: addApproveOk && !hasStop ? (isLive ? ZONE_COLORS.danger : ZONE_COLORS.ok) : undefined }} className={css({ fontFamily: 'sans', fontSize: '11px', fontWeight: 'bold', color: addApproveOk && !hasStop ? '#06251a' : 'github.textMuted', bg: addApproveOk && !hasStop ? undefined : 'github.bgSecondary', border: 'none', borderRadius: '6px', paddingX: '14px', paddingY: '7px', cursor: addApproveOk && !hasStop ? 'pointer' : 'not-allowed', _disabled: { opacity: 0.6, cursor: 'not-allowed' } })}>{addBusy ? 'adding…' : isLive ? 'Approve LIVE add' : `Add ${addPreview?.addSz ?? ''} ${coin}`}</button>
              <button type="button" data-testid="insights-add-cancel" onClick={() => { setAddOpen(false); setAddValue(''); setAckDown(false); onCollapse(); }} className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted', bg: 'transparent', border: 'none', cursor: 'pointer', padding: '6px' })}>cancel</button>
              {hasStop && <span className={css({ fontFamily: 'mono', fontSize: '9px', color: 'zone.danger' })}>cancel the resting stop first ↑</span>}
            </div>
          </>
        )}
        {addMsg && (
          <span role="status" style={{ color: addMsg.ok ? ZONE_COLORS.ok : ZONE_COLORS.danger }} className={css({ fontFamily: 'mono', fontSize: '9.5px', lineHeight: 1.4 })}>{addMsg.text}</span>
        )}
      </div>
    </>
  );
}
