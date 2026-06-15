'use client';

/**
 * HealthPanel — the trade-health gauge (0–100) + P(continuation) / P(adverse) +
 * the fired-alerts list. Realtime via useHealthSnapshots. Warning-zone styling:
 * the gauge arc + score color shift ok → warn → danger as health degrades
 * (thresholds in panel-styles.healthZone, which is unit-tested).
 */

import { css } from '@styled-system/css';
import type { HealthSnapshot } from '@/types/cockpit';
import { useHealthSnapshots } from '@/hooks/useHealthSnapshots';
import {
  GH,
  ZONE_COLORS,
  alertLabel,
  fmtPct,
  healthColor,
  healthZone,
} from './panel-styles';

export interface HealthPanelProps {
  sessionId: string | null;
  /** Test/RSC seed: render a fixed snapshot instead of subscribing. */
  snapshotOverride?: HealthSnapshot | null;
}

const GAUGE_SIZE = 120;
const STROKE = 10;
const RADIUS = (GAUGE_SIZE - STROKE) / 2;
const CIRC = 2 * Math.PI * RADIUS;

function ScoreGauge({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(100, score));
  const color = healthColor(clamped);
  const dash = (clamped / 100) * CIRC;
  return (
    <svg
      width={GAUGE_SIZE}
      height={GAUGE_SIZE}
      viewBox={`0 0 ${GAUGE_SIZE} ${GAUGE_SIZE}`}
      role="img"
      aria-label={`Health score ${Math.round(clamped)} of 100`}
      data-zone={healthZone(clamped)}
    >
      <circle
        cx={GAUGE_SIZE / 2}
        cy={GAUGE_SIZE / 2}
        r={RADIUS}
        fill="none"
        stroke={GH.borderSubtle}
        strokeWidth={STROKE}
      />
      <circle
        cx={GAUGE_SIZE / 2}
        cy={GAUGE_SIZE / 2}
        r={RADIUS}
        fill="none"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${CIRC - dash}`}
        transform={`rotate(-90 ${GAUGE_SIZE / 2} ${GAUGE_SIZE / 2})`}
      />
      <text
        x="50%"
        y="48%"
        textAnchor="middle"
        dominantBaseline="middle"
        fill={color}
        style={{ fontSize: '28px', fontWeight: 700, fontFamily: 'monospace' }}
      >
        {Math.round(clamped)}
      </text>
      <text
        x="50%"
        y="66%"
        textAnchor="middle"
        dominantBaseline="middle"
        fill={GH.textMuted}
        style={{ fontSize: '10px' }}
      >
        / 100
      </text>
    </svg>
  );
}

export default function HealthPanel({ sessionId, snapshotOverride }: HealthPanelProps) {
  const live = useHealthSnapshots(snapshotOverride === undefined ? sessionId : null);
  const snapshot = snapshotOverride !== undefined ? snapshotOverride : live.latest;

  return (
    <section
      data-testid="health-panel"
      className={css({
        bg: 'github.bgSecondary',
        border: '1px solid token(colors.github.border)',
        borderRadius: '8px',
        padding: '14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      })}
    >
      <header className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' })}>
        <h2 className={css({ fontSize: 'sm', fontWeight: 'semibold', color: 'github.textBright' })}>
          Trade Health
        </h2>
        {!snapshot && (
          <span className={css({ fontSize: 'xs', color: 'github.textMuted' })}>awaiting assessment…</span>
        )}
      </header>

      {snapshot && (
        <div className={css({ display: 'flex', gap: '16px', alignItems: 'center' })}>
          <ScoreGauge score={snapshot.score} />
          <div className={css({ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 })}>
            <div className={css({ display: 'flex', justifyContent: 'space-between' })}>
              <span className={css({ fontSize: 'xs', color: 'github.textMuted' })}>P(continuation)</span>
              <span
                data-testid="p-continuation"
                style={{ color: ZONE_COLORS.ok }}
                className={css({ fontSize: 'sm', fontFamily: 'mono' })}
              >
                {fmtPct(snapshot.pContinuation)}
              </span>
            </div>
            <div className={css({ display: 'flex', justifyContent: 'space-between' })}>
              <span className={css({ fontSize: 'xs', color: 'github.textMuted' })}>P(adverse)</span>
              <span
                data-testid="p-adverse"
                style={{ color: ZONE_COLORS.danger }}
                className={css({ fontSize: 'sm', fontFamily: 'mono' })}
              >
                {fmtPct(snapshot.pAdverse)}
              </span>
            </div>
          </div>
        </div>
      )}

      <div className={css({ display: 'flex', flexDirection: 'column', gap: '6px' })}>
        <span className={css({ fontSize: 'xs', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.04em' })}>
          Alerts
        </span>
        {snapshot && snapshot.alerts.length > 0 ? (
          <ul data-testid="health-alerts" className={css({ display: 'flex', flexDirection: 'column', gap: '4px', listStyle: 'none' })}>
            {snapshot.alerts.map((a) => (
              <li
                key={a}
                data-alert={a}
                style={{ borderLeft: `3px solid ${ZONE_COLORS.danger}` }}
                className={css({
                  fontSize: 'xs',
                  color: 'github.text',
                  bg: 'github.bg',
                  paddingX: '8px',
                  paddingY: '4px',
                  borderRadius: '4px',
                })}
              >
                {alertLabel(a)}
              </li>
            ))}
          </ul>
        ) : (
          <span data-testid="health-no-alerts" className={css({ fontSize: 'xs', color: 'github.textMuted' })}>
            {snapshot ? 'No alerts firing.' : '—'}
          </span>
        )}
      </div>
    </section>
  );
}
