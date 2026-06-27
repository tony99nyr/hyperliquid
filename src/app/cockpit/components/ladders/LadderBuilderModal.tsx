'use client';

/**
 * LadderBuilderModal — author + PREVIEW + ARM an Armed Ladder.
 *
 * The operator builds a multi-rung plan (price-triggered, risk-sized rungs across
 * coins), sees the live §3.5 risk read (no-netting worst-case loss, per-coin liq at max
 * exposure, totals vs caps) and the §2 arm warnings computed CLIENT-SIDE by the SAME
 * pure functions the server runs at arm — so the preview can't say "safe" for a ladder
 * the server would reject. Arming is the authorization: PAPER arms in one step; LIVE
 * creates the draft, reveals the exact `arm <id8>` phrase, and arms only on an exact
 * typed match. Nothing fires here — the watcher/fire-rung (gated, P1d) executes later.
 *
 * Mirrors the EntryModal a11y contract: role=dialog, focus trap, Esc cancels.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { css } from '@styled-system/css';
import { NumberField, SummaryRow } from '../approval-popup-parts';
import { GH, ZONE_COLORS, TERM, fmtPx, fmtUsd, fmtCompactUsd } from '../panel-styles';
import {
  defaultDraftLadder,
  defaultDraftRung,
  buildLadderPreview,
  buildCreatePayload,
  type DraftLadder,
  type DraftRung,
} from './ladder-builder-helpers';

const COINS = ['ETH', 'BTC', 'SOL', 'HYPE'] as const;

export interface LadderBuilderModalProps {
  /** Seed the first rung's coin (the cockpit's current coin). */
  coin?: string;
  onClose: () => void;
  /** Called after a successful arm so the parent can refresh the list. */
  onArmed?: (ladderId: string) => void;
}

export default function LadderBuilderModal({ coin = 'ETH', onClose, onArmed }: LadderBuilderModalProps) {
  const [draft, setDraft] = useState<DraftLadder>(() => defaultDraftLadder(coin));
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isLive = draft.mode === 'live';
  // The preview is render-PURE: pass now=0 so the only now-sensitive check (expiry in
  // the future) reduces to "expiresInHours > 0" — exactly what we want to show, and no
  // impure Date.now() in render. The real create/arm uses Date.now() in the handler.
  const preview = useMemo(() => buildLadderPreview(draft, 0), [draft]);
  const ready = preview.warnings.length === 0;
  const armPhrase = createdId ? `arm ${createdId.slice(0, 8)}` : '';
  const phraseOk = !isLive || (!!createdId && typed.trim().toLowerCase() === armPhrase);

  const dialogRef = useRef<HTMLElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const overlay = overlayRef.current;
    const siblings: Element[] = [];
    if (overlay?.parentElement) {
      for (const child of Array.from(overlay.parentElement.children)) {
        if (child !== overlay) { siblings.push(child); child.setAttribute('inert', ''); child.setAttribute('aria-hidden', 'true'); }
      }
    }
    return () => { for (const c of siblings) { c.removeAttribute('inert'); c.removeAttribute('aria-hidden'); } };
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
    if (e.key === 'Escape') { e.preventDefault(); if (!busy) onClose(); return; }
    if (e.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const f = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (f.length === 0) return;
    const first = f[0], last = f[f.length - 1], active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  function patch(p: Partial<DraftLadder>): void { setDraft((d) => ({ ...d, ...p })); setCreatedId(null); setTyped(''); }
  function patchRung(i: number, p: Partial<DraftRung>): void {
    setDraft((d) => ({ ...d, rungs: d.rungs.map((r, idx) => (idx === i ? { ...r, ...p } : r)) }));
    setCreatedId(null); setTyped('');
  }
  function addRung(): void { setDraft((d) => ({ ...d, rungs: [...d.rungs, defaultDraftRung(d.rungs[d.rungs.length - 1]?.coin ?? coin)] })); setCreatedId(null); }
  function removeRung(i: number): void { setDraft((d) => ({ ...d, rungs: d.rungs.filter((_, idx) => idx !== i) })); setCreatedId(null); }

  async function createDraft(): Promise<string | null> {
    const res = await fetch('/api/cockpit/ladder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildCreatePayload(draft, Date.now())) });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; id?: string; error?: string };
    if (!res.ok || json.ok === false || !json.id) { setError(json.error ?? `Create failed (${res.status})`); return null; }
    return json.id;
  }

  async function arm(id: string): Promise<boolean> {
    const res = await fetch('/api/cockpit/ladder/arm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ladderId: id, confirmPhrase: isLive ? typed : undefined }) });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; warnings?: string[] };
    if (!res.ok || json.ok === false) { setError(json.warnings?.join(' ') ?? json.error ?? `Arm failed (${res.status})`); return false; }
    return true;
  }

  async function onPrimary(): Promise<void> {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      // LIVE is two-step: create → reveal phrase → arm. PAPER creates + arms in one go.
      let id = createdId;
      if (!id) { id = await createDraft(); if (!id) { setBusy(false); return; } setCreatedId(id); if (isLive) { setBusy(false); return; } }
      if (isLive && !phraseOk) { setBusy(false); return; }
      if (await arm(id)) { onArmed?.(id); onClose(); return; }
    } catch { setError('Network error — retry.'); }
    setBusy(false);
  }

  const primaryLabel = busy
    ? 'Working…'
    : isLive
      ? createdId
        ? 'Arm LIVE'
        : 'Create draft →'
      : 'Create & Arm (paper)';
  const primaryEnabled = !busy && ready && (!isLive || !createdId || phraseOk);

  return (
    <div ref={overlayRef} role="presentation" onKeyDown={onKeyDown}
      className={css({ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: { base: 'flex-end', md: 'center' }, justifyContent: 'center', padding: { base: '0', md: '16px' }, overflowY: 'auto' })}
      style={{ background: 'rgba(4,6,10,.65)', backdropFilter: 'blur(3px)' }}>
      <section ref={dialogRef} data-testid="ladder-builder-modal" role="dialog" aria-modal="true" aria-label="New armed ladder"
        className={css({ width: '100%', maxWidth: { base: '100%', md: '600px' }, maxHeight: '94vh', overflowY: 'auto', borderRadius: { base: '16px 16px 0 0', md: '16px' }, display: 'flex', flexDirection: 'column' })}
        style={{ background: '#0e131c', border: '1px solid rgba(255,255,255,.12)', boxShadow: '0 30px 80px rgba(0,0,0,.6)' }}>

        {/* Header */}
        <header className={css({ display: 'flex', alignItems: 'center', gap: '11px', padding: '18px 22px', borderBottom: '1px solid token(colors.github.border)' })}>
          <h2 className={css({ fontFamily: 'sans', fontSize: '13px', fontWeight: 'semibold', color: 'github.textBright', textTransform: 'uppercase', letterSpacing: '0.1em' })}>New Ladder</h2>
          <span className={css({ fontFamily: 'mono', fontSize: '10px' })} style={{ color: TERM.faint }}>author · preview · arm</span>
          <div className={css({ flex: 1 })} />
          <span data-testid="ladder-mode-badge" data-mode={draft.mode}
            style={{ color: isLive ? '#fff' : GH.textBright, background: isLive ? ZONE_COLORS.danger : TERM.button, boxShadow: isLive ? '0 0 0 3px rgba(248,81,73,0.22)' : undefined }}
            className={css({ fontFamily: 'sans', fontSize: 'xs', fontWeight: 'bold', letterSpacing: '0.1em', borderRadius: '6px', paddingX: '10px', paddingY: '5px' })}>{isLive ? 'LIVE' : 'PAPER'}</span>
          <button ref={closeRef} type="button" data-testid="ladder-close" aria-label="Cancel and close" onClick={onClose} disabled={busy}
            className={css({ width: '28px', height: '28px', borderRadius: '7px', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,255,255,0.1)', _disabled: { opacity: 0.5 } })}
            style={{ background: TERM.button, color: GH.textMuted }}>✕</button>
        </header>

        <div className={css({ padding: '18px 22px', overflowY: 'auto' })}>
          {/* Ladder-level fields */}
          <label className={css({ display: 'block', marginBottom: '12px' })}>
            <FieldLabel>Title</FieldLabel>
            <input data-testid="ladder-title" value={draft.title} onChange={(e) => patch({ title: e.target.value })} placeholder="e.g. ETH breakout pyramid"
              className={css({ width: '100%', borderRadius: '9px', color: 'github.textBright', fontFamily: 'sans', fontSize: 'sm', padding: '10px 12px' })} style={{ background: TERM.inset, border: '1px solid rgba(255,255,255,.08)' }} />
          </label>

          {/* Mode toggle */}
          <div className={css({ display: 'flex', gap: '4px', borderRadius: '9px', padding: '4px', marginBottom: '12px' })} style={{ background: TERM.inset, border: '1px solid rgba(255,255,255,.08)' }}>
            {(['paper', 'live'] as const).map((m) => (
              <button key={m} type="button" data-testid={`ladder-mode-${m}`} data-active={draft.mode === m} aria-pressed={draft.mode === m} onClick={() => patch({ mode: m })}
                style={{ background: draft.mode === m ? (m === 'live' ? ZONE_COLORS.danger : '#1c2536') : 'transparent', color: draft.mode === m ? (m === 'live' ? '#fff' : '#e8ebf2') : '#8b95a6' }}
                className={css({ flex: 1, fontFamily: 'mono', fontSize: '12px', fontWeight: 'semibold', paddingY: '7px', borderRadius: '6px', border: 'none', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.08em' })}>{m}</button>
            ))}
          </div>

          {/* Caps + expiry */}
          <div className={css({ display: 'flex', gap: '10px', marginBottom: '14px', flexWrap: 'wrap' })}>
            <NumberField label="Max notional ($)" testid="ladder-max-notional" value={draft.maxTotalNotionalUsd ?? 0} step={500} min={0} onChange={(v) => patch({ maxTotalNotionalUsd: v })} />
            <NumberField label="Max loss ($)" testid="ladder-max-loss" value={draft.maxTotalLossUsd ?? 0} step={50} min={0} onChange={(v) => patch({ maxTotalLossUsd: v })} />
            <NumberField label="Expires (h)" testid="ladder-expiry" value={draft.expiresInHours} step={1} min={1} onChange={(v) => patch({ expiresInHours: v })} />
          </div>

          {/* Rungs */}
          <div className={css({ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '8px' })}>
            <FieldLabel>Rungs ({draft.rungs.length})</FieldLabel>
            <button type="button" data-testid="ladder-add-rung" onClick={addRung} className={css({ fontFamily: 'mono', fontSize: '11px', color: 'github.link', bg: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' })}>+ add rung</button>
          </div>
          {draft.rungs.map((r, i) => (
            <RungCard key={i} idx={i} rung={r} canRemove={draft.rungs.length > 1} onChange={(p) => patchRung(i, p)} onRemove={() => removeRung(i)} />
          ))}

          {/* Live preview (§3.5) */}
          <div data-testid="ladder-preview" className={css({ borderRadius: '11px', padding: '6px 16px', marginTop: '14px' })} style={{ background: TERM.inset, border: '1px solid token(colors.github.border)' }}>
            <div className={css({ fontFamily: 'sans', fontSize: '10px', fontWeight: 'semibold', textTransform: 'uppercase', letterSpacing: '0.12em', padding: '8px 0 4px', color: 'cockpit.faint' })}>Risk preview · all stops slip at once (no netting)</div>
            <SummaryRow label="Worst-case loss" value={fmtUsd(-Math.abs(preview.risk.aggregateWorstCaseLossUsd))} color={ZONE_COLORS.danger} />
            <SummaryRow label="Total notional" value={preview.risk.totalNotionalUsd > 0 ? fmtCompactUsd(preview.risk.totalNotionalUsd) : '—'} color={GH.textBright} />
            <SummaryRow label="Total margin" value={preview.risk.totalMarginUsd > 0 ? fmtUsd(preview.risk.totalMarginUsd).replace('+', '') : '—'} color={GH.textBright} />
            {preview.risk.perCoin.map((c) => (
              <SummaryRow key={`${c.coin}-${c.side}`} label={`${c.coin} ${c.side} liq @ max`} value={c.aggregateLiqPx == null ? '—' : fmtPx(c.aggregateLiqPx)} color={GH.text} />
            ))}
            <SummaryRow label="Expires in" value={`${draft.expiresInHours}h`} color={GH.textMuted} last />
          </div>

          {/* Warnings (block arming) */}
          {preview.warnings.length > 0 && (
            <ul data-testid="ladder-warnings" className={css({ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '5px' })}>
              {preview.warnings.map((w, i) => (
                <li key={i} className={css({ fontFamily: 'mono', fontSize: '10.5px', lineHeight: 1.4, paddingLeft: '14px', position: 'relative' })} style={{ color: ZONE_COLORS.warn }}>
                  <span aria-hidden className={css({ position: 'absolute', left: 0 })}>⚠</span>{w}
                </li>
              ))}
            </ul>
          )}

          {/* LIVE arm phrase (revealed after the draft is created) */}
          {isLive && createdId && (
            <label className={css({ display: 'block', marginTop: '12px' })}>
              <span className={css({ fontSize: 'xs', color: 'zone.danger', fontWeight: 'semibold' })}>LIVE ARM — type <code className={css({ fontFamily: 'mono', color: 'github.textBright' })}>{armPhrase}</code> to enable</span>
              <input data-testid="ladder-arm-phrase" value={typed} onChange={(e) => setTyped(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={armPhrase}
                className={css({ width: '100%', borderRadius: '9px', color: 'github.textBright', fontFamily: 'mono', fontSize: 'sm', padding: '10px 12px', marginTop: '6px' })} style={{ background: TERM.inset, border: '1px solid rgba(255,255,255,.08)' }} />
            </label>
          )}
          {error && <p data-testid="ladder-error" className={css({ fontSize: 'xs', color: 'zone.danger', marginTop: '10px' })}>{error}</p>}
        </div>

        {/* Footer */}
        <div className={css({ display: 'flex', gap: '10px', padding: '16px 22px' })} style={{ borderTop: '1px solid rgba(255,255,255,.07)' }}>
          <button type="button" data-testid="ladder-cancel" disabled={busy} onClick={onClose}
            className={css({ fontFamily: 'sans', fontSize: '13px', fontWeight: 'medium', borderRadius: '9px', padding: '13px 22px', cursor: 'pointer', _disabled: { opacity: 0.5 } })} style={{ background: TERM.button, color: GH.text, border: '1px solid rgba(255,255,255,.1)' }}>Cancel</button>
          <button type="button" data-testid="ladder-arm" disabled={!primaryEnabled} onClick={() => void onPrimary()}
            style={{ background: primaryEnabled ? (isLive ? ZONE_COLORS.danger : ZONE_COLORS.ok) : TERM.button, color: primaryEnabled ? (isLive ? '#fff' : TERM.darkText) : GH.textMuted }}
            className={css({ flex: 1, border: 'none', borderRadius: '9px', fontFamily: 'sans', fontSize: '13.5px', fontWeight: 'bold', letterSpacing: '0.03em', padding: '13px', cursor: 'pointer', _disabled: { opacity: 0.6, cursor: 'not-allowed' } })}>{primaryLabel}</button>
        </div>
      </section>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className={css({ fontFamily: 'sans', fontSize: '10.5px', fontWeight: 'semibold', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: '7px' })} style={{ color: '#9aa4b5' }}>{children}</span>;
}

function RungCard({ idx, rung, canRemove, onChange, onRemove }: { idx: number; rung: DraftRung; canRemove: boolean; onChange: (p: Partial<DraftRung>) => void; onRemove: () => void }) {
  const long = rung.side === 'long';
  return (
    <div data-testid={`ladder-rung-${idx}`} className={css({ borderRadius: '10px', padding: '11px 13px', marginBottom: '8px' })} style={{ background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.07)' }}>
      <div className={css({ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '9px' })}>
        <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>#{idx + 1}</span>
        <select data-testid={`rung-coin-${idx}`} value={rung.coin} onChange={(e) => onChange({ coin: e.target.value })}
          className={css({ fontFamily: 'mono', fontSize: '12px', borderRadius: '6px', padding: '4px 6px', cursor: 'pointer' })} style={{ background: TERM.inset, color: GH.textBright, border: '1px solid rgba(255,255,255,.08)' }}>
          {COINS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {/* side: long fires on price_above (up-break), short on price_below (down-break) */}
        <button type="button" data-testid={`rung-side-${idx}`} onClick={() => onChange({ side: long ? 'short' : 'long', triggerKind: long ? 'price_below' : 'price_above' })}
          className={css({ fontFamily: 'mono', fontSize: '11px', fontWeight: 'bold', borderRadius: '6px', padding: '4px 10px', border: 'none', cursor: 'pointer' })}
          style={{ background: long ? 'rgba(63,185,80,.16)' : 'rgba(248,81,73,.16)', color: long ? ZONE_COLORS.ok : ZONE_COLORS.danger }}>{long ? 'LONG' : 'SHORT'}</button>
        <select data-testid={`rung-action-${idx}`} value={rung.action} onChange={(e) => onChange({ action: e.target.value as DraftRung['action'] })}
          className={css({ fontFamily: 'mono', fontSize: '11px', borderRadius: '6px', padding: '4px 6px', cursor: 'pointer' })} style={{ background: TERM.inset, color: GH.text, border: '1px solid rgba(255,255,255,.08)' }}>
          {(['open', 'add', 'reduce', 'close'] as const).map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <div className={css({ flex: 1 })} />
        {canRemove && <button type="button" data-testid={`rung-remove-${idx}`} aria-label={`Remove rung ${idx + 1}`} onClick={onRemove} className={css({ fontFamily: 'mono', fontSize: '11px', color: 'github.textMuted', bg: 'transparent', border: 'none', cursor: 'pointer' })}>✕</button>}
      </div>
      <div className={css({ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: '8px' })}>
        <MiniNum label={long ? 'Trigger ▲' : 'Trigger ▼'} testid={`rung-trigger-${idx}`} value={rung.triggerPx} onChange={(v) => onChange({ triggerPx: v })} />
        <MiniNum label="Risk $" testid={`rung-risk-${idx}`} value={rung.riskUsd} onChange={(v) => onChange({ riskUsd: v })} />
        <MiniNum label="Stop %" testid={`rung-stop-${idx}`} value={rung.stopFrac == null ? null : Math.round(rung.stopFrac * 1000) / 10} onChange={(v) => onChange({ stopFrac: v == null ? null : v / 100 })} />
        <MiniNum label="Lev ×" testid={`rung-lev-${idx}`} value={rung.leverage} onChange={(v) => onChange({ leverage: v })} />
        <MiniNum label="Target" testid={`rung-target-${idx}`} value={rung.targetPx} onChange={(v) => onChange({ targetPx: v })} />
      </div>
    </div>
  );
}

function MiniNum({ label, value, onChange, testid }: { label: string; value: number | null; onChange: (v: number | null) => void; testid: string }) {
  return (
    <label className={css({ display: 'flex', flexDirection: 'column', gap: '4px' })}>
      <span className={css({ fontFamily: 'mono', fontSize: '8.5px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'cockpit.faint' })}>{label}</span>
      <input type="number" inputMode="decimal" data-testid={testid} value={value ?? ''} onChange={(e) => { const n = parseFloat(e.target.value); onChange(Number.isFinite(n) ? n : null); }}
        className={css({ width: '100%', borderRadius: '6px', color: 'github.textBright', fontFamily: 'mono', fontSize: '12.5px', fontWeight: 'semibold', padding: '6px 8px' })} style={{ background: TERM.inset, border: '1px solid rgba(255,255,255,.08)', fontFeatureSettings: '"tnum"' }} />
    </label>
  );
}
