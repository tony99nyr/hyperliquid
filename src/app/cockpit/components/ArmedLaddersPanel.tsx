'use client';

/**
 * ArmedLaddersPanel — the cockpit decision-column view of ARMED ladders: what's primed
 * to fire autonomously, with the levels the operator wants on screen (entry trigger,
 * planned size, protective stop, leverage, status) and a LIVE distance-to-trigger per rung.
 * Polls /api/cockpit/ladder (armed + rungs) so a fire flips a rung WAITING → ✓ FIRED live.
 *
 * Proximity is live for EVERY armed coin (a hidden per-coin mark probe), not just the
 * cockpit's currently-selected coin — so a BTC ladder still shows "how close" while you're
 * looking at ETH. Hidden when nothing is armed so it never clutters the column. Read-only —
 * manage from the Ladders tab.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { css } from '@styled-system/css';
import { GH, ZONE_COLORS, TERM, fmtPx } from './panel-styles';
import { usePolledEndpoint } from '@/hooks/usePolledEndpoint';
import { useHlOrderbook } from '@/hooks/useHlOrderbook';
import { useNow } from '@/hooks/useNow';
import { projectRung, rungProximity, expiryReadout } from '@/lib/ladder/ladder-projection-business-logic';
import LadderDetailModal from './ladders/LadderDetailModal';
import type { LadderWithRungs, LadderRung } from '@/lib/ladder/ladder-types';

export interface ArmedLaddersPanelProps {
  /** The cockpit's current coin — its rungs are accented (their levels are on the chart). */
  coin?: string;
}

const RUNG_STATUS: Record<LadderRung['status'], { label: string; color: string }> = {
  pending: { label: 'WAITING', color: ZONE_COLORS.warn },
  fired: { label: '✓ FIRED', color: ZONE_COLORS.ok },
  skipped: { label: 'SKIPPED', color: GH.textMuted },
  failed: { label: 'FAILED', color: ZONE_COLORS.danger },
  cancelled: { label: 'CANCELLED', color: GH.textMuted },
};

// Module-scope so its identity is STABLE — passing an inline arrow makes
// usePolledEndpoint's effect deps change every render (the panel re-renders on every
// mark-probe ws tick), which tears down + re-fires the poll on each tick = a fetch storm
// on the real-money ladder endpoint. A stable reference polls on the 8s cadence only.
const pickLadders = (j: Record<string, unknown>): LadderWithRungs[] | undefined =>
  Array.isArray(j.ladders) ? (j.ladders as LadderWithRungs[]) : undefined;

/** Hidden per-coin live-mark probe — one ws per distinct armed coin. */
function MarkProbe({ coin, onPx }: { coin: string; onPx: (coin: string, px: number | null) => void }) {
  const { lastPx } = useHlOrderbook(coin);
  useEffect(() => { onPx(coin, lastPx); }, [coin, lastPx, onPx]);
  return null;
}

export default function ArmedLaddersPanel({ coin = 'ETH' }: ArmedLaddersPanelProps) {
  const { data } = usePolledEndpoint<LadderWithRungs[]>(
    '/api/cockpit/ladder?status=armed&withRungs=1',
    true,
    pickLadders,
    30_000, // was 8s — live proximity comes from the ws mark; this poll only refreshes rung status (CPU trim)
  );
  const ladders = useMemo(() => (data ?? []).filter((l) => l.rungs.length > 0), [data]);
  const coins = useMemo(() => Array.from(new Set(ladders.flatMap((l) => l.rungs.map((r) => r.coin.toUpperCase())))), [ladders]);

  const [marks, setMarks] = useState<Record<string, number | null>>({});
  const reportPx = useCallback((c: string, px: number | null) => {
    setMarks((m) => (m[c] === px ? m : { ...m, [c]: px }));
  }, []);
  const [detailId, setDetailId] = useState<string | null>(null);
  // Render-safe ticking clock for the expiry chips.
  const now = useNow();

  if (ladders.length === 0) return null; // nothing armed → no panel

  return (
    <section data-testid="armed-ladders-panel" className={css({ borderRadius: '12px', padding: '12px 14px' })} style={{ background: TERM.inset, border: '1px solid token(colors.github.border)' }}>
      {coins.map((c) => <MarkProbe key={c} coin={c} onPx={reportPx} />)}
      <div className={css({ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' })}>
        <span className={css({ width: '6px', height: '6px', borderRadius: '50%', flex: 'none' })} style={{ background: ZONE_COLORS.ok, boxShadow: `0 0 6px ${ZONE_COLORS.ok}` }} aria-hidden />
        <h3 className={css({ fontFamily: 'sans', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'github.textBright' })}>Armed Ladders</h3>
        <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>{ladders.length} armed</span>
      </div>
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '10px' })}>
        {ladders.map((l) => (
          // role=button (not <button>) so the rich rung rows can nest as valid HTML.
          // Click / Enter / Space opens the full detail modal (chart + per-rung trade).
          <div key={l.id} role="button" tabIndex={0} data-testid={`armed-ladder-${l.id}`} aria-label={`Review ${l.title}`}
            onClick={() => setDetailId(l.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailId(l.id); } }}
            className={css({ borderRadius: '9px', padding: '8px', margin: '-8px -8px 0', cursor: 'pointer', transition: 'background .12s', _hover: { background: 'rgba(91,140,255,.09)' }, _focusVisible: { outline: '2px solid token(colors.github.link)', outlineOffset: '1px' } })}>
            <div className={css({ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' })}>
              <span className={css({ fontFamily: 'sans', fontSize: '11px', fontWeight: 'semibold', color: 'github.textBright', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })}>{l.title}</span>
              {(() => {
                const exp = expiryReadout(l.expiresAt, now);
                return exp ? <span className={css({ fontFamily: 'mono', fontSize: '9px', fontWeight: 'semibold', flex: 'none' })} style={{ color: exp.urgency === 'expired' ? ZONE_COLORS.danger : exp.urgency === 'warn' ? ZONE_COLORS.warn : GH.textMuted }}>⏱ {exp.text.replace('expires in ', '')}</span> : null;
              })()}
              <span aria-hidden className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted', flex: 'none' })}>details ›</span>
            </div>
            <div className={css({ display: 'flex', flexDirection: 'column', gap: '5px' })}>
              {l.rungs.map((r) => <RungRow key={r.id} rung={r} accent={r.coin.toUpperCase() === coin.toUpperCase()} markPx={marks[r.coin.toUpperCase()] ?? null} />)}
            </div>
          </div>
        ))}
      </div>

      {detailId && <LadderDetailModal ladderId={detailId} onClose={() => setDetailId(null)} onChanged={() => setDetailId(null)} />}
    </section>
  );
}

function RungRow({ rung, accent, markPx }: { rung: LadderRung; accent: boolean; markPx: number | null }) {
  const long = rung.side === 'long';
  const p = projectRung(rung); // entry (= trigger), risk-sized size, derived stop
  const st = RUNG_STATUS[rung.status];
  const dir = rung.triggerKind === 'price_above' ? '▲' : rung.triggerKind === 'price_below' ? '▼' : '•';
  // "Is it close?" — only meaningful while still WAITING to trigger.
  const prox = rung.status === 'pending' ? rungProximity(rung, markPx) : null;
  return (
    <div data-testid={`armed-rung-${rung.id}`} className={css({ display: 'flex', flexDirection: 'column', gap: '5px', borderRadius: '8px', padding: '8px 10px' })}
      style={{ background: accent ? 'rgba(91,140,255,.06)' : 'rgba(255,255,255,.02)', border: `1px solid ${accent ? 'rgba(91,140,255,.22)' : 'rgba(255,255,255,.06)'}` }}>
      <div className={css({ display: 'flex', alignItems: 'center', gap: '8px' })}>
        <span className={css({ fontFamily: 'mono', fontSize: '10.5px', fontWeight: 'bold', borderRadius: '4px', paddingX: '6px', paddingY: '2px', flex: 'none' })} style={{ background: long ? 'rgba(63,185,80,.16)' : 'rgba(248,81,73,.16)', color: long ? ZONE_COLORS.ok : ZONE_COLORS.danger }}>{rung.coin} {long ? 'L' : 'S'}</span>
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '1px', flex: 1, minWidth: 0 })}>
          <span className={css({ fontFamily: 'mono', fontSize: '11px', color: 'github.textBright', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })} style={{ fontFeatureSettings: '"tnum"' }}>
            {rung.triggerPx != null ? `${dir} ${fmtPx(rung.triggerPx)}` : rung.triggerKind} {rung.action !== 'open' && `· ${rung.action}`}
          </span>
          <span className={css({ fontFamily: 'mono', fontSize: '9.5px', color: 'github.textMuted' })} style={{ fontFeatureSettings: '"tnum"' }}>
            {p.sizeCoins != null ? `${p.sizeCoins.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${rung.coin}` : '—'}
            {p.stopPx != null && ` · stop ${fmtPx(p.stopPx)}`}
            {rung.leverage != null && ` · ${rung.leverage}×`}
          </span>
        </div>
        <span className={css({ fontFamily: 'mono', fontSize: '9.5px', fontWeight: 'bold', letterSpacing: '0.04em', flex: 'none' })} style={{ color: prox?.primed ? ZONE_COLORS.ok : st.color }}>{prox?.primed ? '● PRIMED' : st.label}</span>
      </div>
      {prox && (
        <div data-testid={`armed-rung-prox-${rung.id}`} className={css({ fontFamily: 'mono', fontSize: '9.5px', paddingLeft: '2px' })} style={{ color: prox.primed ? ZONE_COLORS.ok : ZONE_COLORS.warn, fontFeatureSettings: '"tnum"' }}>
          {prox.primed
            ? `${markPx != null ? `${rung.coin} ${fmtPx(markPx)} · ` : ''}● through — fires if this 15m candle CLOSES past`
            : `${markPx != null ? `${rung.coin} ${fmtPx(markPx)} · ` : ''}needs ${prox.direction === 'up' ? '+' : '−'}${(prox.pct * 100).toFixed(2)}% to ${fmtPx(prox.toPx)}`}
        </div>
      )}
    </div>
  );
}
