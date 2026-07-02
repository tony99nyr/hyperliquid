'use client';

/**
 * LaddersView — the 'ladders' cockpit surface. Lists the operator's ladder plans as thin,
 * CLICKABLE rows; clicking one opens LadderDetailModal to REVIEW the plan + risk and then
 * arm/disarm (the phrase-visible consent surface). "New Ladder" opens the builder. Read
 * path is the admin-authed GET /api/cockpit/ladder; nothing fires from here.
 */

import { useCallback, useEffect, useState } from 'react';
import { css } from '@styled-system/css';
import { GH, ZONE_COLORS, TERM } from '../panel-styles';
import LadderBuilderModal from './LadderBuilderModal';
import LadderDetailModal from './LadderDetailModal';
import { expiryReadout } from '@/lib/ladder/ladder-projection-business-logic';
import { useNow } from '@/hooks/useNow';
import type { Ladder } from '@/lib/ladder/ladder-types';

const STATUS_COLOR: Record<Ladder['status'], string> = {
  draft: GH.textMuted,
  armed: ZONE_COLORS.ok,
  disarmed: ZONE_COLORS.warn,
  done: ZONE_COLORS.ok, // fully executed (all rungs fired) — a positive terminal state
  expired: GH.textMuted,
};

/** Status label — 'done' reads as "✓ filled" so a completed ladder is obvious in the list. */
const STATUS_LABEL: Partial<Record<Ladder['status'], string>> = { done: '✓ filled' };

export interface LaddersViewProps {
  /** The cockpit's current coin (seeds a new ladder's first rung). */
  coin?: string;
}

export default function LaddersView({ coin = 'ETH' }: LaddersViewProps) {
  const [ladders, setLadders] = useState<Ladder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  // The audit view: archived ladders are hidden by default; this toggle shows them (read-only).
  const [showArchived, setShowArchived] = useState(false);
  // Render-safe ticking clock for the expiry chips.
  const now = useNow();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/cockpit/ladder${showArchived ? '?archived=1' : ''}`, { cache: 'no-store' });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; ladders?: Ladder[]; error?: string };
      if (!res.ok || json.ok === false) { setError(json.error ?? `Failed (${res.status})`); return; }
      setLadders(json.ladders ?? []);
      setError(null);
    } catch { setError('Network error — retry.'); }
  }, [showArchived]);

  // Defer the initial load out of the effect's synchronous body (its setState would
  // otherwise trip react-hooks/set-state-in-effect — the cascading-render guard).
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  return (
    <div className={css({ maxWidth: '900px', margin: '0 auto', padding: { base: '16px', md: '24px' } })}>
      <div className={css({ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '4px' })}>
        <h1 className={css({ fontFamily: 'sans', fontSize: '18px', fontWeight: 'bold', color: 'github.textBright', letterSpacing: '0.02em' })}>Armed Ladders</h1>
        <button type="button" data-testid="ladder-new" onClick={() => setBuilding(true)}
          className={css({ fontFamily: 'sans', fontSize: '12.5px', fontWeight: 'semibold', borderRadius: '8px', padding: '8px 16px', border: 'none', cursor: 'pointer' })}
          style={{ background: ZONE_COLORS.ok, color: TERM.darkText }}>+ New Ladder</button>
      </div>
      <div className={css({ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', marginBottom: '18px' })}>
        <p className={css({ fontFamily: 'mono', fontSize: '11px', color: 'cockpit.faint' })}>
          {showArchived ? 'Archived ladders (audit history — read-only).' : 'Pre-authorized multi-rung plans. Click a ladder to review + arm it.'}
        </p>
        <button type="button" data-testid="ladders-toggle-archived" onClick={() => { setLadders(null); setShowArchived((v) => !v); }}
          className={css({ fontFamily: 'mono', fontSize: '10.5px', fontWeight: 'semibold', borderRadius: '6px', padding: '5px 10px', cursor: 'pointer', border: '1px solid rgba(255,255,255,.12)', flex: 'none', _hover: { borderColor: 'rgba(91,140,255,.5)' } })}
          style={{ background: TERM.button, color: showArchived ? TERM.accent : GH.textMuted }}>{showArchived ? '← active' : '🗄 archived'}</button>
      </div>

      {error && <p data-testid="ladders-error" className={css({ fontSize: 'xs', color: 'zone.danger', marginBottom: '12px' })}>{error}</p>}

      {ladders == null ? (
        error ? null : <p className={css({ fontFamily: 'mono', fontSize: '12px', color: 'cockpit.faint' })}>Loading…</p>
      ) : ladders.length === 0 ? (
        <div data-testid="ladders-empty" className={css({ borderRadius: '12px', padding: '32px', textAlign: 'center' })} style={{ background: TERM.inset, border: '1px dashed rgba(255,255,255,.1)' }}>
          <p className={css({ fontFamily: 'sans', fontSize: '14px', color: 'github.text', marginBottom: '6px' })}>{showArchived ? 'No archived ladders' : 'No ladders yet'}</p>
          <p className={css({ fontFamily: 'mono', fontSize: '11px', color: 'cockpit.faint' })}>{showArchived ? 'Archived ladders are hidden from the active list but kept for audit.' : 'Build a multi-rung plan, preview its worst-case risk, and arm it.'}</p>
        </div>
      ) : (
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '8px' })}>
          {ladders.map((l) => {
            // The authorization clock — shown for the states where it still matters.
            const exp = l.status === 'armed' || l.status === 'draft' ? expiryReadout(l.expiresAt, now) : null;
            return (
            <button key={l.id} type="button" data-testid={`ladder-row-${l.id}`} onClick={() => setDetailId(l.id)} aria-label={`Review ${l.title}`}
              className={css({ display: 'flex', alignItems: 'center', gap: '12px', borderRadius: '10px', padding: '13px 16px', cursor: 'pointer', textAlign: 'left', width: '100%', transition: 'border-color .12s, background .12s', _hover: { borderColor: 'rgba(91,140,255,.5)' }, _focusVisible: { outline: '2px solid token(colors.github.link)', outlineOffset: '1px' } })}
              style={{ background: TERM.inset, border: '1px solid token(colors.github.border)' }}>
              <span className={css({ fontFamily: 'sans', fontSize: '13.5px', fontWeight: 'semibold', color: 'github.textBright', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })}>{l.title}</span>
              {exp && <span data-testid={`ladder-expiry-${l.id}`} className={css({ fontFamily: 'mono', fontSize: '9.5px', fontWeight: 'semibold', flex: 'none', display: { base: 'none', sm: 'inline' } })} style={{ color: exp.urgency === 'expired' ? ZONE_COLORS.danger : exp.urgency === 'warn' ? ZONE_COLORS.warn : GH.textMuted }}>{exp.text}</span>}
              {l.ocoGroupId && <span title="OCO — linked straddle (first to fire cancels the other)" className={css({ fontFamily: 'mono', fontSize: '9.5px', fontWeight: 'bold', borderRadius: '4px', paddingX: '5px', paddingY: '2px', flex: 'none' })} style={{ background: 'rgba(91,140,255,.14)', color: TERM.accent }}>⇄ OCO</span>}
              <span className={css({ fontFamily: 'mono', fontSize: '10px', fontWeight: 'bold', borderRadius: '5px', paddingX: '7px', paddingY: '3px', flex: 'none' })}
                style={{ background: l.mode === 'live' ? 'rgba(248,81,73,.16)' : 'rgba(255,255,255,.06)', color: l.mode === 'live' ? ZONE_COLORS.danger : GH.textMuted }}>{l.mode.toUpperCase()}</span>
              <span data-testid={`ladder-status-${l.id}`} className={css({ fontFamily: 'mono', fontSize: '11px', fontWeight: 'semibold', textTransform: 'uppercase', letterSpacing: '0.06em', minWidth: '64px', textAlign: 'right', flex: 'none' })} style={{ color: STATUS_COLOR[l.status] }}>{STATUS_LABEL[l.status] ?? l.status}</span>
              <span aria-hidden className={css({ fontFamily: 'mono', fontSize: '15px', color: 'cockpit.faint', flex: 'none' })}>›</span>
            </button>
            );
          })}
        </div>
      )}

      {building && <LadderBuilderModal coin={coin} onClose={() => setBuilding(false)} onArmed={() => { setBuilding(false); void load(); }} />}
      {detailId && <LadderDetailModal ladderId={detailId} onClose={() => setDetailId(null)} onChanged={() => { setDetailId(null); void load(); }} />}
    </div>
  );
}
