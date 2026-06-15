/**
 * assess-trade-health — PURE recommendation logic (fixture-tested).
 *
 * Maps a HealthResult (from the health engine) onto a discrete advisory:
 * hold / trim / exit, with a reason. ADVISORY ONLY — assess-trade-health never
 * acts; the recommendation is surfaced to the user, who then decides whether to
 * run advise-exit.
 *
 * No I/O — the HealthResult comes in as a parameter.
 */

import type { HealthResult } from '@/lib/health/health-engine-types';

export type HealthAction = 'hold' | 'trim' | 'exit';

export interface HealthRecommendation {
  action: HealthAction;
  /** Human-readable reason referencing score / probabilities / alerts. */
  reason: string;
  /** Echoed for convenience (so the caller writes one row). */
  score: number;
  pContinuation: number;
  pAdverse: number;
  alerts: string[];
}

/** Score/alert thresholds. Conservative — when in doubt, advise trimming. */
export const HEALTH_RECOMMENDATION_THRESHOLDS = {
  /** At/above this score with no critical alert ⇒ hold. */
  holdScore: 60,
  /** Below this score ⇒ exit. */
  exitScore: 35,
  /** A regime flip against the position is a hard exit signal. */
  exitAlerts: ['regime-flip-8h'] as const,
  /** These alerts push toward trimming even at a healthy score. */
  trimAlerts: ['bearish-divergence-1h', 'stop-within-1-ATR', 'decline-detected'] as const,
} as const;

/**
 * Recommend hold / trim / exit from a HealthResult. PURE + deterministic.
 *
 * Priority:
 *  1. A hard exit alert (regime flip against the position) ⇒ exit.
 *  2. Score below the exit floor ⇒ exit.
 *  3. Score below the hold bar, OR a trim alert present ⇒ trim.
 *  4. Otherwise ⇒ hold.
 */
export function recommendFromHealth(health: HealthResult): HealthRecommendation {
  const t = HEALTH_RECOMMENDATION_THRESHOLDS;
  const base = {
    score: health.score,
    pContinuation: health.pContinuation,
    pAdverse: health.pAdverse,
    alerts: health.alerts,
  };

  const hardExit = health.alerts.find((a) => (t.exitAlerts as readonly string[]).includes(a));
  if (hardExit) {
    return { action: 'exit', reason: `Hard exit signal: ${hardExit} opposes the position.`, ...base };
  }

  if (health.score < t.exitScore) {
    return {
      action: 'exit',
      reason: `Health ${Math.round(health.score)} below exit floor ${t.exitScore}; P(adverse) ${(health.pAdverse * 100).toFixed(0)}%.`,
      ...base,
    };
  }

  const trimAlert = health.alerts.find((a) => (t.trimAlerts as readonly string[]).includes(a));
  if (health.score < t.holdScore || trimAlert) {
    const why =
      health.score < t.holdScore
        ? `Health ${Math.round(health.score)} below hold bar ${t.holdScore}`
        : `Warning alert present: ${trimAlert}`;
    return { action: 'trim', reason: `${why}; reduce risk, keep a runner.`, ...base };
  }

  return {
    action: 'hold',
    reason: `Health ${Math.round(health.score)} healthy; P(continuation) ${(health.pContinuation * 100).toFixed(0)}%, no opposing alerts.`,
    ...base,
  };
}
