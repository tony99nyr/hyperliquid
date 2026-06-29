'use client';

/**
 * ArmedLaddersPanel — the cockpit decision-column view of ARMED ladders: what's primed
 * to fire autonomously, with the levels the operator wants on screen (entry trigger,
 * planned size, protective stop, leverage, status). Polls /api/cockpit/ladder
 * (armed + rungs) so a fire flips a rung from WAITING → ✓ FIRED live. Hidden when nothing
 * is armed so it never clutters the column. Read-only — manage from the Ladders tab.
 */

import { css } from '@styled-system/css';
import { GH, ZONE_COLORS, TERM, fmtPx } from './panel-styles';
import { usePolledEndpoint } from '@/hooks/usePolledEndpoint';
import { resolveArmRung } from '@/lib/ladder/ladder-arm-business-logic';
import type { LadderWithRungs, LadderRung } from '@/lib/ladder/ladder-types';

export interface ArmedLaddersPanelProps {
  /** The cockpit's current coin — its rungs are accented (their levels are on the chart). */
  coin?: string;
  /** Live mark of the current coin — drives the distance-to-trigger ("is it close?") line. */
  markPx?: number | null;
}

/** How far the mark is from a price trigger, as an operator-facing line. Null for
 *  non-price triggers or when the mark/coin doesn't apply. */
function proximity(rung: LadderRung, markPx: number | null | undefined): { text: string; armed: boolean } | null {
  if (markPx == null || !(markPx > 0) || rung.triggerPx == null) return null;
  if (rung.triggerKind === 'price_above') {
    if (markPx >= rung.triggerPx) return { text: 'above the level — fires on the next 15m close', armed: true };
    return { text: `needs +${(((rung.triggerPx - markPx) / markPx) * 100).toFixed(2)}% to ${fmtPx(rung.triggerPx)}`, armed: false };
  }
  if (rung.triggerKind === 'price_below') {
    if (markPx <= rung.triggerPx) return { text: 'below the level — fires on the next 15m close', armed: true };
    return { text: `needs −${(((markPx - rung.triggerPx) / markPx) * 100).toFixed(2)}% to ${fmtPx(rung.triggerPx)}`, armed: false };
  }
  return null;
}

const RUNG_STATUS: Record<LadderRung['status'], { label: string; color: string }> = {
  pending: { label: 'WAITING', color: ZONE_COLORS.warn },
  fired: { label: '✓ FIRED', color: ZONE_COLORS.ok },
  skipped: { label: 'SKIPPED', color: GH.textMuted },
  failed: { label: 'FAILED', color: ZONE_COLORS.danger },
  cancelled: { label: 'CANCELLED', color: GH.textMuted },
};

export default function ArmedLaddersPanel({ coin = 'ETH', markPx }: ArmedLaddersPanelProps) {
  const { data } = usePolledEndpoint<LadderWithRungs[]>(
    '/api/cockpit/ladder?status=armed&withRungs=1',
    true,
    (j) => (Array.isArray(j.ladders) ? (j.ladders as LadderWithRungs[]) : undefined),
    8000,
  );
  const ladders = (data ?? []).filter((l) => l.rungs.length > 0);
  if (ladders.length === 0) return null; // nothing armed → no panel

  return (
    <section data-testid="armed-ladders-panel" className={css({ borderRadius: '12px', padding: '12px 14px' })} style={{ background: TERM.inset, border: '1px solid token(colors.github.border)' }}>
      <div className={css({ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' })}>
        <span className={css({ width: '6px', height: '6px', borderRadius: '50%', flex: 'none' })} style={{ background: ZONE_COLORS.ok, boxShadow: `0 0 6px ${ZONE_COLORS.ok}` }} aria-hidden />
        <h3 className={css({ fontFamily: 'sans', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'github.textBright' })}>Armed Ladders</h3>
        <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'cockpit.faint' })}>{ladders.length} armed</span>
      </div>
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '10px' })}>
        {ladders.map((l) => (
          <div key={l.id}>
            <div className={css({ fontFamily: 'sans', fontSize: '11px', fontWeight: 'semibold', color: 'github.text', marginBottom: '5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })}>{l.title}</div>
            <div className={css({ display: 'flex', flexDirection: 'column', gap: '5px' })}>
              {l.rungs.map((r) => <RungRow key={r.id} rung={r} accent={r.coin.toUpperCase() === coin.toUpperCase()} markPx={r.coin.toUpperCase() === coin.toUpperCase() ? markPx : null} />)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function RungRow({ rung, accent, markPx }: { rung: LadderRung; accent: boolean; markPx?: number | null }) {
  const long = rung.side === 'long';
  const a = resolveArmRung(rung); // entry (= trigger), risk-sized size, derived stop
  const st = RUNG_STATUS[rung.status];
  const dir = rung.triggerKind === 'price_above' ? '▲' : rung.triggerKind === 'price_below' ? '▼' : '•';
  // "Is it close?" — only meaningful while still WAITING to trigger.
  const prox = rung.status === 'pending' ? proximity(rung, markPx) : null;
  return (
    <div data-testid={`armed-rung-${rung.id}`} className={css({ display: 'flex', flexDirection: 'column', gap: '5px', borderRadius: '8px', padding: '8px 10px' })}
      style={{ background: accent ? 'rgba(91,140,255,.06)' : 'rgba(255,255,255,.02)', border: `1px solid ${accent ? 'rgba(91,140,255,.22)' : 'rgba(255,255,255,.06)'}` }}>
      <div className={css({ display: 'flex', alignItems: 'center', gap: '8px' })}>
        <span className={css({ fontFamily: 'mono', fontSize: '10.5px', fontWeight: 'bold', borderRadius: '4px', paddingX: '6px', paddingY: '2px', flex: 'none' })} style={{ background: long ? 'rgba(63,185,80,.16)' : 'rgba(248,81,73,.16)', color: long ? ZONE_COLORS.ok : ZONE_COLORS.danger }}>{rung.coin} {long ? 'L' : 'S'}</span>
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '1px', flex: 1, minWidth: 0 })}>
          <span className={css({ fontFamily: 'mono', fontSize: '11px', color: 'github.textBright', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })} style={{ fontFeatureSettings: '"tnum"' }}>
            {rung.triggerPx != null ? `${dir} ${fmtPx(rung.triggerPx)}` : rung.triggerKind} {rung.action !== 'open' && `· ${rung.action}`}
          </span>
          <span className={css({ fontFamily: 'mono', fontSize: '9.5px', color: 'cockpit.faint' })} style={{ fontFeatureSettings: '"tnum"' }}>
            {a.sizeCoins != null ? `${a.sizeCoins.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${rung.coin}` : '—'}
            {a.stopPx != null && ` · stop ${fmtPx(a.stopPx)}`}
            {rung.leverage != null && ` · ${rung.leverage}×`}
          </span>
        </div>
        <span className={css({ fontFamily: 'mono', fontSize: '9.5px', fontWeight: 'bold', letterSpacing: '0.04em', flex: 'none' })} style={{ color: prox?.armed ? ZONE_COLORS.ok : st.color }}>{prox?.armed ? '● PRIMED' : st.label}</span>
      </div>
      {prox && (
        <div data-testid={`armed-rung-prox-${rung.id}`} className={css({ fontFamily: 'mono', fontSize: '9.5px', paddingLeft: '2px' })} style={{ color: prox.armed ? ZONE_COLORS.ok : ZONE_COLORS.warn, fontFeatureSettings: '"tnum"' }}>
          {markPx != null && `${rung.coin} ${fmtPx(markPx)} · `}{prox.text}
        </div>
      )}
    </div>
  );
}
