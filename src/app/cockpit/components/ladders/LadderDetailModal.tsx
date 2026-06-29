'use client';

/**
 * LadderDetailModal — REVIEW then ARM/DISARM an existing ladder (opened by a row click).
 *
 * The list rows are intentionally thin; the decision happens here: the full plan (every
 * rung), the §3.5 risk preview recomputed client-side, and the action. The fix this
 * replaces: arming used to be a cramped inline input whose required phrase lived ONLY in
 * the placeholder (gone the moment you typed). Here the `arm <id8>` phrase is ALWAYS
 * visible as a copyable chip ABOVE the input — read it, copy it, type it, arm.
 *
 * Mirrors the EntryModal a11y contract: role=dialog, focus trap, Esc cancels.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { css } from '@styled-system/css';
import { GH, ZONE_COLORS, TERM, fmtPx, fmtUsd, fmtCompactUsd } from '../panel-styles';
import { SummaryRow } from '../approval-popup-parts';
import { resolveArmRung } from '@/lib/ladder/ladder-arm-business-logic';
import { computeLadderRisk } from '@/lib/ladder/ladder-risk-business-logic';
import type { LadderWithRungs, LadderRung } from '@/lib/ladder/ladder-types';

export interface LadderDetailModalProps {
  ladderId: string;
  onClose: () => void;
  /** Called after a successful arm/disarm so the parent can refresh + close. */
  onChanged?: () => void;
}

const STATUS_COLOR: Record<LadderWithRungs['status'], string> = {
  draft: GH.textMuted, armed: ZONE_COLORS.ok, disarmed: ZONE_COLORS.warn, done: GH.textMuted, expired: GH.textMuted,
};

export default function LadderDetailModal({ ladderId, onClose, onChanged }: LadderDetailModalProps) {
  const [ladder, setLadder] = useState<LadderWithRungs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const dialogRef = useRef<HTMLElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/cockpit/ladder/${ladderId}`, { cache: 'no-store' });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; ladder?: LadderWithRungs; error?: string };
      if (!res.ok || json.ok === false || !json.ladder) { setError(json.error ?? `Failed (${res.status})`); return; }
      setLadder(json.ladder); setError(null);
    } catch { setError('Network error — retry.'); }
  }, [ladderId]);

  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  // A11y: focus + inert siblings.
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

  const isLive = ladder?.mode === 'live';
  const armPhrase = `arm ${ladderId.slice(0, 8)}`;
  const phraseOk = !isLive || typed.trim().toLowerCase() === armPhrase;

  // Recompute the §3.5 risk preview from the loaded rungs (now=0 → render-pure; the
  // server re-validates at arm). Shown read-only so the operator reviews before consenting.
  const risk = useMemo(() => {
    if (!ladder) return null;
    const armRungs = ladder.rungs.map(resolveArmRung);
    return computeLadderRisk(armRungs, { maxTotalNotionalUsd: ladder.maxTotalNotionalUsd, maxTotalLossUsd: ladder.maxTotalLossUsd });
  }, [ladder]);

  function onKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
    if (e.key === 'Escape') { e.preventDefault(); if (!busy) onClose(); return; }
    if (e.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const f = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (f.length === 0) return;
    const first = f[0], last = f[f.length - 1], active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  async function post(path: string, body: unknown): Promise<boolean> {
    setBusy(true); setError(null);
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; warnings?: string[] };
      if (!res.ok || j.ok === false) { setError(j.warnings?.join(' ') ?? j.error ?? `Failed (${res.status})`); setBusy(false); return false; }
      return true;
    } catch { setError('Network error — retry.'); setBusy(false); return false; }
  }

  async function arm(): Promise<void> {
    if (!ladder || !phraseOk) return;
    if (await post('/api/cockpit/ladder/arm', { ladderId, confirmPhrase: isLive ? typed : undefined })) { onChanged?.(); onClose(); }
  }
  async function disarm(): Promise<void> {
    if (await post('/api/cockpit/ladder/disarm', { ladderId })) { onChanged?.(); onClose(); }
  }
  function copyPhrase(): void {
    void navigator.clipboard?.writeText(armPhrase).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => {});
  }

  return (
    <div ref={overlayRef} role="presentation" onKeyDown={onKeyDown}
      className={css({ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: { base: 'flex-end', md: 'center' }, justifyContent: 'center', padding: { base: '0', md: '16px' }, overflowY: 'auto' })}
      style={{ background: 'rgba(4,6,10,.65)', backdropFilter: 'blur(3px)' }}>
      <section ref={dialogRef} data-testid="ladder-detail-modal" role="dialog" aria-modal="true" aria-label="Ladder detail"
        className={css({ width: '100%', maxWidth: { base: '100%', md: '560px' }, maxHeight: '94vh', overflowY: 'auto', borderRadius: { base: '16px 16px 0 0', md: '16px' }, display: 'flex', flexDirection: 'column' })}
        style={{ background: '#0e131c', border: '1px solid rgba(255,255,255,.12)', boxShadow: '0 30px 80px rgba(0,0,0,.6)' }}>

        {/* Header */}
        <header className={css({ display: 'flex', alignItems: 'center', gap: '11px', padding: '18px 22px', borderBottom: '1px solid token(colors.github.border)' })}>
          <h2 className={css({ fontFamily: 'sans', fontSize: '14px', fontWeight: 'bold', color: 'github.textBright', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })}>{ladder?.title ?? 'Ladder'}</h2>
          {ladder && (
            <>
              <span className={css({ fontFamily: 'mono', fontSize: '10px', fontWeight: 'bold', borderRadius: '5px', paddingX: '8px', paddingY: '4px' })}
                style={{ background: isLive ? 'rgba(248,81,73,.16)' : 'rgba(255,255,255,.06)', color: isLive ? ZONE_COLORS.danger : GH.textMuted }}>{ladder.mode.toUpperCase()}</span>
              <span className={css({ fontFamily: 'mono', fontSize: '10.5px', fontWeight: 'semibold', textTransform: 'uppercase', letterSpacing: '0.06em' })} style={{ color: STATUS_COLOR[ladder.status] }}>{ladder.status}</span>
            </>
          )}
          <button ref={closeRef} type="button" data-testid="ladder-detail-close" aria-label="Close" onClick={onClose} disabled={busy}
            className={css({ width: '28px', height: '28px', borderRadius: '7px', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,255,255,0.1)', _disabled: { opacity: 0.5 } })}
            style={{ background: TERM.button, color: GH.textMuted }}>✕</button>
        </header>

        <div className={css({ padding: '18px 22px', overflowY: 'auto' })}>
          {error && <p data-testid="ladder-detail-error" className={css({ fontSize: 'xs', color: 'zone.danger', marginBottom: '12px' })}>{error}</p>}
          {!ladder && !error && <p className={css({ fontFamily: 'mono', fontSize: '12px', color: 'cockpit.faint' })}>Loading…</p>}

          {ladder && (
            <>
              {ladder.thesis && <p className={css({ fontFamily: 'sans', fontSize: '12px', color: 'github.textMuted', marginBottom: '14px', lineHeight: 1.5 })}>{ladder.thesis}</p>}

              {/* Rungs — the plan, read-only */}
              <FieldLabel>Rungs ({ladder.rungs.length})</FieldLabel>
              <div className={css({ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '7px', marginBottom: '16px' })}>
                {ladder.rungs.map((r) => <RungLine key={r.id} rung={r} />)}
              </div>

              {/* Risk preview */}
              {risk && (
                <div data-testid="ladder-detail-risk" className={css({ borderRadius: '11px', padding: '6px 16px', marginBottom: '16px' })} style={{ background: TERM.inset, border: '1px solid token(colors.github.border)' }}>
                  <div className={css({ fontFamily: 'sans', fontSize: '10px', fontWeight: 'semibold', textTransform: 'uppercase', letterSpacing: '0.12em', padding: '8px 0 4px', color: 'cockpit.faint' })}>Risk · all stops slip at once (no netting)</div>
                  <SummaryRow label="Worst-case loss" value={fmtUsd(-Math.abs(risk.aggregateWorstCaseLossUsd))} color={ZONE_COLORS.danger} />
                  <SummaryRow label="Total notional" value={risk.totalNotionalUsd > 0 ? fmtCompactUsd(risk.totalNotionalUsd) : '—'} color={GH.textBright} />
                  <SummaryRow label="Total margin" value={risk.totalMarginUsd > 0 ? fmtUsd(risk.totalMarginUsd).replace('+', '') : '—'} color={GH.textBright} />
                  {risk.perCoin.map((c) => <SummaryRow key={`${c.coin}-${c.side}`} label={`${c.coin} ${c.side} liq @ max`} value={c.aggregateLiqPx == null ? '—' : fmtPx(c.aggregateLiqPx)} color={GH.text} />)}
                  <SummaryRow label="Caps" value={`${ladder.maxTotalNotionalUsd ? fmtCompactUsd(ladder.maxTotalNotionalUsd) : '—'} / ${ladder.maxTotalLossUsd ? fmtUsd(ladder.maxTotalLossUsd).replace('+', '') : '—'} loss`} color={GH.textMuted} last />
                </div>
              )}
              {risk && risk.breaches.length > 0 && (
                <ul className={css({ marginBottom: '14px', display: 'flex', flexDirection: 'column', gap: '5px' })}>
                  {risk.breaches.map((b, i) => <li key={i} className={css({ fontFamily: 'mono', fontSize: '10.5px', lineHeight: 1.4, paddingLeft: '14px', position: 'relative' })} style={{ color: ZONE_COLORS.warn }}><span aria-hidden className={css({ position: 'absolute', left: 0 })}>⚠</span>{b}</li>)}
                </ul>
              )}
            </>
          )}
        </div>

        {/* Action footer — the consent surface */}
        {ladder && (ladder.status === 'draft' || ladder.status === 'armed') && (
          <div className={css({ padding: '14px 22px 18px', borderTop: '1px solid rgba(255,255,255,.07)' })}>
            {ladder.status === 'armed' ? (
              <button type="button" data-testid="ladder-detail-disarm" disabled={busy} onClick={() => void disarm()}
                className={css({ width: '100%', fontFamily: 'sans', fontSize: '13.5px', fontWeight: 'bold', borderRadius: '9px', padding: '13px', cursor: 'pointer', border: '1px solid rgba(248,81,73,.4)', _disabled: { opacity: 0.6 } })}
                style={{ background: 'rgba(248,81,73,.12)', color: ZONE_COLORS.danger }}>{busy ? 'Disarming…' : 'Disarm'}</button>
            ) : (
              <>
                {isLive && (
                  // The phrase is ALWAYS visible (copyable chip) — never hidden in a placeholder.
                  <div className={css({ marginBottom: '10px' })}>
                    <span className={css({ fontFamily: 'sans', fontSize: '11px', fontWeight: 'semibold', color: 'zone.danger', display: 'block', marginBottom: '6px' })}>This arms a LIVE ladder. To confirm, type the phrase below:</span>
                    <div className={css({ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' })}>
                      <code data-testid="ladder-arm-phrase-display" className={css({ fontFamily: 'mono', fontSize: '14px', fontWeight: 'bold', letterSpacing: '0.04em', color: 'github.textBright', borderRadius: '7px', padding: '7px 12px', userSelect: 'all' })} style={{ background: 'rgba(248,81,73,.12)', border: '1px solid rgba(248,81,73,.35)' }}>{armPhrase}</code>
                      <button type="button" data-testid="ladder-arm-copy" onClick={copyPhrase}
                        className={css({ fontFamily: 'mono', fontSize: '11px', fontWeight: 'semibold', borderRadius: '6px', padding: '7px 11px', cursor: 'pointer', border: '1px solid rgba(255,255,255,.12)' })} style={{ background: TERM.button, color: copied ? ZONE_COLORS.ok : GH.text }}>{copied ? '✓ copied' : '⧉ copy'}</button>
                    </div>
                    <input data-testid="ladder-arm-input" value={typed} onChange={(e) => setTyped(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="type the phrase here"
                      className={css({ width: '100%', borderRadius: '9px', color: 'github.textBright', fontFamily: 'mono', fontSize: 'sm', padding: '11px 12px' })} style={{ background: TERM.inset, border: `1px solid ${phraseOk && typed ? 'rgba(63,185,80,.5)' : 'rgba(255,255,255,.1)'}` }} />
                  </div>
                )}
                <button type="button" data-testid="ladder-detail-arm" disabled={busy || !phraseOk || (risk?.breaches.length ?? 0) > 0} onClick={() => void arm()}
                  style={{ background: !busy && phraseOk && (risk?.breaches.length ?? 0) === 0 ? (isLive ? ZONE_COLORS.danger : ZONE_COLORS.ok) : TERM.button, color: !busy && phraseOk && (risk?.breaches.length ?? 0) === 0 ? (isLive ? '#fff' : TERM.darkText) : GH.textMuted }}
                  className={css({ width: '100%', border: 'none', borderRadius: '9px', fontFamily: 'sans', fontSize: '13.5px', fontWeight: 'bold', letterSpacing: '0.03em', padding: '13px', cursor: 'pointer', _disabled: { opacity: 0.6, cursor: 'not-allowed' } })}>
                  {busy ? 'Arming…' : isLive ? 'Arm LIVE →' : 'Arm →'}
                </button>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className={css({ fontFamily: 'sans', fontSize: '10.5px', fontWeight: 'semibold', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block' })} style={{ color: '#9aa4b5' }}>{children}</span>;
}

/** One rung as a readable line: "1 · ETH LONG open · break ▲ 1618 · risk $5 · stop 5% · 3×". */
function RungLine({ rung }: { rung: LadderRung }) {
  const long = rung.side === 'long';
  const dir = rung.triggerKind === 'price_above' ? '▲' : rung.triggerKind === 'price_below' ? '▼' : '•';
  const bits = [
    rung.triggerPx != null ? `break ${dir} ${fmtPx(rung.triggerPx)}` : rung.triggerKind,
    rung.riskUsd != null ? `risk ${fmtUsd(rung.riskUsd).replace('+', '')}` : rung.sizeCoins != null ? `${rung.sizeCoins}` : null,
    rung.stopFrac != null ? `stop ${Math.round(rung.stopFrac * 1000) / 10}%` : null,
    rung.leverage != null ? `${rung.leverage}×` : null,
    rung.targetPx != null ? `tp ${fmtPx(rung.targetPx)}` : null,
  ].filter(Boolean);
  return (
    <div className={css({ display: 'flex', alignItems: 'center', gap: '9px', borderRadius: '9px', padding: '10px 13px' })} style={{ background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.07)' }}>
      <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted', flex: 'none' })}>#{rung.seq}</span>
      <span className={css({ fontFamily: 'mono', fontSize: '11px', fontWeight: 'bold', borderRadius: '5px', paddingX: '7px', paddingY: '3px', flex: 'none' })} style={{ background: long ? 'rgba(63,185,80,.16)' : 'rgba(248,81,73,.16)', color: long ? ZONE_COLORS.ok : ZONE_COLORS.danger }}>{rung.coin} {long ? 'LONG' : 'SHORT'}</span>
      <span className={css({ fontFamily: 'mono', fontSize: '11px', color: 'github.textMuted', flex: 'none' })}>{rung.action}</span>
      <span className={css({ fontFamily: 'mono', fontSize: '11px', color: 'github.text', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })} style={{ fontFeatureSettings: '"tnum"' }}>{bits.join(' · ')}</span>
    </div>
  );
}
