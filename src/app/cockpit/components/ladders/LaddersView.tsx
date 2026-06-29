'use client';

/**
 * LaddersView — the 'ladders' cockpit surface. Lists the operator's armed-ladder plans
 * and opens the LadderBuilderModal to author + preview + arm a new one. Read path is the
 * admin-authed GET /api/cockpit/ladder; the modal owns create + arm. Nothing fires from
 * here — the watcher / fire-rung (gated, P1d) executes armed rungs.
 */

import { useCallback, useEffect, useState } from 'react';
import { css } from '@styled-system/css';
import { GH, ZONE_COLORS, TERM } from '../panel-styles';
import LadderBuilderModal from './LadderBuilderModal';
import type { Ladder } from '@/lib/ladder/ladder-types';

const STATUS_COLOR: Record<Ladder['status'], string> = {
  draft: GH.textMuted,
  armed: ZONE_COLORS.ok,
  disarmed: ZONE_COLORS.warn,
  done: GH.textMuted,
  expired: GH.textMuted,
};

export interface LaddersViewProps {
  /** The cockpit's current coin (seeds a new ladder's first rung). */
  coin?: string;
}

export default function LaddersView({ coin = 'ETH' }: LaddersViewProps) {
  const [ladders, setLadders] = useState<Ladder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  // Inline arm for an existing DRAFT row: which ladder is being armed + the typed phrase.
  const [armingId, setArmingId] = useState<string | null>(null);
  const [armPhrase, setArmPhrase] = useState('');
  const [armBusy, setArmBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/cockpit/ladder', { cache: 'no-store' });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; ladders?: Ladder[]; error?: string };
      if (!res.ok || json.ok === false) { setError(json.error ?? `Failed (${res.status})`); return; }
      setLadders(json.ladders ?? []);
      setError(null);
    } catch { setError('Network error — retry.'); }
  }, []);

  const disarm = useCallback(async (id: string) => {
    try {
      const res = await fetch('/api/cockpit/ladder/disarm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ladderId: id }) });
      if (!res.ok) { const j = (await res.json().catch(() => ({}))) as { error?: string }; setError(j.error ?? `Disarm failed (${res.status})`); return; }
      await load();
    } catch { setError('Network error — retry.'); }
  }, [load]);

  const arm = useCallback(async (l: Ladder) => {
    setArmBusy(true);
    try {
      const res = await fetch('/api/cockpit/ladder/arm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ladderId: l.id, confirmPhrase: l.mode === 'live' ? armPhrase : undefined }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; warnings?: string[] };
      if (!res.ok || j.ok === false) { setError(j.warnings?.join(' ') ?? j.error ?? `Arm failed (${res.status})`); setArmBusy(false); return; }
      setArmingId(null); setArmPhrase(''); setArmBusy(false);
      await load();
    } catch { setError('Network error — retry.'); setArmBusy(false); }
  }, [armPhrase, load]);

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
      <p className={css({ fontFamily: 'mono', fontSize: '11px', color: 'cockpit.faint', marginBottom: '18px' })}>
        Pre-authorized multi-rung plans. Arming authorizes; autonomous firing stays off until enabled.
      </p>

      {error && <p data-testid="ladders-error" className={css({ fontSize: 'xs', color: 'zone.danger', marginBottom: '12px' })}>{error}</p>}

      {ladders == null ? (
        // Only "Loading" before the first response — on an error the message above
        // stands alone (don't show a perpetual spinner when the fetch already failed).
        error ? null : <p className={css({ fontFamily: 'mono', fontSize: '12px', color: 'cockpit.faint' })}>Loading…</p>
      ) : ladders.length === 0 ? (
        <div data-testid="ladders-empty" className={css({ borderRadius: '12px', padding: '32px', textAlign: 'center' })} style={{ background: TERM.inset, border: '1px dashed rgba(255,255,255,.1)' }}>
          <p className={css({ fontFamily: 'sans', fontSize: '14px', color: 'github.text', marginBottom: '6px' })}>No ladders yet</p>
          <p className={css({ fontFamily: 'mono', fontSize: '11px', color: 'cockpit.faint' })}>Build a multi-rung plan, preview its worst-case risk, and arm it.</p>
        </div>
      ) : (
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '8px' })}>
          {ladders.map((l) => (
            <div key={l.id} data-testid={`ladder-row-${l.id}`} className={css({ display: 'flex', alignItems: 'center', gap: '12px', borderRadius: '10px', padding: '13px 16px' })} style={{ background: TERM.inset, border: '1px solid token(colors.github.border)' }}>
              <span className={css({ fontFamily: 'sans', fontSize: '13.5px', fontWeight: 'semibold', color: 'github.textBright', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })}>{l.title}</span>
              <span className={css({ fontFamily: 'mono', fontSize: '10px', fontWeight: 'bold', borderRadius: '5px', paddingX: '7px', paddingY: '3px' })}
                style={{ background: l.mode === 'live' ? 'rgba(248,81,73,.16)' : 'rgba(255,255,255,.06)', color: l.mode === 'live' ? ZONE_COLORS.danger : GH.textMuted }}>{l.mode.toUpperCase()}</span>
              <span data-testid={`ladder-status-${l.id}`} className={css({ fontFamily: 'mono', fontSize: '11px', fontWeight: 'semibold', textTransform: 'uppercase', letterSpacing: '0.06em', minWidth: '64px', textAlign: 'right' })} style={{ color: STATUS_COLOR[l.status] }}>{l.status}</span>
              {l.status === 'armed' && (
                <button type="button" data-testid={`ladder-disarm-${l.id}`} onClick={() => void disarm(l.id)}
                  className={css({ fontFamily: 'mono', fontSize: '10.5px', fontWeight: 'semibold', borderRadius: '6px', paddingX: '10px', paddingY: '5px', cursor: 'pointer', flex: 'none' })}
                  style={{ background: 'rgba(248,81,73,.12)', color: ZONE_COLORS.danger, border: '1px solid rgba(248,81,73,.3)' }}>Disarm</button>
              )}
              {l.status === 'draft' && armingId !== l.id && (
                <button type="button" data-testid={`ladder-arm-${l.id}`} onClick={() => { setArmingId(l.id); setArmPhrase(''); setError(null); }}
                  className={css({ fontFamily: 'mono', fontSize: '10.5px', fontWeight: 'semibold', borderRadius: '6px', paddingX: '12px', paddingY: '5px', cursor: 'pointer', flex: 'none' })}
                  style={{ background: ZONE_COLORS.ok, color: TERM.darkText, border: 'none' }}>Arm</button>
              )}
              {l.status === 'draft' && armingId === l.id && (
                <div className={css({ display: 'flex', alignItems: 'center', gap: '6px', flex: 'none' })}>
                  {l.mode === 'live' && (
                    <input data-testid={`ladder-arm-phrase-${l.id}`} value={armPhrase} onChange={(e) => setArmPhrase(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false}
                      placeholder={`arm ${l.id.slice(0, 8)}`}
                      className={css({ borderRadius: '6px', color: 'github.textBright', fontFamily: 'mono', fontSize: '11px', padding: '5px 8px', width: '120px' })} style={{ background: TERM.inset, border: '1px solid rgba(248,81,73,.35)' }} />
                  )}
                  <button type="button" data-testid={`ladder-arm-confirm-${l.id}`} disabled={armBusy || (l.mode === 'live' && armPhrase.trim().toLowerCase() !== `arm ${l.id.slice(0, 8)}`)} onClick={() => void arm(l)}
                    className={css({ fontFamily: 'mono', fontSize: '10.5px', fontWeight: 'bold', borderRadius: '6px', paddingX: '10px', paddingY: '5px', cursor: 'pointer', border: 'none', _disabled: { opacity: 0.5, cursor: 'not-allowed' } })}
                    style={{ background: l.mode === 'live' ? ZONE_COLORS.danger : ZONE_COLORS.ok, color: l.mode === 'live' ? '#fff' : TERM.darkText }}>{armBusy ? '…' : l.mode === 'live' ? 'Arm LIVE' : 'Arm'}</button>
                  <button type="button" aria-label="Cancel arm" onClick={() => { setArmingId(null); setArmPhrase(''); }}
                    className={css({ fontFamily: 'mono', fontSize: '11px', color: 'github.textMuted', bg: 'transparent', border: 'none', cursor: 'pointer' })}>✕</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {building && <LadderBuilderModal coin={coin} onClose={() => setBuilding(false)} onArmed={() => { setBuilding(false); void load(); }} />}
    </div>
  );
}
