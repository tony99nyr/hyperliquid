'use client';

/**
 * HealthPanel — the right-rail Trade Health block (our enhancement where HL puts
 * order entry). A graded score /100 (gauge + letter grade), BIG P(continuation) /
 * P(adverse) percentages, the per-timeframe RegimeStrip (regime + conf% + RSI as
 * numbers), and the fired alerts as color-coded chips. Realtime via
 * useHealthSnapshots; gauge color shifts ok → warn → danger as health degrades
 * (thresholds in panel-styles.healthZone, unit-tested).
 */

import { css } from '@styled-system/css';
import type { HealthSnapshot } from '@/types/cockpit';
import { useHealthSnapshots } from '@/hooks/useHealthSnapshots';
import RegimeStrip from './right-rail/RegimeStrip';
import AlertChip from './right-rail/AlertChip';
import {
  GH,
  ZONE_COLORS,
  fmtPct,
  healthColor,
  healthGrade,
  healthZone,
  panelSurface,
} from './panel-styles';

export interface HealthPanelProps {
  sessionId: string | null;
  /** Coin for the multi-timeframe regime strip. */
  coin?: string;
  /** Test/RSC seed: render a fixed snapshot instead of subscribing. */
  snapshotOverride?: HealthSnapshot | null;
}

const GAUGE_SIZE = 104;
const STROKE = 9;
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
      aria-label={`Health score ${Math.round(clamped)} of 100, grade ${healthGrade(clamped)}`}
      data-zone={healthZone(clamped)}
    >
      <circle cx={GAUGE_SIZE / 2} cy={GAUGE_SIZE / 2} r={RADIUS} fill="none" stroke={GH.borderSubtle} strokeWidth={STROKE} />
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
      <text x="50%" y="44%" textAnchor="middle" dominantBaseline="middle" fill={color} style={{ fontSize: '30px', fontWeight: 800, fontFamily: 'var(--font-jetbrains-mono), monospace', fontFeatureSettings: '"tnum"' }}>
        {Math.round(clamped)}
      </text>
      <text x="50%" y="64%" textAnchor="middle" dominantBaseline="middle" fill={GH.textMuted} style={{ fontSize: '11px', fontFamily: 'var(--font-archivo), sans-serif', letterSpacing: '0.06em' }}>
        GRADE {healthGrade(clamped)}
      </text>
    </svg>
  );
}

function ProbBlock({ label, value, color, testid }: { label: string; value: number; color: string; testid: string }) {
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 })}>
      <span className={css({ fontFamily: 'label', fontSize: '9px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.06em' })}>
        {label}
      </span>
      <span
        data-testid={testid}
        style={{ color, fontFeatureSettings: '"tnum"' }}
        className={css({ fontFamily: 'mono', fontSize: 'xl', fontWeight: 'bold', lineHeight: '1' })}
      >
        {fmtPct(value)}
      </span>
    </div>
  );
}

export default function HealthPanel({ sessionId, coin = 'ETH', snapshotOverride }: HealthPanelProps) {
  const live = useHealthSnapshots(snapshotOverride === undefined ? sessionId : null);
  const snapshot = snapshotOverride !== undefined ? snapshotOverride : live.latest;
  // In override (test/RSC seed) mode, keep the regime strip inert so the panel
  // renders without a network fetch — same convention as the other islands.
  const regimeCoin = snapshotOverride !== undefined ? '' : coin;

  return (
    <section
      data-testid="health-panel"
      className={css({ ...panelSurface, padding: '14px', display: 'flex', flexDirection: 'column', gap: '14px' })}
    >
      <header className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' })}>
        <h2 className={css({ fontFamily: 'label', fontSize: 'sm', fontWeight: 'bold', color: 'github.textBright', textTransform: 'uppercase', letterSpacing: '0.06em' })}>
          Trade Health
        </h2>
        {!snapshot && <span className={css({ fontSize: 'xs', color: 'github.textMuted', fontFamily: 'mono' })}>awaiting assessment…</span>}
      </header>

      {snapshot && (
        <div className={css({ display: 'flex', gap: '14px', alignItems: 'center' })}>
          <ScoreGauge score={snapshot.score} />
          <div className={css({ display: 'flex', gap: '12px', flex: 1 })}>
            <ProbBlock label="P(continuation)" value={snapshot.pContinuation} color={ZONE_COLORS.ok} testid="p-continuation" />
            <ProbBlock label="P(adverse)" value={snapshot.pAdverse} color={ZONE_COLORS.danger} testid="p-adverse" />
          </div>
        </div>
      )}

      <RegimeStrip coin={regimeCoin} />

      <div className={css({ display: 'flex', flexDirection: 'column', gap: '6px' })}>
        <span className={css({ fontFamily: 'label', fontSize: '10px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.08em' })}>
          Alerts
        </span>
        {snapshot && snapshot.alerts.length > 0 ? (
          <div data-testid="health-alerts" className={css({ display: 'flex', flexWrap: 'wrap', gap: '5px' })}>
            {snapshot.alerts.map((a) => (
              <AlertChip key={a} code={a} />
            ))}
          </div>
        ) : (
          <span data-testid="health-no-alerts" className={css({ fontSize: 'xs', color: 'github.textMuted', fontFamily: 'mono' })}>
            {snapshot ? 'No alerts firing.' : '—'}
          </span>
        )}
      </div>
    </section>
  );
}
