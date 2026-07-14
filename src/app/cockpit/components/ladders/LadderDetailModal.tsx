'use client';

/**
 * LadderDetailModal — REVIEW then ARM/DISARM a ladder (opened by a row click). Answers,
 * at a glance: WHERE will it fire (chart + trigger), HOW CLOSE is it (live distance per
 * rung), WHAT is the trade (size/stop/target/risk/reward/R:R per rung), and WHAT'S the
 * worst case (aggregate). Then the consent surface (the always-visible `arm <id8>` phrase)
 * and arm/disarm.
 *
 * Live marks come from one shared per-coin probe (a hidden useHlOrderbook per distinct
 * coin) so the proximity reads are live for EVERY rung — even coins the cockpit isn't
 * currently showing — without spinning up a ws per card.
 *
 * Mirrors the EntryModal a11y contract: role=dialog, focus trap, Esc cancels.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { css } from '@styled-system/css';
import { GH, ZONE_COLORS, TERM, fmtPx, fmtUsd, fmtCompactUsd, fmtPctSigned } from '../panel-styles';
import { SummaryRow } from '../approval-popup-parts';
import { useHlOrderbook } from '@/hooks/useHlOrderbook';
import { useNow } from '@/hooks/useNow';
import { resolveArmRung } from '@/lib/ladder/ladder-arm-business-logic';
import { computeLadderRisk } from '@/lib/ladder/ladder-risk-business-logic';
import { projectRung, rungProximity, expiryReadout } from '@/lib/ladder/ladder-projection-business-logic';
import LadderChart from './LadderChart';
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

const RUNG_STATUS: Record<LadderRung['status'], { label: string; color: string }> = {
  pending: { label: 'WAITING', color: ZONE_COLORS.warn },
  fired: { label: '✓ FIRED', color: ZONE_COLORS.ok },
  skipped: { label: 'SKIPPED', color: GH.textMuted },
  failed: { label: 'FAILED', color: ZONE_COLORS.danger },
  cancelled: { label: 'CANCELLED', color: GH.textMuted },
};

/** Hidden per-coin live-mark probe — one ws per distinct coin, reported up to the modal. */
function MarkProbe({ coin, onPx }: { coin: string; onPx: (coin: string, px: number | null) => void }) {
  const { lastPx } = useHlOrderbook(coin);
  useEffect(() => { onPx(coin, lastPx); }, [coin, lastPx, onPx]);
  return null;
}

export default function LadderDetailModal({ ladderId, onClose, onChanged }: LadderDetailModalProps) {
  const [ladder, setLadder] = useState<LadderWithRungs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [marks, setMarks] = useState<Record<string, number | null>>({});
  // Render-safe ticking clock for the expiry chip.
  const now = useNow();

  const dialogRef = useRef<HTMLElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const reportPx = useCallback((coin: string, px: number | null) => {
    setMarks((m) => (m[coin] === px ? m : { ...m, [coin]: px }));
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/cockpit/ladder/${ladderId}`, { cache: 'no-store' });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; ladder?: LadderWithRungs; error?: string };
      if (!res.ok || json.ok === false || !json.ladder) { setError(json.error ?? `Failed (${res.status})`); return; }
      setLadder(json.ladder); setError(null);
    } catch { setError('Network error — retry.'); }
  }, [ladderId]);

  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  // A11y: focus + inert siblings + restore focus to the opener on close. Because the
  // overlay is PORTALED to document.body, inerting the overlay's siblings now neutralizes
  // the whole app root (real focus trap), not just whatever panel rendered this modal.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const overlay = overlayRef.current;
    const siblings: Element[] = [];
    if (overlay?.parentElement) {
      for (const child of Array.from(overlay.parentElement.children)) {
        if (child !== overlay) { siblings.push(child); child.setAttribute('inert', ''); child.setAttribute('aria-hidden', 'true'); }
      }
    }
    return () => {
      for (const c of siblings) { c.removeAttribute('inert'); c.removeAttribute('aria-hidden'); }
      opener?.focus?.(); // return focus to the row/button that opened the modal
    };
  }, []);

  const isLive = ladder?.mode === 'live';
  const armPhrase = `arm ${ladderId.slice(0, 8)}`;
  const phraseOk = !isLive || typed.trim().toLowerCase() === armPhrase;

  // Distinct coins (probe each) + the primary coin to chart (the one with the most rungs).
  const coins = useMemo(() => Array.from(new Set((ladder?.rungs ?? []).map((r) => r.coin.toUpperCase()))), [ladder]);
  const primaryCoin = useMemo(() => {
    const rungs = ladder?.rungs ?? [];
    if (rungs.length === 0) return null;
    const counts = new Map<string, number>();
    for (const r of rungs) counts.set(r.coin.toUpperCase(), (counts.get(r.coin.toUpperCase()) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }, [ladder]);

  // §3.5 aggregate risk preview (render-pure; the server re-validates at arm).
  const risk = useMemo(() => {
    if (!ladder) return null;
    return computeLadderRisk(ladder.rungs.map(resolveArmRung), { maxTotalNotionalUsd: ladder.maxTotalNotionalUsd, maxTotalLossUsd: ladder.maxTotalLossUsd });
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
  async function archive(): Promise<void> {
    if (await post('/api/cockpit/ladder/archive', { ladderId })) { onChanged?.(); onClose(); }
  }
  function copyPhrase(): void {
    void navigator.clipboard?.writeText(armPhrase).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => {});
  }

  const breachCount = risk?.breaches.length ?? 0;
  const armReady = !busy && phraseOk && breachCount === 0;
  // Why the Arm button is disabled — surfaced IN the sticky footer (the breach list lives
  // higher in the scroll body and can be off-screen, so a disabled button looked unexplained).
  const blockReason = busy
    ? null
    : breachCount > 0
      ? `Can't arm — ${breachCount} blocking risk ${breachCount === 1 ? 'issue' : 'issues'}: ${risk?.breaches[0] ?? ''}`
      : isLive && !phraseOk
        ? 'Type the confirmation phrase exactly to enable.'
        : null;
  if (typeof document === 'undefined') return null; // portal target only exists client-side

  return createPortal(
    <div ref={overlayRef} role="presentation" onKeyDown={onKeyDown}
      onClick={(e) => { if (e.target === overlayRef.current && !busy) onClose(); }}
      className={css({ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: { base: 'flex-end', md: 'center' }, justifyContent: 'center', padding: { base: '0', md: '16px' }, overflowY: 'auto' })}
      style={{ background: 'rgba(4,6,10,.65)', backdropFilter: 'blur(3px)' }}>

      {/* Hidden live-mark probes — one per distinct coin (proximity is live for every rung). */}
      {coins.map((c) => <MarkProbe key={c} coin={c} onPx={reportPx} />)}

      <section ref={dialogRef} data-testid="ladder-detail-modal" role="dialog" aria-modal="true" aria-label="Ladder detail"
        className={css({ width: '100%', maxWidth: { base: '100%', md: '680px' }, maxHeight: '94vh', overflowY: 'auto', borderRadius: { base: '16px 16px 0 0', md: '16px' }, display: 'flex', flexDirection: 'column' })}
        style={{ background: '#0e131c', border: '1px solid rgba(255,255,255,.12)', boxShadow: '0 30px 80px rgba(0,0,0,.6)' }}>

        {/* Header */}
        <header className={css({ display: 'flex', alignItems: 'center', gap: '11px', padding: '18px 22px', borderBottom: '1px solid token(colors.github.border)', position: 'sticky', top: 0, zIndex: 2 })} style={{ background: '#0e131c' }}>
          <h2 className={css({ fontFamily: 'sans', fontSize: '14px', fontWeight: 'bold', color: 'github.textBright', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })}>{ladder?.title ?? 'Ladder'}</h2>
          {ladder && (
            <>
              <span className={css({ fontFamily: 'mono', fontSize: '10px', fontWeight: 'bold', borderRadius: '5px', paddingX: '8px', paddingY: '4px' })}
                style={{ background: isLive ? 'rgba(248,81,73,.16)' : 'rgba(255,255,255,.06)', color: isLive ? ZONE_COLORS.danger : GH.textMuted }}>{ladder.mode.toUpperCase()}</span>
              {(() => {
                const exp = expiryReadout(ladder.expiresAt, now);
                return exp ? (
                  <span data-testid="ladder-detail-expiry" title={ladder.expiresAt ? `Authorization expires ${new Date(ladder.expiresAt).toLocaleString()}` : undefined}
                    className={css({ fontFamily: 'mono', fontSize: '10px', fontWeight: 'bold', borderRadius: '5px', paddingX: '7px', paddingY: '4px' })}
                    style={{ background: exp.urgency === 'expired' ? 'rgba(242,77,94,.16)' : exp.urgency === 'warn' ? 'rgba(217,164,65,.14)' : 'rgba(255,255,255,.06)', color: exp.urgency === 'expired' ? ZONE_COLORS.danger : exp.urgency === 'warn' ? ZONE_COLORS.warn : GH.textMuted }}>⏱ {exp.text}</span>
                ) : null;
              })()}
              {ladder.ocoGroupId && (
                <span data-testid="ladder-oco-badge" title="OCO — the first leg of this straddle to fire auto-disarms the other" className={css({ fontFamily: 'mono', fontSize: '10px', fontWeight: 'bold', borderRadius: '5px', paddingX: '7px', paddingY: '4px' })} style={{ background: 'rgba(91,140,255,.14)', color: TERM.accent }}>⇄ OCO</span>
              )}
              <span className={css({ fontFamily: 'mono', fontSize: '10.5px', fontWeight: 'semibold', textTransform: 'uppercase', letterSpacing: '0.06em' })} style={{ color: STATUS_COLOR[ladder.status] }}>{ladder.status}</span>
            </>
          )}
          <button ref={closeRef} type="button" data-testid="ladder-detail-close" aria-label="Close" onClick={onClose} disabled={busy}
            className={css({ width: '28px', height: '28px', borderRadius: '7px', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,255,255,0.1)', _disabled: { opacity: 0.5 } })}
            style={{ background: TERM.button, color: GH.textMuted }}>✕</button>
        </header>

        <div className={css({ padding: '16px 22px', overflowY: 'auto' })}>
          {error && <p data-testid="ladder-detail-error" className={css({ fontSize: 'xs', color: 'zone.danger', marginBottom: '12px' })}>{error}</p>}
          {!ladder && !error && <p className={css({ fontFamily: 'mono', fontSize: '12px', color: 'github.textMuted' })}>Loading…</p>}

          {ladder && (() => {
            const firedCount = ladder.rungs.filter((r) => r.status === 'fired').length;
            const isComplete = ladder.status === 'done';
            const showBanner = isComplete || firedCount > 0;
            return (
            <>
              {/* COMPLETION — prominent when rungs have fired / the plan is done. A fully-fired
                  ladder is finished: the position lives in Open Positions with its resting stop. */}
              {showBanner && (
                <div data-testid="ladder-complete-banner" className={css({ display: 'flex', alignItems: 'flex-start', gap: '10px', borderRadius: '10px', padding: '11px 14px', marginBottom: '14px' })} style={{ background: 'rgba(25,201,138,.10)', border: '1px solid rgba(25,201,138,.35)' }}>
                  <span aria-hidden className={css({ fontFamily: 'mono', fontSize: '15px', fontWeight: 'bold', lineHeight: 1.1 })} style={{ color: ZONE_COLORS.ok }}>✓</span>
                  <div className={css({ display: 'flex', flexDirection: 'column', gap: '2px' })}>
                    <span className={css({ fontFamily: 'sans', fontSize: '12.5px', fontWeight: 'bold', color: 'github.textBright' })}>{isComplete ? 'Ladder complete' : 'Rung fired'}</span>
                    <span className={css({ fontFamily: 'mono', fontSize: '10.5px', lineHeight: 1.45, color: 'github.textMuted' })}>
                      {firedCount} of {ladder.rungs.length} rung{ladder.rungs.length === 1 ? '' : 's'} fired — your position is live in <strong className={css({ color: 'github.text' })}>Open Positions</strong> with its resting stop.{isComplete ? ' Nothing more will fire.' : ''}
                    </span>
                  </div>
                </div>
              )}

              {ladder.thesis && <p className={css({ fontFamily: 'sans', fontSize: '12px', color: 'github.textMuted', marginBottom: '14px', lineHeight: 1.5 })}>{ladder.thesis}</p>}

              {ladder.ocoGroupId && (
                <p className={css({ fontFamily: 'mono', fontSize: '10.5px', borderRadius: '8px', padding: '8px 11px', marginBottom: '14px', lineHeight: 1.45 })} style={{ background: 'rgba(91,140,255,.08)', border: '1px solid rgba(91,140,255,.2)', color: GH.text }}>
                  ⇄ <strong>OCO straddle</strong> — linked to a sibling ladder. The first leg to fire auto-disarms the other, so a whipsaw cannot open both sides. Arm both legs to be positioned for a move either way.
                </p>
              )}

              {/* WHERE — the chart with every rung's levels overlaid + the live mark. */}
              {primaryCoin && (
                <div className={css({ marginBottom: '16px' })}>
                  <LadderChart coin={primaryCoin} rungs={ladder.rungs} lastPx={marks[primaryCoin] ?? null} />
                  <p className={css({ fontFamily: 'mono', fontSize: '9.5px', color: 'github.textMuted', marginTop: '6px', lineHeight: 1.4 })}>
                    Levels are at the trigger; a rung fills at the 15m candle <em>close</em> (may overshoot). Dollar risk &amp; notional are fixed.
                    {coins.length > 1 && ` · Chart shows ${primaryCoin} only — other coins' rungs are listed below.`}
                  </p>
                </div>
              )}

              {/* WHAT + HOW CLOSE — a rich card per rung. */}
              <FieldLabel>Rungs ({ladder.rungs.length})</FieldLabel>
              <div className={css({ display: 'flex', flexDirection: 'column', gap: '9px', marginTop: '8px', marginBottom: '16px' })}>
                {ladder.rungs.map((r) => <RungCard key={r.id} rung={r} markPx={marks[r.coin.toUpperCase()] ?? null} />)}
              </div>

              {/* WORST CASE — the aggregate §3.5 read. */}
              {risk && (
                <div data-testid="ladder-detail-risk" className={css({ borderRadius: '11px', padding: '6px 16px', marginBottom: '14px' })} style={{ background: TERM.inset, border: '1px solid token(colors.github.border)' }}>
                  <div className={css({ fontFamily: 'sans', fontSize: '10px', fontWeight: 'semibold', textTransform: 'uppercase', letterSpacing: '0.12em', padding: '8px 0 4px', color: 'github.textMuted' })}>Worst case · all stops slip at once (no netting)</div>
                  <SummaryRow label="Worst-case loss" value={fmtUsd(-Math.abs(risk.aggregateWorstCaseLossUsd))} color={ZONE_COLORS.danger} />
                  <SummaryRow label="Total notional" value={risk.totalNotionalUsd > 0 ? fmtCompactUsd(risk.totalNotionalUsd) : '—'} color={GH.textBright} />
                  <SummaryRow label="Total margin" value={risk.totalMarginUsd > 0 ? fmtUsd(risk.totalMarginUsd).replace('+', '') : '—'} color={GH.textBright} />
                  {risk.perCoin.map((c) => <SummaryRow key={`${c.coin}-${c.side}`} label={`${c.coin} ${c.side} liq @ max`} value={c.aggregateLiqPx == null ? '—' : fmtPx(c.aggregateLiqPx)} color={GH.text} />)}
                  <SummaryRow label="Caps" value={`${ladder.maxTotalNotionalUsd ? fmtCompactUsd(ladder.maxTotalNotionalUsd) : '—'} / ${ladder.maxTotalLossUsd ? fmtUsd(ladder.maxTotalLossUsd).replace('+', '') : '—'} loss`} color={GH.textMuted} />
                  <SummaryRow label="Authorization expires" value={ladder.expiresAt ? new Date(ladder.expiresAt).toLocaleString() : '—'} color={GH.textMuted} last />
                </div>
              )}
              {risk && risk.breaches.length > 0 && (
                <ul className={css({ marginBottom: '14px', display: 'flex', flexDirection: 'column', gap: '5px' })}>
                  {risk.breaches.map((b, i) => <li key={i} className={css({ fontFamily: 'mono', fontSize: '10.5px', lineHeight: 1.4, paddingLeft: '14px', position: 'relative' })} style={{ color: ZONE_COLORS.warn }}><span aria-hidden className={css({ position: 'absolute', left: 0 })}>⚠</span>{b}</li>)}
                </ul>
              )}
            </>
            );
          })()}
        </div>

        {/* Action footer — the consent surface (+ archive for terminal/draft ladders).
            An already-archived ladder is read-only (audit view) → no footer. */}
        {ladder && !ladder.archivedAt && (
          <div className={css({ padding: '14px 22px 18px', borderTop: '1px solid rgba(255,255,255,.07)', position: 'sticky', bottom: 0 })} style={{ background: '#0e131c' }}>
            {ladder.status === 'armed' ? (
              <button type="button" data-testid="ladder-detail-disarm" disabled={busy} onClick={() => void disarm()}
                className={css({ width: '100%', fontFamily: 'sans', fontSize: '13.5px', fontWeight: 'bold', borderRadius: '9px', padding: '13px', cursor: 'pointer', border: '1px solid rgba(248,81,73,.4)', _disabled: { opacity: 0.6 } })}
                style={{ background: 'rgba(248,81,73,.12)', color: ZONE_COLORS.danger }}>{busy ? 'Disarming…' : 'Disarm'}</button>
            ) : ladder.status === 'draft' ? (
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
                {blockReason && (
                  <div data-testid="ladder-arm-blocked" role="status" className={css({ marginBottom: '10px', fontFamily: 'sans', fontSize: '11.5px', lineHeight: 1.45, borderRadius: '8px', padding: '9px 11px' })} style={{ background: 'rgba(210,153,34,.10)', border: '1px solid rgba(210,153,34,.35)', color: ZONE_COLORS.warn }}>
                    {blockReason}
                  </div>
                )}
                <button type="button" data-testid="ladder-detail-arm" disabled={!armReady} onClick={() => void arm()}
                  style={{ background: armReady ? (isLive ? ZONE_COLORS.danger : ZONE_COLORS.ok) : TERM.button, color: armReady ? (isLive ? '#fff' : TERM.darkText) : GH.textMuted }}
                  className={css({ width: '100%', border: 'none', borderRadius: '9px', fontFamily: 'sans', fontSize: '13.5px', fontWeight: 'bold', letterSpacing: '0.03em', padding: '13px', cursor: 'pointer', _disabled: { opacity: 0.6, cursor: 'not-allowed' } })}>
                  {busy ? 'Arming…' : isLive ? 'Arm LIVE →' : 'Arm →'}
                </button>
                <button type="button" data-testid="ladder-detail-archive" disabled={busy} onClick={() => void archive()}
                  className={css({ width: '100%', marginTop: '8px', fontFamily: 'sans', fontSize: '12px', fontWeight: 'semibold', borderRadius: '9px', padding: '10px', cursor: 'pointer', border: '1px solid rgba(255,255,255,.1)', _disabled: { opacity: 0.6 } })}
                  style={{ background: 'transparent', color: GH.textMuted }}>{busy ? '…' : 'Discard draft (archive)'}</button>
              </>
            ) : (
              // disarmed / done / expired → archive (hide; the row stays in the DB for audit)
              <button type="button" data-testid="ladder-detail-archive" disabled={busy} onClick={() => void archive()}
                className={css({ width: '100%', fontFamily: 'sans', fontSize: '13px', fontWeight: 'semibold', borderRadius: '9px', padding: '12px', cursor: 'pointer', border: '1px solid rgba(255,255,255,.12)', _disabled: { opacity: 0.6 } })}
                style={{ background: TERM.button, color: GH.text }}>{busy ? 'Archiving…' : '🗄 Archive — hide (keeps audit history)'}</button>
            )}
          </div>
        )}
      </section>
    </div>,
    document.body,
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className={css({ fontFamily: 'sans', fontSize: '10.5px', fontWeight: 'semibold', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block' })} style={{ color: '#9aa4b5' }}>{children}</span>;
}

/** One rung as a rich card: header (side/action/status) → the trigger + live distance →
 *  a label-above-value metric grid grouped risk (red) / reward (green). */
function RungCard({ rung, markPx }: { rung: LadderRung; markPx: number | null }) {
  const long = rung.side === 'long';
  const p = projectRung(rung);
  const st = RUNG_STATUS[rung.status];
  const dir = rung.triggerKind === 'price_above' ? '▲' : rung.triggerKind === 'price_below' ? '▼' : '•';
  const prox = rung.status === 'pending' ? rungProximity(rung, markPx) : null;
  const sideBg = long ? 'rgba(25,201,138,.14)' : 'rgba(242,77,94,.14)';
  const sideColor = long ? ZONE_COLORS.ok : ZONE_COLORS.danger;
  const hasTarget = p.targetPx != null;

  return (
    <div data-testid={`rung-card-${rung.id}`} className={css({ borderRadius: '11px', padding: '13px 15px' })} style={{ background: TERM.inset, border: '1px solid token(colors.github.border)' }}>
      {/* Header row */}
      <div className={css({ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '11px' })}>
        <span className={css({ fontFamily: 'mono', fontSize: '10.5px', color: 'github.textMuted', flex: 'none' })}>#{rung.seq}</span>
        <span className={css({ fontFamily: 'mono', fontSize: '11px', fontWeight: 'bold', borderRadius: '5px', paddingX: '7px', paddingY: '3px', flex: 'none' })} style={{ background: sideBg, color: sideColor }}>{rung.coin} {long ? 'LONG' : 'SHORT'}</span>
        <span className={css({ fontFamily: 'mono', fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '0.06em', flex: 1 })} style={{ color: rung.action === 'stop_move' ? '#e3b341' : undefined }}>
          <span className={css({ color: rung.action === 'stop_move' ? undefined : 'github.textMuted' })}>{rung.action === 'stop_move' ? '🔒 stop ratchet' : rung.action}</span>
        </span>
        <span data-testid={`rung-card-status-${rung.id}`} className={css({ fontFamily: 'mono', fontSize: '10px', fontWeight: 'bold', letterSpacing: '0.06em', borderRadius: '4px', paddingX: '6px', paddingY: '2px', flex: 'none' })}
          style={{ color: prox?.primed ? ZONE_COLORS.ok : st.color, background: prox?.primed ? 'rgba(25,201,138,.12)' : 'rgba(255,255,255,.04)' }}>{prox?.primed ? '● PRIMED' : st.label}</span>
      </div>

      {/* WHERE + WHEN — the trigger and the live distance to it (the headline of the card). */}
      <div className={css({ display: 'flex', alignItems: 'baseline', gap: '9px', flexWrap: 'wrap', marginBottom: '12px' })}>
        <span className={css({ fontFamily: 'sans', fontSize: '9.5px', fontWeight: 'semibold', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'github.textMuted', flex: 'none' })}>Fires at</span>
        <span className={css({ fontFamily: 'mono', fontSize: '15px', fontWeight: 'bold', color: 'github.textBright' })} style={{ fontFeatureSettings: '"tnum"' }}>
          {rung.triggerPx != null ? `${dir} ${fmtPx(rung.triggerPx)}` : rung.triggerKind}
        </span>
        {prox ? (
          <span data-testid={`rung-card-prox-${rung.id}`} className={css({ fontFamily: 'mono', fontSize: '11px', fontWeight: 'semibold' })} style={{ color: prox.primed ? ZONE_COLORS.ok : ZONE_COLORS.warn, fontFeatureSettings: '"tnum"' }}>
            {prox.primed
              ? `${markPx != null ? `${rung.coin} ${fmtPx(markPx)} · ` : ''}● through — fires only if this 15m candle CLOSES past`
              : `${markPx != null ? `${rung.coin} ${fmtPx(markPx)} · ` : ''}needs ${prox.direction === 'up' ? '+' : '−'}${(prox.pct * 100).toFixed(2)}% to ${fmtPx(prox.toPx)}`}
          </span>
        ) : rung.status === 'fired' ? (
          <span className={css({ fontFamily: 'mono', fontSize: '11px', color: 'github.textMuted' })}>→ now live in Open Positions</span>
        ) : null}
      </div>

      {/* WHAT — the projected trade, label-above-value so every figure is legible. */}
      <div className={css({ display: 'grid', gridTemplateColumns: { base: 'repeat(2, 1fr)', sm: 'repeat(3, 1fr)' }, gap: '11px 14px', paddingTop: '11px', borderTop: '1px solid rgba(255,255,255,.06)' })}>
        <Cell label="Size" value={p.sizeCoins != null ? `${p.sizeCoins.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${rung.coin}` : '—'} />
        <Cell label="Notional" value={p.notionalUsd != null ? fmtCompactUsd(p.notionalUsd) : '—'} />
        <Cell label="Leverage" value={p.leverage != null ? `${p.leverage}×` : '—'} />
        <Cell label="Stop" value={p.stopPx != null ? `${fmtPx(p.stopPx)}${p.stopPct != null ? ` ${fmtPctSigned(-p.stopPct * 100)}` : ''}` : '—'} valueColor={p.stopPx != null ? ZONE_COLORS.danger : undefined} />
        <Cell label="Risk at stop" value={p.riskUsd != null ? fmtUsd(-p.riskUsd) : '—'} valueColor={p.riskUsd != null ? ZONE_COLORS.danger : undefined} />
        <Cell label="If stop slips" value={p.slippedRiskUsd != null ? fmtUsd(-p.slippedRiskUsd) : '—'} valueColor={p.slippedRiskUsd != null ? ZONE_COLORS.danger : undefined} />
        <Cell label="Target" value={hasTarget ? `${fmtPx(p.targetPx)}${p.targetPct != null ? ` ${fmtPctSigned(p.targetPct * 100)}` : ''}` : 'none'} valueColor={hasTarget ? ZONE_COLORS.ok : GH.textMuted} />
        <Cell label="Reward" value={p.rewardUsd != null ? fmtUsd(p.rewardUsd) : '—'} valueColor={p.rewardUsd != null ? ZONE_COLORS.ok : undefined} />
        <Cell label="R : R (ideal)" value={p.rrRatio != null ? `${p.rrRatio.toFixed(1)} R` : '—'} />
      </div>

      {!hasTarget && (
        <p className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted', marginTop: '10px' })}>Stop-only — no take-profit target; exit is manual or by a later rung.</p>
      )}
    </div>
  );
}

/** A metric: a small uppercase label ABOVE a mono value (reads cleaner + more legible than
 *  a cramped label-left/value-right row; label uses the ≥4.5:1 muted color, not faint). */
function Cell({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 })}>
      <span className={css({ fontFamily: 'sans', fontSize: '9.5px', fontWeight: 'semibold', textTransform: 'uppercase', letterSpacing: '0.07em', color: 'github.textMuted' })}>{label}</span>
      {/* Wrap on mobile (narrow 2-col cells) so a value like "$1,682 −5.00%" is never
          truncated away; single-line + ellipsis only on the wider sm+ 3-col grid. */}
      <span className={css({ fontFamily: 'mono', fontSize: '12px', color: 'github.textBright', overflow: 'hidden', textOverflow: { base: 'clip', sm: 'ellipsis' }, whiteSpace: { base: 'normal', sm: 'nowrap' } })} style={{ color: valueColor, fontFeatureSettings: '"tnum"' }}>{value}</span>
    </div>
  );
}
