/**
 * Scout sizing policy — PURE (Tier-2 item, registered 2026-08-24 BEFORE first use).
 * Flat dollar-risk across coins makes a HYPE trade (ATR ~8%/day) carry 2-3× the
 * volatility exposure of a BTC trade (ATR ~2-4%/day) for the same ledger weight.
 * Vol-normalize instead: scale the floor risk INVERSELY with the coin's realized
 * daily vol so every position contributes a comparable vol-adjusted footprint.
 *
 *   suggested = clamp( floor × targetDailyVol / atrFrac, [minRisk, maxRisk] )
 *
 * POLICY, not a rule change: pre-registered lane ENTRY/EXIT rules are untouched, and
 * the kill/graduate bars are judged in R (risk-normalized), so re-weighting dollar
 * risk does not corrupt the running forward tests — it changes how many dollars ride
 * each R, not what an R is. The suggestion is computed deterministically in the cycle
 * snapshot; the executor's hard clamp (SCOUT_MAX_RISK_USD) remains the ceiling.
 */

export interface ScoutSizingConfig {
  /** The base floor risk (USD) a target-vol coin gets. */
  floorRiskUsd: number;
  /** The reference daily vol (fraction) — a coin at this ATR/px gets exactly the floor. */
  targetDailyVolFrac: number;
  /** Bounds on the suggestion (USD) — also keeps a degenerate ATR from exploding it. */
  minRiskUsd: number;
  maxRiskUsd: number;
}

export const DEFAULT_SCOUT_SIZING: ScoutSizingConfig = {
  floorRiskUsd: 8,
  targetDailyVolFrac: 0.04, // majors' typical daily ATR fraction
  minRiskUsd: 4,
  maxRiskUsd: 15, // = SCOUT_MAX_RISK_USD — the executor clamp; never suggest past it
};

/** Vol-normalized risk suggestion for one coin. `atrFrac` = daily ATR / price (the
 *  htf scan's ATR20/close). Null/degenerate vol → the plain floor (no fake precision). */
export function volNormalizedRiskUsd(
  atrFrac: number | null | undefined,
  cfg: ScoutSizingConfig = DEFAULT_SCOUT_SIZING,
): number {
  if (atrFrac == null || !Number.isFinite(atrFrac) || atrFrac <= 0) return cfg.floorRiskUsd;
  const raw = cfg.floorRiskUsd * (cfg.targetDailyVolFrac / atrFrac);
  return Math.round(Math.min(cfg.maxRiskUsd, Math.max(cfg.minRiskUsd, raw)) * 10) / 10;
}
