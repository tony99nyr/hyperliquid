/**
 * PURE position-review classifier — turns the health engine's output + the
 * current rubric into a HOLD / ADD / TRIM / EXIT verdict for an OPEN position.
 * A thin layer over computeHealth (REUSE), not a second risk system: the Layer-1
 * auto-exit owns the hard stop; this is the advisory verdict surfaced to the
 * operator. No I/O. Fixture-tested.
 */

import type { HealthResult } from '@/lib/health/health-engine-types';
import type { RubricConfig } from './rubric-config-types';
import type { RubricResult, Side } from './rubric-types';

export type Verdict = 'HOLD' | 'ADD' | 'TRIM' | 'EXIT';

export interface PositionReviewInput {
  health: HealthResult;
  /** Current rubric for the held coin (gives regime-opposed + same-side GO signals). */
  rubric: RubricResult;
  /** The side actually held. */
  positionSide: Side;
}

export interface PositionReview {
  verdict: Verdict;
  rationale: string[];
  healthScore: number;
}

export function reviewPosition(inp: PositionReviewInput, cfg: RubricConfig): PositionReview {
  const { health, rubric, positionSide } = inp;
  const rationale: string[] = [];

  // Thesis broken: the higher-TF regime is confirmed AGAINST the held side.
  const regimeOpposed = rubric[positionSide].gates.againstConfirmedHtf;
  const hasAlerts = health.alerts.length > 0;

  let verdict: Verdict;
  if (health.score < cfg.review.exitBelow) {
    verdict = 'EXIT';
    rationale.push(`health ${health.score.toFixed(0)} < ${cfg.review.exitBelow}`);
  } else if (regimeOpposed) {
    verdict = 'EXIT';
    rationale.push('higher-TF regime confirmed against the position');
  } else if (hasAlerts && health.score < cfg.review.trimBelow) {
    verdict = 'TRIM';
    rationale.push(`alerts firing (${health.alerts.join(', ')}) + health ${health.score.toFixed(0)} < ${cfg.review.trimBelow}`);
  } else if (
    health.score >= cfg.review.addAbove &&
    !hasAlerts &&
    rubric.badge === 'GO' &&
    rubric.chosenSide === positionSide
  ) {
    verdict = 'ADD';
    rationale.push(`health ${health.score.toFixed(0)} ≥ ${cfg.review.addAbove} + rubric GO same side`);
  } else {
    verdict = 'HOLD';
    rationale.push(`health ${health.score.toFixed(0)} — thesis intact`);
  }

  return { verdict, rationale, healthScore: health.score };
}
