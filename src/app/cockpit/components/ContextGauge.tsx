'use client';

/**
 * ContextGauge — Claude's rough self-reported context-budget meter. A horizontal
 * bar (0–100%) colored by zone (ok < 60 ≤ warn < 85 ≤ critical, matching
 * classifyContextZone). Labeled "approx" because it is a safety cue, not a meter.
 * Realtime via useContextGauge.
 */

import { css } from '@styled-system/css';
import type { ContextGauge as ContextGaugeRow } from '@/types/cockpit';
import { useContextGauge } from '@/hooks/useContextGauge';
import { contextZoneColor, GH } from './panel-styles';

export interface ContextGaugeProps {
  sessionId: string | null;
  /** Test/RSC seed: render a fixed sample instead of subscribing. */
  sampleOverride?: ContextGaugeRow | null;
}

export default function ContextGauge({ sessionId, sampleOverride }: ContextGaugeProps) {
  const live = useContextGauge(sampleOverride === undefined ? sessionId : null);
  const sample = sampleOverride !== undefined ? sampleOverride : live.latest;

  const pct = sample ? Math.max(0, Math.min(100, sample.approxPct)) : 0;
  const zone = sample?.zone ?? 'ok';
  const color = contextZoneColor(zone);

  return (
    <section
      data-testid="context-gauge"
      data-zone={zone}
      className={css({
        bg: 'github.bgSecondary',
        border: '1px solid token(colors.github.border)',
        borderRadius: '8px',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      })}
    >
      <header className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' })}>
        <h2 className={css({ fontSize: 'sm', fontWeight: 'semibold', color: 'github.textBright' })}>
          Claude Context{' '}
          <span className={css({ fontSize: 'xs', color: 'github.textMuted', fontWeight: 'normal' })}>(approx)</span>
        </h2>
        <span
          data-testid="context-pct"
          style={{ color }}
          className={css({ fontSize: 'sm', fontFamily: 'mono', fontWeight: 'bold' })}
        >
          {sample ? `${Math.round(pct)}%` : '—'}
        </span>
      </header>

      <div
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Approximate Claude context usage"
        className={css({
          position: 'relative',
          height: '10px',
          borderRadius: '5px',
          overflow: 'hidden',
        })}
        style={{ background: GH.borderSubtle }}
      >
        <div
          data-testid="context-bar-fill"
          style={{ width: `${pct}%`, background: color }}
          className={css({ height: '100%', transition: 'width 0.3s ease, background 0.3s ease' })}
        />
      </div>

      <span
        data-testid="context-zone-label"
        style={{ color }}
        className={css({ fontSize: 'xs', textTransform: 'uppercase', letterSpacing: '0.05em' })}
      >
        {zone === 'critical' ? 'CRITICAL — wrap up the trade' : zone === 'warn' ? 'WARN — plan to checkpoint' : 'OK'}
      </span>
    </section>
  );
}
