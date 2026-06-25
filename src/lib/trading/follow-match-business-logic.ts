/**
 * PURE follow keep-matched decision (fixture-tested) — the safety-critical core of
 * PR-6. Given a leader's detected change and the operator's OWN live position, decide
 * the PROTECTIVE matching action. Scope = REDUCE-ONLY (reduce / close): the leader
 * only supplies DIRECTION; size is always a fraction of the operator's own position.
 *
 * Opening/adding is NOT staged here — opening real-money exposure is the operator's
 * full discretion via the normal entry flow. This module only ever proposes REDUCING
 * what the operator already holds, so a wrong/stale read can never INCREASE exposure.
 *
 * NO-AUTO-FIRE: the output is a SUGGESTION staged into the approval popup; the human
 * approves every fire. This decides only what to suggest.
 */

export type LeaderActionKind = 'open' | 'add' | 'reduce' | 'close' | 'flip';
export type Side = 'long' | 'short';
export type OperatorSide = Side | 'flat';
export type FollowMatchAction = 'reduce' | 'close' | 'none';

export interface FollowMatchInput {
  leaderKind: LeaderActionKind;
  leaderPrevSide: Side | null;
  leaderNewSide: Side | null;
  leaderPrevSize: number;
  leaderNewSize: number;
  /** The operator's OWN position in this coin (the thing we'd reduce). */
  operatorSide: OperatorSide;
  operatorSz: number;
}

export interface FollowMatchPlan {
  action: FollowMatchAction;
  /** Fraction of the operator's OWN position to reduce (1 = full close). */
  fraction: number;
  reason: string;
}

function none(reason: string): FollowMatchPlan {
  return { action: 'none', fraction: 0, reason };
}

export function planFollowMatch(input: FollowMatchInput): FollowMatchPlan {
  const { leaderKind, leaderPrevSide, leaderNewSide, leaderPrevSize, leaderNewSize, operatorSide, operatorSz } = input;

  // Nothing to reduce → never propose anything.
  if (operatorSide === 'flat' || !(operatorSz > 0)) {
    return none('You hold no position in this coin — nothing to keep matched.');
  }

  switch (leaderKind) {
    case 'close': {
      // Leader fully exited. Only match if you're on the side they held.
      if (operatorSide !== leaderPrevSide) {
        return none("Leader closed the opposite side of your position — no protective match.");
      }
      return { action: 'close', fraction: 1, reason: `Leader closed their ${leaderPrevSide} — close yours to match.` };
    }
    case 'reduce': {
      // Leader trimmed (same side). Only match if you hold that same side.
      if (operatorSide !== leaderNewSide) {
        return none("You're on the opposite side of the leader's trimmed position — no protective match.");
      }
      const cut = leaderPrevSize > 0 ? (leaderPrevSize - leaderNewSize) / leaderPrevSize : 0;
      const fraction = Math.min(1, Math.max(0, cut));
      if (!(fraction > 0)) return none('Leader reduce was sub-threshold — nothing to trim.');
      return { action: 'reduce', fraction, reason: `Leader trimmed ~${(fraction * 100).toFixed(0)}% — trim yours to match.` };
    }
    case 'flip': {
      // Leader reversed. If you still hold the side they LEFT, close it (re-enter the
      // new side at your discretion). If you're already on their new side, do nothing
      // (never close a position that's already correctly aligned).
      if (operatorSide !== leaderPrevSide) {
        return none(
          operatorSide === leaderNewSide
            ? "You're already aligned with the leader's new side — nothing to close."
            : "You don't hold the leader's pre-flip side — no protective match.",
        );
      }
      return { action: 'close', fraction: 1, reason: `Leader flipped off ${leaderPrevSide} — close yours (re-enter the new side at your discretion).` };
    }
    default: // 'open' | 'add' — opening exposure is the operator's discretion, never staged.
      return none('Leader opened/added — opening exposure is your call, not a protective match.');
  }
}
