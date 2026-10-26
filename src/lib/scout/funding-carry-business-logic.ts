/**
 * PURE funding-carry benchmark for scout Lane B. No I/O — the script fetches the
 * funding history and feeds it in. Fixture-tested.
 *
 * The strategy it scores: a DELTA-NEUTRAL funding carry. You take the funding-
 * EARNING side of a perp (short when funding is positive — longs pay shorts; long
 * when negative) and HEDGE the price exposure, so there is no directional P&L —
 * the return IS the funding you accrue each hour. The mandatory negative-funding
 * guard is modeled: when trailing funding turns against the side you EXIT, and you
 * RE-ENTER when it turns favourable again (see fundingCarryBenchmark). ADL (the short hedge being
 * force-closed, leaving you naked) is a documented tail NOT modeled here — that is
 * the live-execution build's concern; this only measures whether the carry edge
 * is there to harvest. See docs/scout/SCOUT_ALPHA_ROADMAP.md (Lane B).
 */

import type { FundingPoint } from '@/lib/hyperliquid/candle-service';

const HOUR_MS = 3_600_000;

export interface CarryBenchmark {
  /** Accrued carry as a fraction of notional (delta-neutral → this IS the return), before costs. */
  carryReturnFrac: number;
  /** Hours in the market (summed across every entry). */
  heldHours: number;
  /** Hours covered by the series, in or out of the market. Use this for run rates. */
  spanHours: number;
  /** Number of entries. Each one is a round trip the caller must charge costs for. */
  entries: number;
  /** True when the guard exited at least once. */
  exitedEarly: boolean;
  /** The funding-earning side (short earns positive funding). Fixed for the series. */
  side: 'short' | 'long' | null;
}

/** Trailing window, in funding points (hourly on HL), for the exit/re-entry signal. */
export const CARRY_SIGNAL_WINDOW = 24;

/**
 * Carry from holding the funding-earning side delta-neutral over a funding series.
 * Guard: exit when the trailing mean funding (last CARRY_SIGNAL_WINDOW points, up to
 * and including the current one) turns against the side, and re-enter when it turns
 * favourable again. The current point's rate governs the interval that follows it.
 * The trailing mean stops the position from flipping in and out every hour. PURE.
 */
export function fundingCarryBenchmark(series: FundingPoint[]): CarryBenchmark {
  const pts = series
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.fundingHourly))
    .sort((a, b) => a.time - b.time);
  const empty: CarryBenchmark = { carryReturnFrac: 0, heldHours: 0, spanHours: 0, entries: 0, exitedEarly: false, side: null };
  if (pts.length < 2) return empty;

  // Side = the side that EARNS the first meaningful funding (short if funding is
  // positive: longs pay shorts). earnSign · funding ≥ 0 ⇒ you're being paid.
  const first = pts.find((p) => p.fundingHourly !== 0) ?? pts[0];
  const earnSign = first.fundingHourly > 0 ? 1 : first.fundingHourly < 0 ? -1 : 0;
  const spanHours = (pts[pts.length - 1].time - pts[0].time) / HOUR_MS;
  if (earnSign === 0) return { ...empty, spanHours };

  let carry = 0;
  let heldHours = 0;
  let entries = 0;
  let exitedEarly = false;
  let inMarket = false;
  let windowSum = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    windowSum += pts[i].fundingHourly;
    if (i >= CARRY_SIGNAL_WINDOW) windowSum -= pts[i - CARRY_SIGNAL_WINDOW].fundingHourly;
    const signal = earnSign * windowSum; // > 0: the side is being paid on average
    if (!inMarket && signal > 0) { inMarket = true; entries += 1; }
    else if (inMarket && signal < 0) { inMarket = false; exitedEarly = true; }
    if (!inMarket) continue;
    const dtH = Math.max(0, (pts[i + 1].time - pts[i].time) / HOUR_MS);
    carry += earnSign * pts[i].fundingHourly * dtH; // adverse hours inside the window count
    heldHours += dtH;
  }
  return { carryReturnFrac: carry, heldHours, spanHours, entries, exitedEarly, side: earnSign > 0 ? 'short' : 'long' };
}
