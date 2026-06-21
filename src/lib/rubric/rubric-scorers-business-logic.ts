/**
 * PURE rubric pillar scorers. No I/O. Each returns a 0–100 display pillar (50 =
 * neutral); regime additionally exposes the MULTIPLIER ∈ [floor,1] that crushes
 * the additive envelope when the regime is hostile. Crisp formulas only — every
 * soft term has an explicit shape. Fixture-tested.
 */

import type { L2Book } from '@/lib/hyperliquid/orderbook-match';
import type { HealthTimeframe } from '@/lib/health/health-engine-types';
import type { MarketRegimeSignal } from '@/lib/strategy/analysis/market-regime-detector-cached';
import type { RubricConfig } from './rubric-config-types';
import type { AssetCtx, LeaderConsensus, LeaderPosForCoin, Side } from './rubric-types';

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
/** Map a ∈ [-1,1] to a 0–100 pillar (a=1→100, a=0→50, a=-1→0). */
const toPillar = (a: number): number => Math.round(50 + 50 * clamp(a, -1, 1));

/** Higher timeframes dominate for a swing read. */
const TF_WEIGHT: Record<HealthTimeframe, number> = { '1d': 0.4, '8h': 0.3, '1h': 0.2, '15m': 0.1 };

/** +1 for a regime that agrees with the side, −1 opposed, 0 neutral. */
function regimeSign(regime: MarketRegimeSignal['regime'], side: Side): number {
  if (regime === 'neutral') return 0;
  const bullish = regime === 'bullish';
  return (side === 'long') === bullish ? 1 : -1;
}

/** Weighted alignment of the multi-TF regime with `side`, ∈ [-1, 1]. */
function weightedAlignment(
  regimeByTf: Partial<Record<HealthTimeframe, MarketRegimeSignal>>,
  side: Side,
): number {
  let sum = 0;
  let wsum = 0;
  for (const tf of Object.keys(TF_WEIGHT) as HealthTimeframe[]) {
    const sig = regimeByTf[tf];
    if (!sig) continue;
    const w = TF_WEIGHT[tf];
    sum += w * regimeSign(sig.regime, side) * clamp(sig.confidence, 0, 1);
    wsum += w;
  }
  return wsum > 0 ? sum / wsum : 0;
}

/** Regime DISPLAY pillar (0–100). */
export function scoreRegimePillar(
  regimeByTf: Partial<Record<HealthTimeframe, MarketRegimeSignal>>,
  side: Side,
): number {
  return toPillar(weightedAlignment(regimeByTf, side));
}

/**
 * Regime MULTIPLIER ∈ [floor, 1]. Maps alignment [-1,1] → [floor,1] so a fully
 * opposed regime crushes the score to `floor`, aligned leaves it at 1, neutral
 * sits at the midpoint. This is what makes "great carry + hostile regime" score
 * low instead of averaging to "meh".
 */
export function regimeMultiplier(
  regimeByTf: Partial<Record<HealthTimeframe, MarketRegimeSignal>>,
  side: Side,
  cfg: RubricConfig,
): number {
  const a = weightedAlignment(regimeByTf, side);
  return cfg.regime.floor + (1 - cfg.regime.floor) * ((a + 1) / 2);
}

// --- Leader consensus ---

/** Freshness decay: exp(−Δt/τ). dt=0→1, dt=τ→1/e. */
export function freshness(deltaHours: number, tauHours: number): number {
  if (tauHours <= 0) return 1;
  return Math.exp(-Math.max(0, deltaHours) / tauHours);
}

/** Aggregate top-N leader positions into a signed net (positive = net long). */
export function aggregateLeaderConsensus(
  coin: string,
  positions: LeaderPosForCoin[],
  cfg: RubricConfig,
): LeaderConsensus {
  const top = positions.slice(0, cfg.consensus.topN);
  let net = 0;
  let longCount = 0;
  let shortCount = 0;
  for (const p of top) {
    const w = Math.max(0, p.conviction) * freshness(p.freshnessHours, cfg.consensus.tauHours) * (p.cleanBook ? 1 : cfg.consensus.dirtyBookWeight);
    net += (p.side === 'long' ? 1 : -1) * w;
    if (p.side === 'long') longCount++;
    else shortCount++;
  }
  return { coin, net, longCount, shortCount, topN: top.length };
}

/** Leaders pillar (0–100): how strongly the consensus agrees with `side`. */
export function scoreLeadersPillar(c: LeaderConsensus, side: Side, cfg: RubricConfig): number {
  const signedForSide = (side === 'long' ? 1 : -1) * c.net;
  return toPillar(signedForSide / Math.max(1e-9, cfg.consensus.fullScoreNet));
}

// --- Carry (funding) ---

/** Annualized funding % from the hourly rate. Positive = longs pay shorts. */
export function fundingApr(fundingHourly: number): number {
  return fundingHourly * 24 * 365 * 100;
}

/**
 * Carry pillar (0–100): the funding you RECEIVE on `side`. A short earns positive
 * funding (credit → >50); a long pays it (penalty → <50). Null ctx → neutral 50.
 */
export function scoreCarryPillar(ctx: AssetCtx | null, side: Side, cfg: RubricConfig): number {
  if (!ctx || !Number.isFinite(ctx.fundingHourly)) return 50;
  const apr = fundingApr(ctx.fundingHourly);
  const receivedApr = side === 'short' ? apr : -apr; // longs pay positive funding
  return toPillar(receivedApr / Math.max(1e-9, cfg.carry.fullScoreApr));
}

// --- Microstructure ---

export interface BookImbalance {
  /** (bidNotional − askNotional)/(sum) within the depth band, ∈ [-1,1]. + = bid-heavy. */
  imbalance: number;
  bidDepthUsd: number;
  askDepthUsd: number;
  spreadBps: number;
}

/** Bid/ask notional skew + spread within ±depthFrac of mid. PURE. */
export function scoreBookImbalance(book: L2Book, depthFrac: number): BookImbalance {
  const bestBid = book.bids[0]?.px ?? 0;
  const bestAsk = book.asks[0]?.px ?? 0;
  if (bestBid <= 0 || bestAsk <= 0) {
    return { imbalance: 0, bidDepthUsd: 0, askDepthUsd: 0, spreadBps: Number.POSITIVE_INFINITY };
  }
  const mid = (bestBid + bestAsk) / 2;
  const lo = mid * (1 - depthFrac);
  const hi = mid * (1 + depthFrac);
  let bidN = 0;
  let askN = 0;
  for (const b of book.bids) if (b.px >= lo) bidN += b.px * b.sz;
  for (const a of book.asks) if (a.px <= hi) askN += a.px * a.sz;
  const total = bidN + askN;
  const imbalance = total > 0 ? (bidN - askN) / total : 0;
  const spreadBps = ((bestAsk - bestBid) / mid) * 1e4;
  return { imbalance, bidDepthUsd: bidN, askDepthUsd: askN, spreadBps };
}

/** Micro pillar (0–100): order-flow imbalance favoring `side`, penalized by a wide spread. */
export function scoreMicroPillar(book: L2Book, side: Side, cfg: RubricConfig): number {
  const { imbalance, spreadBps } = scoreBookImbalance(book, cfg.gates.depthQueryFrac);
  const signedForSide = (side === 'long' ? 1 : -1) * imbalance;
  let pillar = toPillar(signedForSide / Math.max(1e-9, cfg.micro.imbalanceFullScoreAt));
  // Wide spread drags micro toward neutral-low (poor execution quality).
  if (Number.isFinite(spreadBps) && spreadBps > cfg.micro.maxSpreadBps) {
    const over = clamp((spreadBps - cfg.micro.maxSpreadBps) / cfg.micro.maxSpreadBps, 0, 1);
    pillar = Math.round(pillar * (1 - 0.5 * over));
  }
  return clamp(pillar, 0, 100);
}
