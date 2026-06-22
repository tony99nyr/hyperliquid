/**
 * Rubric config shape (data/rubric/rubric-v*.json, loaded via loadActiveConfig).
 * All tunable knobs live here — frozen by ROLE not mined from history. Per-coin
 * overrides deep-merge over the base via resolveCoinConfig.
 */

export interface RubricConfig {
  version: string;
  /**
   * Coins the scan computes opportunities for (discovery universe). Wider than the
   * tradeable set — surface opportunities broadly, trade only the supported coins.
   * Keep to LIQUID HL perps (the book-too-thin gate guards thin names, but don't
   * invite the long tail). Add a coin here + (optionally) a perCoin gate override.
   */
  universe: string[];
  /** Badge / NO-TRADE cutoffs on the 0–100 score. */
  thresholds: {
    /** Below this on both sides → NO-EDGE (below-bar). */
    bar: number;
    /** At/above this → GO (else WATCH). */
    go: number;
    /** |long − short| below this → NO-EDGE (margin-too-thin). */
    margin: number;
  };
  /** Additive-envelope weights (sum ~1) for the non-regime pillars. */
  weights: { leaders: number; carry: number; micro: number };
  regime: {
    /** Multiplier floor when regime is fully opposed (crushes, not zeroes). */
    floor: number;
    /** Confidence at/above which a TF regime counts as "confirmed". */
    confirmedConfidence: number;
  };
  gates: {
    /** Min book depth (USD) within the query band, else book-too-thin. */
    minDepthUsd: number;
    /** Fraction of mark to query depth around (e.g. 0.001 = ±0.1%). */
    depthQueryFrac: number;
    /** Min reward:risk (target-dist / stop-dist), else room-too-tight. */
    minRoomToTarget: number;
    /** Vol-contraction gate fires when BOTH percentiles are below these. */
    volContractionAtrPctile: number;
    volContractionBbPctile: number;
    /** LONG-only risk-off veto when leader de-risk ≥ threshold. Default OFF
     *  (enabled:false) until a backtest validates it. Optional/absent = disabled. */
    leaderDeriskVeto?: { enabled: boolean; threshold: number };
  };
  consensus: {
    topN: number;
    /** Freshness decay time-constant (hours): weight = exp(−Δt/τ). */
    tauHours: number;
    /** Weight multiplier for a non-clean-book leader (penalize dirty books). */
    dirtyBookWeight: number;
    /** |net| at which the leaders pillar saturates to full score. */
    fullScoreNet: number;
  };
  carry: {
    /** Annualized funding % at which the carry pillar saturates. */
    fullScoreApr: number;
  };
  micro: {
    /** Book imbalance (0–1) at which the micro pillar saturates. */
    imbalanceFullScoreAt: number;
    /** Spread (bps) above which micro is penalized toward 0. */
    maxSpreadBps: number;
  };
  levels: {
    /** Entry-zone half-width as a fraction of ATR. */
    entryZoneAtrFrac: number;
    /** Stop distance = this × ATR. */
    stopAtrMult: number;
    /** Target distance = this × ATR. */
    targetAtrMult: number;
  };
  portfolio: {
    /** ETH+BTC same-direction correlation weight (count the pair as ~this of one bet). */
    btcEthBeta: number;
    /** HYPE crypto-beta weight. */
    hypeBeta: number;
    /** Max summed same-direction beta before a further leg is vetoed (GO→WATCH). */
    maxSameDirBeta: number;
  };
  /** Position-review verdict thresholds (over computeHealth score). */
  review: {
    /** Health below this → EXIT. */
    exitBelow: number;
    /** Health below this (with alerts) → TRIM. */
    trimBelow: number;
    /** Health above this (+ rubric GO same side, no alerts) → ADD. */
    addAbove: number;
  };
  /** Per-coin deep-partial overrides merged over the base. */
  perCoin?: Record<string, DeepPartial<RubricConfig>>;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
