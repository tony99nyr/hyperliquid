/**
 * PURE auto-exit decision (Layer 1) — the heart of the autonomous safety net.
 *
 * Given one open position's live risk inputs + thresholds, decide whether to
 * CLOSE it (reduce-only). EXIT-ONLY by construction: this returns a boolean +
 * reason; it never opens/adds/flips. No I/O, no keys, no execution — the caller
 * (the risk-exit route) re-verifies and fires the reduce-only close. Fully unit-
 * tested. See docs/LIVE_AUTO_EXIT.md.
 *
 * Triggers (close when ANY fires), in priority order:
 *   1. liquidation proximity — liq within `liqProximityPct` of the mark
 *   2. max loss — uPnL ≤ −maxLossUsd, OR loss ≥ maxLossPctOfMargin of margin
 *   3. unhealthy — health score < minHealthScore, OR a hard-exit alert fired
 */

export interface AutoExitThresholds {
  /** Close if |liq − mark| / mark ≤ this (e.g. 0.025 = within 2.5% of liq). */
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
}

const NO_EXIT: AutoExitDecision = { exit: false, reason: null };

/** Decide whether to auto-close `inp`. PURE. Exit-only — never opens. */
export function shouldAutoExit(inp: AutoExitInputs, t: AutoExitThresholds): AutoExitDecision {
  // 1. Liquidation proximity — the most important leveraged-overnight guard.
  if (inp.liquidationPx != null && inp.markPx > 0) {
    const distPct = Math.abs(inp.liquidationPx - inp.markPx) / inp.markPx;
    if (distPct <= t.liqProximityPct) {
      return { exit: true, reason: `liq-proximity: ${(distPct * 100).toFixed(2)}% from liquidation` };
    }
  }

  // 2. Max loss — absolute USD floor, then % of margin.
  if (t.maxLossUsd != null && inp.unrealizedPnlUsd <= -Math.abs(t.maxLossUsd)) {
    return { exit: true, reason: `max-loss-usd: uPnL $${inp.unrealizedPnlUsd.toFixed(2)} ≤ -$${Math.abs(t.maxLossUsd)}` };
  }
  if (t.maxLossPctOfMargin != null && inp.marginUsd > 0) {
    const lossFrac = -inp.unrealizedPnlUsd / inp.marginUsd; // > 0 when losing
    if (lossFrac >= t.maxLossPctOfMargin) {
      return { exit: true, reason: `max-loss-pct: ${(lossFrac * 100).toFixed(0)}% of margin` };
    }
  }

  // 3. Unhealthy — health engine score below the floor, or a hard adverse alert.
  if (t.minHealthScore != null && inp.healthScore != null && inp.healthScore < t.minHealthScore) {
    return { exit: true, reason: `unhealthy: health ${inp.healthScore.toFixed(0)} < ${t.minHealthScore}` };
  }
  if (t.hardExitAlerts.length > 0) {
    const hit = inp.alerts.find((a) => t.hardExitAlerts.includes(a));
    if (hit) return { exit: true, reason: `hard-alert: ${hit}` };
  }

  return NO_EXIT;
}
