/**
 * PURE liquidation-proximity alert logic (no I/O — fixture-tested).
 *
 * Two-tier proximity alert for an open position: WARN when liquidation is within
 * `warnPct` of the mark, CRITICAL within `critPct`. The alert is NOTIFY-ONLY — it
 * never closes anything (that's the gated auto-exit action). Dedup is escalation-
 * based: only ping when the tier is new/higher than what was already alerted within
 * the window, so a persistent near-liq re-pings at most once per window (and a
 * WARN→CRITICAL escalation pings immediately).
 */

export type LiqTier = 'none' | 'warn' | 'critical';

export interface LiqAlertConfig {
  /** Warn when liq distance ≤ this % of mark (e.g. 8). */
  warnPct: number;
  /** Critical when liq distance ≤ this % of mark (e.g. 4). */
  critPct: number;
}

export const DEFAULT_LIQ_ALERT_CONFIG: LiqAlertConfig = { warnPct: 8, critPct: 4 };

export const TIER_RANK: Record<LiqTier, number> = { none: 0, warn: 1, critical: 2 };

/** Distance from mark to liquidation as a percent (always ≥ 0), or null if unknown. */
export function liqDistancePct(markPx: number | null, liqPx: number | null): number | null {
  if (markPx == null || liqPx == null || !(markPx > 0) || !Number.isFinite(liqPx)) return null;
  return (Math.abs(markPx - liqPx) / markPx) * 100;
}

/** Classify a liq-distance % into a tier. null distance → 'none'. PURE. */
export function liqTier(distPct: number | null, cfg: LiqAlertConfig = DEFAULT_LIQ_ALERT_CONFIG): LiqTier {
  if (distPct == null) return 'none';
  if (distPct <= cfg.critPct) return 'critical';
  if (distPct <= cfg.warnPct) return 'warn';
  return 'none';
}

/**
 * Should we ping for `newTier`, given the highest tier already alerted for this
 * position within the dedup window (`priorTierInWindow`)? PURE.
 * - none → never.
 * - else → only when it's HIGHER than what's already been sent in the window
 *   (so same-tier re-fires are suppressed until the window lapses, escalation pings).
 */
export function shouldAlert(newTier: LiqTier, priorTierInWindow: LiqTier): boolean {
  if (newTier === 'none') return false;
  return TIER_RANK[newTier] > TIER_RANK[priorTierInWindow];
}

/** Machine-parseable analysis_log line (dedup reads it back). `LIQ[tier] COIN ...`. */
export function liqLogLine(coin: string, tier: LiqTier, distPct: number | null, liqPx: number, markPx: number): string {
  const d = distPct == null ? '—' : `${distPct.toFixed(1)}%`;
  return `LIQ[${tier}] ${coin.toUpperCase()} — liq $${liqPx} vs mark $${markPx} (${d} away)`;
}

/** Parse `coin`→highest tier from prior analysis_log liq lines (for the dedup window). */
export function parseLogTier(message: string): { coin: string; tier: LiqTier } | null {
  const m = /^LIQ\[(none|warn|critical)\]\s+([A-Z0-9]+)/.exec(message);
  if (!m) return null;
  return { tier: m[1] as LiqTier, coin: m[2] };
}

/** Human Discord message for an operator page. */
export function formatLiqDiscord(input: {
  coin: string;
  side: 'long' | 'short';
  tier: LiqTier;
  distPct: number | null;
  liqPx: number;
  markPx: number;
}): string {
  const { coin, side, tier, distPct, liqPx, markPx } = input;
  const d = distPct == null ? '—' : `${distPct.toFixed(1)}%`;
  const head = tier === 'critical' ? '🚨 **NEAR LIQUIDATION**' : '⚠️ **Position nearing liquidation**';
  return [
    `${head} — ${side.toUpperCase()} ${coin.toUpperCase()}`,
    `liq \`$${liqPx}\` · mark \`$${markPx}\` · **${d} away**`,
    tier === 'critical'
      ? '→ Add margin now, or Reduce/Close — liquidation is close.'
      : '→ Consider Add margin (de-risk) to push liquidation away.',
  ].join('\n');
}
