'use client';

/**
 * ScoutPanel — the autonomous paper scout's track record at a glance. Shows the
 * scout's recent theses (what it decided) with win/loss outcomes + a summary, so
 * you can see on your phone whether the autonomous scout is finding edge — the
 * legibility half of "is this worth running?". Reads the global `hypotheses` table
 * (realtime, zero client HL calls). The full $/bar scorecard is `pnpm scout:review`.
 */

import { css } from '@styled-system/css';
import { useScoutHypotheses } from '@/hooks/useScoutHypotheses';
import type { Hypothesis } from '@/types/cockpit';
import { panelSurface, GH, ZONE_COLORS } from './panel-styles';
import { scoutStats, statusMeta } from './scout-panel-helpers';

export interface ScoutPanelProps {
  /** Test/RSC seed: render fixed theses instead of subscribing. */
  hypsOverride?: Hypothesis[];
}

export default function ScoutPanel({ hypsOverride }: ScoutPanelProps) {
  const live = useScoutHypotheses({ enabled: hypsOverride === undefined });
  const hyps = hypsOverride ?? live.rows;
  const stats = scoutStats(hyps);
  const winRatePct = stats.winRate == null ? '—' : `${Math.round(stats.winRate * 100)}%`;
  // Distinguish "still loading" from "genuinely empty" so the feed doesn't flash a
  // false "no theses yet" before the snapshot resolves. Overrides are always ready.
  const loading = hypsOverride === undefined && !live.loaded;
  const error = hypsOverride === undefined ? live.error : null;
  const subscribed = hypsOverride !== undefined || live.subscribed;

  return (
    <section
      data-testid="scout-panel"
      className={css({ ...panelSurface, padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' })}
    >
      <header className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center' })}>
        <h3 className={css({ fontFamily: 'label', fontSize: 'sm', fontWeight: 'bold', color: 'github.textBright', textTransform: 'uppercase', letterSpacing: '0.06em' })}>
          Scout
        </h3>
        <span className={css({ display: 'inline-flex', alignItems: 'center', gap: '5px', fontFamily: 'mono', fontSize: '9px', color: 'github.textMuted' })}>
          <span className={css({ width: '6px', height: '6px', borderRadius: '50%' })} style={{ background: subscribed ? ZONE_COLORS.ok : GH.textMuted }} />
          paper · autonomous
        </span>
      </header>

      {/* summary: open / W-L / win-rate */}
      <div className={css({ display: 'flex', gap: '14px', fontFamily: 'mono', fontSize: '11px' })}>
        <span className={css({ color: 'github.textMuted' })}>open <span style={{ color: GH.textBright }}>{stats.open}</span></span>
        <span className={css({ color: 'github.textMuted' })}>
          <span style={{ color: ZONE_COLORS.ok }}>{stats.wins}W</span>
          {' / '}
          <span style={{ color: ZONE_COLORS.danger }}>{stats.losses}L</span>
        </span>
        <span className={css({ color: 'github.textMuted' })}>win-rate <span style={{ color: GH.textBright }}>{winRatePct}</span></span>
      </div>

      {/* recent theses feed */}
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '5px' })}>
        {error ? (
          <span data-testid="scout-error" className={css({ fontFamily: 'mono', fontSize: '10px', color: 'zone.warn' })}>
            scout feed unavailable
          </span>
        ) : loading ? (
          <span data-testid="scout-loading" className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>
            reading…
          </span>
        ) : hyps.length === 0 ? (
          <span data-testid="scout-empty" className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>
            no theses yet — the scout logs each paper trade here
          </span>
        ) : (
          hyps.slice(0, 8).map((h) => {
            const m = statusMeta(h.status);
            return (
              <div key={h.id} data-testid="scout-thesis" className={css({ display: 'flex', alignItems: 'baseline', gap: '8px', fontFamily: 'mono', fontSize: '10px' })}>
                <span style={{ color: m.color }} className={css({ fontFamily: 'label', fontSize: '9px', fontWeight: 'bold', letterSpacing: '0.04em', width: '34px', flexShrink: 0 })}>{m.label}</span>
                <span title={h.statement} className={css({ color: 'github.textMuted', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })}>{h.statement}</span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
