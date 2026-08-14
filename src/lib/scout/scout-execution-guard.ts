/**
 * The autonomous scout's hard safety boundary. The scout is the ONE path in the
 * system that executes WITHOUT a human approval popup — that autonomy is allowed
 * for PAPER fills only. This guard is the single, testable assertion that keeps
 * real funds behind the human gate: scout auto-execution refuses to run unless
 * the process is in paper mode.
 *
 * Live trading the scout proposes is surfaced to the human and goes through the
 * existing `requireApproval` popup (Tier-1) — never this path. Pinning this in a
 * unit test is the no-auto-fire-for-real-money guarantee.
 */

import type { TradingMode } from '@/types/fill';

export class ScoutLiveExecutionError extends Error {
  constructor() {
    super(
      'Scout auto-execution is PAPER-ONLY. Refusing to fire in live mode — real-money ' +
        'trades must go through the human approval popup (Tier-1), never the autonomous scout.',
    );
    this.name = 'ScoutLiveExecutionError';
  }
}

/**
 * Throw unless `mode` is 'paper'. Call this immediately before any scout-initiated
 * `executeIntent`. There is intentionally NO flag or env that relaxes it.
 */
export function assertScoutPaperMode(mode: TradingMode): void {
  if (mode !== 'paper') throw new ScoutLiveExecutionError();
}

/**
 * KILLED lanes — pre-registered forward tests whose kill bar has FIRED (see
 * docs/scout/playbook.md reviews + docs/scout/PREREGISTRATION_*.md). Deterministic
 * enforcement at the execution point: prose in the playbook and context-only cycle
 * sections proved insufficient — after the 08-07 daemon revival a stale cycle
 * directive churned 42 trend-follow trades PAST its fired n=15 bar (08-13 review).
 * A lane on this list can NEVER open a new paper position; EXITS are always allowed
 * (a killed lane must still be able to flatten). Un-killing a lane is a deliberate
 * code change with a fresh pre-registration, never a runtime flag.
 */
export const KILLED_LANES: ReadonlySet<string> = new Set(['directional', 'reversion', 'trend-follow']);

export class ScoutKilledLaneError extends Error {
  constructor(lane: string) {
    super(
      `Scout lane '${lane}' is KILLED — its pre-registered kill bar fired (see docs/scout/playbook.md). ` +
        'Refusing to OPEN. Exits of existing positions remain allowed. A revival requires a NEW pre-registration.',
    );
    this.name = 'ScoutKilledLaneError';
  }
}

/** Throw if `lane` is killed. Call before any scout-initiated OPEN (never on exits). */
export function assertLaneAlive(lane: string): void {
  if (KILLED_LANES.has(lane.trim().toLowerCase())) throw new ScoutKilledLaneError(lane);
}
