/**
 * Rubric engine types — shared between the PURE scorers/composer and the thin
 * I/O services. The rubric scores each asset×side deterministically (no LLM):
 * GATES (boolean kills) → REGIME multiplier (crushes a hostile regime) → an
 * ADDITIVE envelope (leaders + carry + micro). Both sides computed independently;
 * NO-TRADE is a first-class outcome. See docs + the 4-agent critique.
 */

import type { L2Book } from '@/lib/hyperliquid/orderbook-match';
import type { HealthTimeframe } from '@/lib/health/health-engine-types';
import type { MarketRegimeSignal } from '@/lib/strategy/analysis/market-regime-detector-cached';

export type Side = 'long' | 'short';
export type Badge = 'GO' | 'WATCH' | 'NO-EDGE';
export type NoTradeReason = 'below-bar' | 'margin-too-thin' | 'vol-contraction' | 'both-gated' | 'portfolio-cap' | null;

/** Per-asset funding/OI context from HL metaAndAssetCtxs. */
export interface AssetCtx {
  coin: string;
  /** Funding rate, HOURLY (decimal, e.g. 0.0000125 = +1.25bps/hr). Positive = longs pay shorts. */
  fundingHourly: number;
  openInterest: number;
  premium: number;
  markPx: number;
  oraclePx: number;
}

/** One leader's position on a coin, distilled for consensus aggregation. */
export interface LeaderPosForCoin {
  side: Side;
  /** Conviction proxy (size vs account, leverage) — already normalized ≥0. */
  conviction: number;
  /** Hours since the position was opened/last changed (drives freshness decay). */
  freshnessHours: number;
  cleanBook: boolean;
}

/** Aggregated leader signal for a coin (output of aggregateLeaderConsensus). */
export interface LeaderConsensus {
  coin: string;
  /** Signed weighted net: positive = leaders net long. */
  net: number;
  longCount: number;
  shortCount: number;
  topN: number;
}

/** Everything computeRubric needs for one asset, both sides. Point-in-time (asOf injected). */
export interface RubricInputs {
  coin: string;
  /** Epoch ms of the inputs — INJECTED, never Date.now() inside pure code. */
  asOf: number;
  markPx: number;
  /** Pre-computed regime per timeframe (cache-safe; caller clears indicator cache between TFs). */
  regimeByTf: Partial<Record<HealthTimeframe, MarketRegimeSignal>>;
  /** ATR as a percentile (0–1) over a lookback — vol-regime gate input. */
  atrPctile: number;
  /** Bollinger-bandwidth percentile (0–1) — vol-regime gate input. */
  bbBandwidthPctile: number;
  /** Absolute ATR (price units) for deriving entry/stop/target levels. */
  atr: number;
  book: L2Book;
  /** Taker-flow (CVD-style) from the recent tape, ∈ [−1,1]; null = tape unavailable. */
  takerFlow: number | null;
  consensus: LeaderConsensus;
  /** Funding/OI context; null when unavailable → carry pillar is neutral. */
  ctx: AssetCtx | null;
  /** True when a position is already open on this coin (enables the liq-inside-stop gate). */
  hasOpenPosition?: boolean;
  /** Current liquidation price when a position is open (for the liq-inside-stop gate). */
  liqPx?: number | null;
  /** Per-coin leader de-risk signal ∈ [0,1] (size leaving vs entering); >threshold
   *  vetoes a LONG when the (config-gated, default OFF) leader-derisk-veto is on. */
  derisk?: number | null;
}

export interface GateStates {
  bookTooThin: boolean;
  againstConfirmedHtf: boolean;
  roomTooTight: boolean;
  volContraction: boolean;
  liqInsideStop: boolean;
  /** LONG-only risk-off veto when tracked leaders are mass-de-risking. Config-gated
   *  (default OFF) until backtested as leader data accumulates. */
  leaderDeriskVeto: boolean;
}

export interface Levels {
  entryLow: number;
  entryHigh: number;
  invalidation: number;
  target: number;
  trigger: number;
  roomToTarget: number;
}

export interface SideScore {
  side: Side;
  /** Final 0–100 opportunity score (0 when any gate killed it). */
  opportunity: number;
  /** Display sub-scores 0–100 (regime is the display pillar; the multiplier is separate). */
  pillars: { regime: number; leaders: number; carry: number; micro: number };
  /** The regime MULTIPLIER ∈ [floor, 1] applied to the additive envelope. */
  regimeMultiplier: number;
  gates: GateStates;
  /** First failing gate name, or null. */
  killedBy: string | null;
  levels: Levels;
}

export interface RubricResult {
  coin: string;
  asOf: number;
  long: SideScore;
  short: SideScore;
  badge: Badge;
  chosenSide: Side | 'none';
  noTradeReason: NoTradeReason;
  /** 0–1 confidence (how clean the winning side is). Drives the UI dots. */
  confidence: number;
  /** Score uncertainty band on the chosen side (honest, not false precision). */
  scoreBandLow: number;
  scoreBandHigh: number;
}
