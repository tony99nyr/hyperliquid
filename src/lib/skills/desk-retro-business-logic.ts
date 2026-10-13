/**
 * Desk-retro discard vet — PURE hindsight replay of a discarded entry plan.
 *
 * Given the core entry rung of a ladder that was archived / disarmed / expired,
 * and the completed candles since its counterfactual window start (creation for
 * a never-armed draft, the disarm moment for an armed one), answer: would it
 * have triggered, and then stopped out or paid? This keeps the weekly discard discipline honest
 * in BOTH directions — a pruned draft that would have stopped out confirms the
 * discard; one that would have paid is a real missed opportunity to learn from.
 *
 * Approximations (documented; they point in MIXED directions — the verdicts are
 * evidence, never P&L):
 * - A trigger is met when a COMPLETED bar CLOSES at/through the trigger price
 *   (mirrors the live evaluator's completed-candle close-through; a same-tick
 *   boundary difference is immaterial for a retro judgment).
 * - The entry fills at the trigger bar's CLOSE (mirrors the live fire path,
 *   which sizes off the candle-close mark, not the trigger).
 * - Stop/target hits are checked from the NEXT bar on via bar extremes; when a
 *   single bar spans both, the STOP wins (conservative — never flatters a miss).
 *   A caller's T1-proxy target sits CLOSER than a full target, which flatters.
 * - A target that is not strictly on the profit side of the fill is IGNORED
 *   (treated as no target) — a wrong-side "target" must never mint a fake win.
 *   A plan with no usable target can never show a miss, only a dodge or an open
 *   mark — `hadTarget` carries that asymmetry to the summary.
 * - The expiry clamp tests the bar's OPEN time, so a bar opening just before
 *   expiry may trigger up to one bar late. Intrabar path is unknown; R is
 *   denominated in |entry − stop|. Everything is GROSS of fees/funding/slippage.
 *
 * PURE: no I/O, no clock, fixture-tested. The script supplies completed bars.
 */

export interface RetroCandle {
  timeMs: number;
  highPx: number;
  lowPx: number;
  closePx: number;
}

export interface DiscardedPlan {
  coin: string;
  side: 'long' | 'short';
  triggerKind: 'price_above' | 'price_below';
  triggerPx: number;
  /** Absolute stop, when the rung carried one. */
  stopPx: number | null;
  /** Fractional stop (drafter rungs: resolved off the FILL at arm/fire time).
   *  Used only when stopPx is null; the replay resolves it off the entry close,
   *  mirroring `resolveArmRung`. */
  stopFrac: number | null;
  targetPx: number | null;
  /** The counterfactual window start — bars before this never evaluate. For a
   *  never-armed draft this is its CREATION (what if we had armed it then); for
   *  a disarmed ladder it is the DISARM moment (what did the disarm cost). */
  windowStartMs: number;
  /** The draft's own expiry: a trigger after it would never have fired. */
  expiresAtMs: number | null;
}

export type DiscardOutcome =
  | 'never-triggered' // the entry never fired — the discard cost nothing
  | 'dodged-stop' // it would have fired AND stopped out — the discard saved −1R
  | 'missed-target' // it would have fired and hit the target — a real miss
  | 'would-be-open' // fired, neither stop nor target yet — R is mark-to-market
  | 'not-evaluable'; // malformed plan (stop on the wrong side of the fill)

export interface DiscardVerdict {
  outcome: DiscardOutcome;
  entryPx: number | null;
  exitPx: number | null;
  /** Signed R (risk = |entry − stop|); null when nothing fired / not evaluable. */
  rMultiple: number | null;
  triggeredAtMs: number | null;
  resolvedAtMs: number | null;
  /** False when the plan had no usable (profit-side) target — such a plan can
   *  NEVER show a miss, so its dodge is weaker evidence for the discipline. */
  hadTarget: boolean;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Replay one discarded entry plan over the completed bars since its discard. */
export function replayDiscardedEntry(plan: DiscardedPlan, candles: RetroCandle[]): DiscardVerdict {
  const bars = candles
    .filter((c) => c.timeMs >= plan.windowStartMs)
    .sort((a, b) => a.timeMs - b.timeMs);

  // 1. Find the trigger bar (close at/through the trigger, inside the expiry window).
  let fireIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (plan.expiresAtMs != null && b.timeMs > plan.expiresAtMs) break;
    const met = plan.triggerKind === 'price_above' ? b.closePx >= plan.triggerPx : b.closePx <= plan.triggerPx;
    if (met) {
      fireIdx = i;
      break;
    }
  }
  if (fireIdx < 0) {
    return {
      outcome: 'never-triggered',
      entryPx: null,
      exitPx: null,
      rMultiple: null,
      triggeredAtMs: null,
      resolvedAtMs: null,
      hadTarget: plan.targetPx != null,
    };
  }

  const entryPx = bars[fireIdx].closePx;
  const triggeredAtMs = bars[fireIdx].timeMs;
  const stopPx =
    plan.stopPx ??
    (plan.stopFrac != null
      ? round6(plan.side === 'long' ? entryPx * (1 - plan.stopFrac) : entryPx * (1 + plan.stopFrac))
      : null);
  const risk = stopPx == null ? NaN : plan.side === 'long' ? entryPx - stopPx : stopPx - entryPx;
  // A target must sit strictly on the PROFIT side of the fill — a wrong-side
  // "target" (e.g. a T1 proxy below an overshooting fill) must never mint a win.
  const targetPx =
    plan.targetPx != null && (plan.side === 'long' ? plan.targetPx > entryPx : plan.targetPx < entryPx)
      ? plan.targetPx
      : null;
  if (!(risk > 0) || stopPx == null) {
    // No stop, or a stop on the wrong side of the would-be fill — nothing honest to measure.
    return { outcome: 'not-evaluable', entryPx, exitPx: null, rMultiple: null, triggeredAtMs, resolvedAtMs: null, hadTarget: targetPx != null };
  }

  // 2. Walk forward: stop vs target, stop-first on a both-in-one-bar span.
  for (let i = fireIdx + 1; i < bars.length; i++) {
    const b = bars[i];
    const stopHit = plan.side === 'long' ? b.lowPx <= stopPx : b.highPx >= stopPx;
    if (stopHit) {
      return { outcome: 'dodged-stop', entryPx, exitPx: stopPx, rMultiple: -1, triggeredAtMs, resolvedAtMs: b.timeMs, hadTarget: targetPx != null };
    }
    if (targetPx != null) {
      const targetHit = plan.side === 'long' ? b.highPx >= targetPx : b.lowPx <= targetPx;
      if (targetHit) {
        const r = round6(Math.abs(targetPx - entryPx) / risk);
        return { outcome: 'missed-target', entryPx, exitPx: targetPx, rMultiple: r, triggeredAtMs, resolvedAtMs: b.timeMs, hadTarget: true };
      }
    }
  }

  // 3. Still open at the window edge — mark it to the last completed close.
  const lastClose = bars[bars.length - 1].closePx;
  const signedMove = plan.side === 'long' ? lastClose - entryPx : entryPx - lastClose;
  return {
    outcome: 'would-be-open',
    entryPx,
    exitPx: lastClose,
    rMultiple: round6(signedMove / risk),
    triggeredAtMs,
    resolvedAtMs: null,
    hadTarget: targetPx != null,
  };
}

export interface DiscardVetSummary {
  total: number;
  neverTriggered: number;
  dodgedStops: number;
  missedTargets: number;
  wouldBeOpen: number;
  notEvaluable: number;
  /** Fired plans with NO usable target — a dodge there is weaker evidence,
   *  because such a plan can never show a miss. */
  firedWithoutTarget: number;
  /** Net hindsight R across everything that would have fired (positive = the
   *  discards would have paid). DESCRIPTIVE ONLY: tiny n, gross of
   *  fees/funding/slippage, no pre-registered bar — never a verdict by itself. */
  netHindsightR: number;
}

/** Aggregate verdicts into the retro's one-line summary. */
export function summarizeDiscardVet(verdicts: DiscardVerdict[]): DiscardVetSummary {
  const s: DiscardVetSummary = {
    total: verdicts.length,
    neverTriggered: 0,
    dodgedStops: 0,
    missedTargets: 0,
    wouldBeOpen: 0,
    notEvaluable: 0,
    firedWithoutTarget: 0,
    netHindsightR: 0,
  };
  for (const v of verdicts) {
    if (v.outcome === 'never-triggered') s.neverTriggered++;
    else if (v.outcome === 'dodged-stop') s.dodgedStops++;
    else if (v.outcome === 'missed-target') s.missedTargets++;
    else if (v.outcome === 'would-be-open') s.wouldBeOpen++;
    else s.notEvaluable++;
    if ((v.outcome === 'dodged-stop' || v.outcome === 'would-be-open') && !v.hadTarget) s.firedWithoutTarget++;
    if (v.rMultiple != null) s.netHindsightR += v.rMultiple;
  }
  s.netHindsightR = round6(s.netHindsightR);
  return s;
}
