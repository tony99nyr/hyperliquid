/**
 * PURE row builders — turn a RubricResult into rubric_scores DB rows (one per
 * coin×side) and a position review into a position_reviews row. Plus a stable
 * `inputs_hash` so re-running the scan with identical inputs dedupes (the table's
 * unique (coin, side, inputs_hash) constraint) and stays point-in-time auditable.
 * No I/O. Fixture-tested.
 */

import type { RubricInputs, RubricResult } from './rubric-types';
import type { PositionReview } from './rubric-position-review-business-logic';
import { scoreBookImbalance } from './rubric-scorers-business-logic';

// Fixed depth band for the hash's book signature — config-independent so the hash
// stays stable across config edits while still tracking real order-book shifts.
const HASH_BOOK_DEPTH_FRAC = 0.01;

const r = (n: number, dp = 4): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** Deterministic FNV-1a hex (browser-safe, no crypto import). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Stable hash of the rubric inputs (rounded/canonicalized so float jitter doesn't
 * defeat dedupe). Same meaningful inputs → same hash; any real change → new hash.
 */
export function rubricInputsHash(inp: RubricInputs): string {
  const regime: Record<string, [string, number]> = {};
  for (const [tf, sig] of Object.entries(inp.regimeByTf)) {
    if (sig) regime[tf] = [sig.regime, r(sig.confidence, 3)];
  }
  // Fold in the book signature (imbalance + spread) so a book-driven micro-pillar
  // change can't be silently de-duped away, and the leader long/short counts.
  const bk = scoreBookImbalance(inp.book, HASH_BOOK_DEPTH_FRAC);
  const canonical = JSON.stringify({
    coin: inp.coin.toUpperCase(),
    mark: r(inp.markPx, 2),
    atr: r(inp.atr, 4),
    atrPctile: r(inp.atrPctile, 3),
    bbPctile: r(inp.bbBandwidthPctile, 3),
    regime,
    net: r(inp.consensus.net, 3),
    longCount: inp.consensus.longCount,
    shortCount: inp.consensus.shortCount,
    bookImb: r(bk.imbalance, 3),
    spreadBps: Number.isFinite(bk.spreadBps) ? r(bk.spreadBps, 1) : null,
    funding: inp.ctx ? r(inp.ctx.fundingHourly, 8) : null,
  });
  return fnv1a(canonical);
}

export interface RubricScoreRow {
  coin: string;
  side: 'long' | 'short';
  as_of: string;
  opportunity: number;
  pillar_regime: number;
  pillar_leaders: number;
  pillar_carry: number;
  pillar_micro: number;
  regime_multiplier: number;
  badge: string;
  chosen_side: string;
  no_trade_reason: string | null;
  entry_low: number | null;
  entry_high: number | null;
  invalidation: number | null;
  target: number | null;
  trigger_px: number | null;
  room_to_target: number | null;
  confidence: number;
  score_band_low: number;
  score_band_high: number;
  gates: Record<string, boolean>;
  killed_by: string | null;
  config_version: string;
  inputs_hash: string;
}

/** Two rows (long + short) for a RubricResult. */
export function buildRubricScoreRows(
  result: RubricResult,
  inp: RubricInputs,
  configVersion: string,
): RubricScoreRow[] {
  const asOf = new Date(result.asOf).toISOString();
  const inputsHash = rubricInputsHash(inp);
  return (['long', 'short'] as const).map((side) => {
    const s = result[side];
    return {
      coin: result.coin.toUpperCase(),
      side,
      as_of: asOf,
      opportunity: s.opportunity,
      pillar_regime: s.pillars.regime,
      pillar_leaders: s.pillars.leaders,
      pillar_carry: s.pillars.carry,
      pillar_micro: s.pillars.micro,
      regime_multiplier: r(s.regimeMultiplier, 4),
      badge: result.badge,
      chosen_side: result.chosenSide,
      no_trade_reason: result.noTradeReason,
      entry_low: r(s.levels.entryLow, 4),
      entry_high: r(s.levels.entryHigh, 4),
      invalidation: r(s.levels.invalidation, 4),
      target: r(s.levels.target, 4),
      trigger_px: r(s.levels.trigger, 4),
      room_to_target: r(s.levels.roomToTarget, 4),
      confidence: r(result.confidence, 4),
      score_band_low: result.scoreBandLow,
      score_band_high: result.scoreBandHigh,
      gates: { ...s.gates },
      killed_by: s.killedBy,
      config_version: configVersion,
      inputs_hash: inputsHash,
    };
  });
}

export interface PositionReviewRow {
  session_id: string;
  coin: string;
  side: 'long' | 'short';
  verdict: string;
  health_score: number;
  p_continuation: number;
  p_adverse: number;
  alerts: string[];
  rationale: string[];
  config_version: string;
}

export function buildPositionReviewRow(
  sessionId: string,
  coin: string,
  side: 'long' | 'short',
  review: PositionReview,
  pContinuation: number,
  pAdverse: number,
  alerts: string[],
  configVersion: string,
): PositionReviewRow {
  return {
    session_id: sessionId,
    coin: coin.toUpperCase(),
    side,
    verdict: review.verdict,
    health_score: r(review.healthScore, 2),
    p_continuation: r(pContinuation, 4),
    p_adverse: r(pAdverse, 4),
    alerts,
    rationale: review.rationale,
    config_version: configVersion,
  };
}
