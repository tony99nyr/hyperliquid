/**
 * PURE funding-carry benchmark for scout Lane B. No I/O — the script fetches the
 * funding history and feeds it in. Fixture-tested.
 *
 * The strategy it scores: a DELTA-NEUTRAL funding carry. You take the funding-
 * EARNING side of a perp (short when funding is positive — longs pay shorts; long
 * when negative) and HEDGE the price exposure, so there is no directional P&L —
 * the return IS the funding you accrue each hour. The mandatory negative-funding
 * guard is modeled: the moment funding flips against the entry side you EXIT (a
 * real carry trade doesn't sit there paying). ADL (the short hedge being
 * force-closed, leaving you naked) is a documented tail NOT modeled here — that is
 * the live-execution build's concern; this only measures whether the carry edge
 * is there to harvest. See docs/scout/SCOUT_ALPHA_ROADMAP.md (Lane B).
 */

import type { FundingPoint } from '@/lib/hyperliquid/candle-service';

const HOUR_MS = 3_600_000;

export interface CarryBenchmark {
  /** Accrued carry as a fraction of notional (delta-neutral → this IS the return). */
  carryReturnFrac: number;
  /** Hours the carry was held before the lookback ended or funding flipped. */
  heldHours: number;
  /** True when funding flipped against the entry side → the guard exited early. */
  exitedEarly: boolean;
  /** The funding-earning side taken at entry (short earns positive funding). */
  side: 'short' | 'long' | null;
}

/**
 * Carry from holding the funding-earning side delta-neutral over a funding series,
 * with the negative-funding exit guard. PURE.
 */
export function fundingCarryBenchmark(series: FundingPoint[]): CarryBenchmark {
  const pts = series
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.fundingHourly))
    .sort((a, b) => a.time - b.time);
  if (pts.length < 2) return { carryReturnFrac: 0, heldHours: 0, exitedEarly: false, side: null };

  // Entry side = the side that EARNS the first meaningful funding (short if funding
  // is positive: longs pay shorts). earnSign · funding ≥ 0 ⇒ you're being paid.
  const entry = pts.find((p) => p.fundingHourly !== 0) ?? pts[0];
  const earnSign = entry.fundingHourly > 0 ? 1 : entry.fundingHourly < 0 ? -1 : 0;
  if (earnSign === 0) return { carryReturnFrac: 0, heldHours: 0, exitedEarly: false, side: null };

  let carry = 0;
  let heldHours = 0;
  let exitedEarly = false;
  for (let i = 0; i + 1 < pts.length; i++) {
    const f = pts[i].fundingHourly;
    // Guard: funding flipped against the earning side → stop accruing (exit).
    if (f * earnSign < 0) { exitedEarly = true; break; }
    const dtH = Math.max(0, (pts[i + 1].time - pts[i].time) / HOUR_MS);
    carry += earnSign * f * dtH; // earnSign·f ≥ 0 here → carry accrues positive
    heldHours += dtH;
  }
  return { carryReturnFrac: carry, heldHours, exitedEarly, side: earnSign > 0 ? 'short' : 'long' };
}
