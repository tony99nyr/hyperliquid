/**
 * PURE auto-exit decision (Layer 1) — the heart of the autonomous safety net.
 *
 * Given one open position's live risk inputs + thresholds, decide whether to
 * CLOSE it (reduce-only). EXIT-ONLY by construction: this returns a boolean +
 * reason; it never opens/adds/flips. No I/O, no keys, no execution — the caller
 * (the risk-exit route) RE-VERIFIES from fresh data and fires the reduce-only
 * close. Fully unit-tested. See docs/LIVE_AUTO_EXIT.md.
 *
 * Triggers (close when ANY fires), in priority order:
 *   1. liquidation proximity — liq within `liqProximityPct` of the mark (and on
 *      the LOSS side: above mark for a short, below for a long)
 *   2. max loss — uPnL ≤ −maxLossUsd, OR loss ≥ maxLossPctOfMargin of margin,
 *      OR margin fully eroded while losing
 *   3. unhealthy — health score < minHealthScore, OR a hard-exit alert fired
 *
 * Fail-safe: a non-finite/≤0 critical input (mark, margin, P&L) NEVER silently
 * disables every trigger via NaN comparisons. The affected trigger is skipped and
 * `dataDegraded` is set so the caller re-fetches + alerts rather than trusting a
 * no-exit on garbage data.
 */

export interface AutoExitThresholds {
  /** Close if |liq − mark| / mark ≤ this (e.g. 0.025 = within 2.5% of liq). ≤0 disables. */
  liqProximityPct: number;
  /** Close if unrealized P&L ≤ −this (USD). null disables. */
  maxLossUsd: number | null;
  /** Close if loss ≥ this fraction of margin (e.g. 0.5 = −50% of margin). null disables. */
  maxLossPctOfMargin: number | null;
  /** Close if health score < this (0–100). null disables. */
  minHealthScore: number | null;
  /** Health alert codes that force an exit on their own (e.g. ['regime-flip-8h']). */
  hardExitAlerts: string[];
}

export interface AutoExitInputs {
  coin: string;
  side: 'long' | 'short';
  /** Live mark price (> 0). */
  markPx: number;
  /** Liquidation price, or null when unknown/none. */
  liquidationPx: number | null;
  /** Unrealized P&L in USD (negative = losing). */
  unrealizedPnlUsd: number;
  /** Margin committed to the position (USD, > 0). */
  marginUsd: number;
  /** Latest health score (0–100), or null when not yet assessed. */
  healthScore: number | null;
  /** Health alert codes currently firing. */
  alerts: string[];
}

export interface AutoExitDecision {
  /** True ⇒ the caller should fire a reduce-only close. */
  exit: boolean;
  /** Machine + human reason, or null when not exiting. */
  reason: string | null;
  /**
   * True when a critical input (mark/margin/P&L) was unusable (NaN/±Inf/≤0) so a
   * trigger could not be evaluated. The caller must re-fetch + alert rather than
   * treat the no-exit as "all clear" — a broken feed is itself a risk signal.
   */
  dataDegraded?: boolean;
}

/** Finite, real number (rejects NaN, ±Infinity, null, undefined). */
function fin(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Decide whether to auto-close `inp`. PURE. Exit-only — never opens. */
export function shouldAutoExit(inp: AutoExitInputs, t: AutoExitThresholds): AutoExitDecision {
  const markOk = fin(inp.markPx) && inp.markPx > 0;
  const marginFinite = fin(inp.marginUsd);
  const marginOk = marginFinite && inp.marginUsd > 0;
  const pnlOk = fin(inp.unrealizedPnlUsd);
  let degraded = false;

  // 1. Liquidation proximity — the most important leveraged-overnight guard.
  //    Side-aware: only trust a liq price sitting on the LOSS side of the mark
  //    (above for a short, below for a long); a bogus liq on the profitable side
  //    must not auto-close a winner.
  if (t.liqProximityPct > 0) {
    if (markOk && fin(inp.liquidationPx)) {
      const liq = inp.liquidationPx;
      const onLossSide = inp.side === 'long' ? liq < inp.markPx : liq > inp.markPx;
      if (onLossSide) {
        const distPct = Math.abs(liq - inp.markPx) / inp.markPx;
        if (distPct <= t.liqProximityPct) {
          return { exit: true, reason: `liq-proximity: ${(distPct * 100).toFixed(2)}% from liquidation` };
        }
      }
    } else if (!markOk) {
      // Can't assess the primary guard with a bad mark — flag, don't silently pass.
      degraded = true;
    }
  }

  // 2a. Max loss — absolute USD floor.
  if (t.maxLossUsd != null) {
    if (pnlOk) {
      if (inp.unrealizedPnlUsd <= -Math.abs(t.maxLossUsd)) {
        return { exit: true, reason: `max-loss-usd: uPnL $${inp.unrealizedPnlUsd.toFixed(2)} ≤ -$${Math.abs(t.maxLossUsd)}` };
      }
    } else {
      degraded = true;
    }
  }

  // 2b. Max loss as a fraction of margin, plus the eroded-margin danger case.
  if (t.maxLossPctOfMargin != null) {
    if (marginOk && pnlOk) {
      const lossFrac = -inp.unrealizedPnlUsd / inp.marginUsd; // > 0 when losing
      if (lossFrac >= t.maxLossPctOfMargin) {
        return { exit: true, reason: `max-loss-pct: ${(lossFrac * 100).toFixed(0)}% of margin` };
      }
    } else if (pnlOk && inp.unrealizedPnlUsd < 0 && marginFinite && inp.marginUsd <= 0) {
      // Margin fully eroded while losing — exactly the danger the `> 0` guard skips.
      return { exit: true, reason: 'margin-eroded: margin ≤ 0 with an open loss' };
    } else if (!marginOk || !pnlOk) {
      degraded = true;
    }
  }

  // 3. Unhealthy — health engine score below the floor, or a hard adverse alert.
  if (t.minHealthScore != null && fin(inp.healthScore) && inp.healthScore < t.minHealthScore) {
    return { exit: true, reason: `unhealthy: health ${inp.healthScore.toFixed(0)} < ${t.minHealthScore}` };
  }
  if (t.hardExitAlerts.length > 0) {
    const hit = inp.alerts.find((a) => t.hardExitAlerts.includes(a));
    if (hit) return { exit: true, reason: `hard-alert: ${hit}` };
  }

  return degraded ? { exit: false, reason: null, dataDegraded: true } : { exit: false, reason: null };
}
