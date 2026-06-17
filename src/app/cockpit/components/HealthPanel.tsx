'use client';

/**
 * HealthPanel — the right-rail block that ADAPTS to whether the session holds an
 * OPEN position (HL puts order entry here; we put the read that matters now):
 *
 *   FLAT (no position) → "MARKET READ / ENTRY": the multi-timeframe regime read
 *     (per-TF regime + conf% + RSI as numbers) plus a net directional bias framed
 *     as ENTRY guidance ("is it a good time, which side"). No position-health for a
 *     position that doesn't exist.
 *
 *   IN A POSITION → "TRADE HEALTH": the graded score /100 (gauge + grade), BIG
 *     P(continuation) / P(adverse) percentages, and the fired alerts as chips.
 *
 * The flat-vs-in switch is driven by the active position (usePositionPnl filtered
 * to the coin). When flat there may be no health_snapshot, so the market read is
 * derived from useRegimeStrip (always available). Numbers-first throughout.
 */

import { css } from '@styled-system/css';
import type { HealthSnapshot } from '@/types/cockpit';
import { useHealthSnapshots } from '@/hooks/useHealthSnapshots';
import { usePositionPnl } from '@/hooks/usePositionPnl';
import { useRegimeStrip } from '@/hooks/useRegimeStrip';
import RegimeStrip from './right-rail/RegimeStrip';
import AlertChip from './right-rail/AlertChip';
import { deriveEntryBias, type RegimeStripRow } from './right-rail/regime-strip-helpers';
import {
  GH,
  ZONE_COLORS,
  fmtPct,
  healthColor,
  healthGrade,
  healthZone,
  panelSurface,
  regimeColor,
} from './panel-styles';

export interface HealthPanelProps {
  sessionId: string | null;
  /** Coin for the multi-timeframe regime strip. */
  coin?: string;
  /** Test/RSC seed: render a fixed snapshot instead of subscribing. */
  snapshotOverride?: HealthSnapshot | null;
  /**
   * Test/RSC seed: force the flat-vs-in-position mode instead of deriving it from
   * the live position. When undefined, the mode is derived from usePositionPnl
   * (an open, non-flat position for this coin ⇒ "in position").
   */
  inPositionOverride?: boolean;
  /** Test seed: fixed regime rows for the entry read (bypasses the fetch). */
  regimeRowsOverride?: RegimeStripRow[];
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

const sectionStyle = { ...panelSurface, padding: '14px', display: 'flex', flexDirection: 'column', gap: '14px' } as const;

function PanelHeader({ title, note }: { title: string; note?: string }) {
  return (
    <header className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' })}>
      <h2 className={css({ fontFamily: 'label', fontSize: 'sm', fontWeight: 'bold', color: 'github.textBright', textTransform: 'uppercase', letterSpacing: '0.06em' })}>
        {title}
      </h2>
      {note && <span className={css({ fontSize: 'xs', color: 'github.textMuted', fontFamily: 'mono' })}>{note}</span>}
    </header>
  );
}

export default function HealthPanel({
  sessionId,
  coin = 'ETH',
  snapshotOverride,
  inPositionOverride,
  regimeRowsOverride,
}: HealthPanelProps) {
  const usingOverride = snapshotOverride !== undefined || inPositionOverride !== undefined;

  const live = useHealthSnapshots(snapshotOverride === undefined ? sessionId : null);
  const snapshot = snapshotOverride !== undefined ? snapshotOverride : live.latest;

  // In override (test/RSC seed) mode keep the live subscriptions inert.
  const positionState = usePositionPnl(usingOverride ? null : sessionId);
  const norm = coin.trim().toUpperCase();
  const derivedInPosition = positionState.positions.some(
    (p) => p.side !== 'flat' && p.coin.toUpperCase() === norm,
  );
  const inPosition = inPositionOverride !== undefined ? inPositionOverride : derivedInPosition;

  // The regime strip / entry read fetches for a real coin; inert under overrides.
  const regimeCoin = usingOverride || regimeRowsOverride ? '' : coin;

  if (inPosition) {
    return (
      <TradeHealthView snapshot={snapshot} regimeCoin={regimeCoin} rowsOverride={regimeRowsOverride} />
    );
  }
  return (
    <MarketReadView coin={coin} regimeCoin={regimeCoin} rowsOverride={regimeRowsOverride} usingOverride={usingOverride} />
  );
}

/** "TRADE HEALTH" — the held-position read (score + probabilities + alerts). */
function TradeHealthView({
  snapshot,
  regimeCoin,
  rowsOverride,
}: {
  snapshot: HealthSnapshot | null;
  regimeCoin: string;
  rowsOverride?: RegimeStripRow[];
}) {
  return (
    <section data-testid="health-panel" data-mode="trade-health" className={css(sectionStyle)}>
      <PanelHeader title="Trade Health" note={!snapshot ? 'awaiting assessment…' : undefined} />

      {snapshot && (
        <div className={css({ display: 'flex', gap: '14px', alignItems: 'center' })}>
          <ScoreGauge score={snapshot.score} />
          <div className={css({ display: 'flex', gap: '12px', flex: 1 })}>
            <ProbBlock label="P(continuation)" value={snapshot.pContinuation} color={ZONE_COLORS.ok} testid="p-continuation" />
            <ProbBlock label="P(adverse)" value={snapshot.pAdverse} color={ZONE_COLORS.danger} testid="p-adverse" />
          </div>
        </div>
      )}

      <RegimeStrip coin={regimeCoin} rowsOverride={rowsOverride} />

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

/** "MARKET READ / ENTRY" — the flat-session entry guidance (regime + bias). */
function MarketReadView({
  coin,
  regimeCoin,
  rowsOverride,
  usingOverride,
}: {
  coin: string;
  regimeCoin: string;
  rowsOverride?: RegimeStripRow[];
  usingOverride: boolean;
}) {
  // Pull the same rows the strip uses so we can derive a net directional bias.
  // Inert (empty coin) under overrides; the override rows feed the bias directly.
  const liveStrip = useRegimeStrip(rowsOverride || usingOverride ? '' : coin);
  const rows = rowsOverride ?? liveStrip.rows;
  const bias = deriveEntryBias(rows);
  const biasColor = regimeColor(bias.side === 'long' ? 'bullish' : bias.side === 'short' ? 'bearish' : 'neutral');
  const sideLabel = bias.side === 'long' ? 'LONG' : bias.side === 'short' ? 'SHORT' : 'NEUTRAL';

  return (
    <section data-testid="health-panel" data-mode="market-read" className={css(sectionStyle)}>
      <PanelHeader title="Market Read / Entry" note="no position" />

      <div className={css({ display: 'flex', flexDirection: 'column', gap: '3px' })}>
        <span className={css({ fontFamily: 'label', fontSize: '9px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.06em' })}>
          Net Directional Bias
        </span>
        <span
          data-testid="entry-bias-side"
          data-side={bias.side}
          style={{ color: biasColor }}
          className={css({ fontFamily: 'mono', fontSize: 'xl', fontWeight: 'bold', lineHeight: '1' })}
        >
          {sideLabel}
          {bias.side !== 'neutral' && (
            <span data-testid="entry-bias-strength" style={{ color: biasColor, fontFeatureSettings: '"tnum"' }} className={css({ fontSize: 'sm', marginLeft: '8px' })}>
              {Math.round(bias.strength * 100)}%
            </span>
          )}
        </span>
        <span data-testid="entry-bias-guidance" className={css({ fontSize: 'xs', color: 'github.text', lineHeight: '1.4' })}>
          {bias.guidance}
        </span>
      </div>

      <RegimeStrip coin={regimeCoin} rowsOverride={rowsOverride} />

      <span className={css({ fontSize: '10px', color: 'github.textMuted', fontFamily: 'mono', lineHeight: '1.4' })}>
        Entry guidance only — no open {coin} position. Trade Health replaces this once a position is live.
      </span>
    </section>
  );
}
