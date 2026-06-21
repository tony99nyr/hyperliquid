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
