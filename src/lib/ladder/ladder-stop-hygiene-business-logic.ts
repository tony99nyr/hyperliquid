/**
 * Stop-placement hygiene — PURE liquidity-pool proximity checks (fixture-tested).
 *
 * Stops that sit ON obvious liquidity get hunted: round numbers, and the extremes of
 * recent wicks (where prior stop clusters already proved to rest). A flush trades
 * *through* those levels routinely, fills the resting stops, then reverses. The desk rule
 * (playbook §4 wick tax): place the stop BEYOND liquidity, never on it.
 *
 * HONEST SCOPE: this is a price-geometry heuristic — round-number magnets + wick extremes
 * derived from candles the caller supplies. It is NOT an order-book/OI liquidation map
 * (that needs an external data source; see the roadmap note in the playbook). No I/O.
 */

import type { LadderSide } from './ladder-types';

export interface StopHygieneIssue {
  kind: 'round-number' | 'wick-extreme';
  level: number;
  /** Distance from the stop to the level, as a fraction of price. */
  distanceFrac: number;
  note: string;
}

export interface StopHygieneRead {
  issues: StopHygieneIssue[];
  /** 0-10 (higher = cleaner placement) — feeds the review stop-integrity pillar. */
  score: number;
}

/** A stop within this fraction of a magnet level counts as "on" it. */
export const STOP_MAGNET_TOL_FRAC = 0.0015;

/**
 * The round-number step ladders traders anchor on, scaled to the price's magnitude
 * (~1% of price, snapped to a 1/2.5/5 × 10^k grid): $66 → $0.5, $1600 → $10 (and 25),
 * $60k → $500. Both the base step and 5× it (the "rounder" level) are checked.
 */
export function roundStepsFor(px: number): number[] {
  if (!(px > 0)) return [];
  const target = px * 0.01;
  const mag = Math.pow(10, Math.floor(Math.log10(target)));
  const base = [1, 2.5, 5, 10].map((m) => m * mag).reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
  return [base, base * 5];
}

const nearestMultiple = (x: number, step: number): number => Math.round(x / step) * step;

/**
 * Assess one protective stop. `recentWicks` are the wick extremes on the STOP side of
 * recent candles (lows for a long stop, highs for a short stop) — optional; when absent
 * only the round-number check runs. PURE.
 */
export function stopHygiene(args: {
  stopPx: number;
  side: LadderSide;
  recentWicks?: number[] | null;
  tolFrac?: number;
}): StopHygieneRead {
  const { stopPx, side } = args;
  const tol = args.tolFrac ?? STOP_MAGNET_TOL_FRAC;
  const issues: StopHygieneIssue[] = [];
  if (!(stopPx > 0)) return { issues, score: 10 };

  for (const step of roundStepsFor(stopPx)) {
    const level = nearestMultiple(stopPx, step);
    const dist = Math.abs(stopPx - level) / stopPx;
    if (level > 0 && dist <= tol) {
      issues.push({
        kind: 'round-number',
        level,
        distanceFrac: dist,
        note: `Stop ${stopPx} sits on the ${level} round level (±${(tol * 100).toFixed(2)}%) — a stop-cluster magnet; place it beyond, not on it.`,
      });
      break; // one round-number flag is enough
    }
  }

  for (const wick of args.recentWicks ?? []) {
    if (!(wick > 0)) continue;
    const dist = Math.abs(stopPx - wick) / stopPx;
    // Flag when the stop is AT the wick or INSIDE it (a re-test of that wick takes the
    // stop out): for a long, stop at/above a recent low; for a short, at/below a high.
    const inside = side === 'long' ? stopPx >= wick : stopPx <= wick;
    if (dist <= tol || (inside && dist <= tol * 4)) {
      issues.push({
        kind: 'wick-extreme',
        level: wick,
        distanceFrac: dist,
        note: `Stop ${stopPx} sits ${dist <= tol ? 'on' : 'inside'} the recent wick extreme ${wick} — a proven stop pool; a re-test fills it.`,
      });
      break;
    }
  }

  // Score: clean = 10; on a wick pool = worse than on a round number (proven liquidity).
  const score = issues.some((i) => i.kind === 'wick-extreme') ? 3 : issues.length > 0 ? 5 : 10;
  return { issues, score };
}
