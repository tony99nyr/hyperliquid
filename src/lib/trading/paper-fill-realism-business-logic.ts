/**
 * PURE paper-fill realism — applied to the paper fill PRICE so the recorded
 * `fill.px` (and thus realized P&L) is conservative, not optimistic. The prior
 * model walked a FRESH book at fill time and recorded its VWAP verbatim, which
 * (a) let staleness HELP — a book that drifted your way after the decision gave a
 * better-than-decision price (favorable-selection), and (b) ignored market impact
 * on thin books (phantom depth). Both inflated realized P&L UPSTREAM of any
 * scorecard haircut, which a flat haircut can't undo. This fixes it at the source.
 *
 * Three adjustments, all making the fill WORSE (never better):
 *  1. Favorable-selection clamp: the effective base price is no better than the
 *     decision-time mark — staleness can hurt you, never help.
 *  2. Size/depth impact: adverse slippage scales up when the order is large vs the
 *     depth available within a realistic band (sweeping a thin book costs more).
 *  3. Adverse offset: a per-coin base slippage in the unfavorable direction.
 *
 * Paper-only (live fills are real). No I/O. Fixture-tested.
 */

import type { OrderSide } from '@/types/fill';
import type { L2Book } from '@/lib/hyperliquid/orderbook-match';

/** Per-coin base adverse slippage (bps, applied to the fill price). Thin books cost more. */
export const PER_COIN_SLIPPAGE_BPS: Record<string, number> = { BTC: 12, ETH: 5, SOL: 6, HYPE: 7 };
export const DEFAULT_SLIPPAGE_BPS = 8;
export function baseSlippageBps(coin: string): number {
  return PER_COIN_SLIPPAGE_BPS[coin.toUpperCase()] ?? DEFAULT_SLIPPAGE_BPS;
}

/** Depth (USD notional) resting within ±bandFrac of best on the side an order consumes. */
export function bandDepthUsd(side: OrderSide, book: L2Book, bandFrac = 0.003): number {
  const levels = side === 'buy' ? book.asks : book.bids;
  if (!levels || levels.length === 0) return 0;
  const best = levels[0]?.px;
  if (!(best > 0)) return 0;
  const lo = side === 'buy' ? best : best * (1 - bandFrac);
  const hi = side === 'buy' ? best * (1 + bandFrac) : best;
  let usd = 0;
  for (const l of levels) {
    if (!(l.px > 0) || !(l.sz > 0)) continue;
    if (l.px < lo || l.px > hi) continue;
    usd += l.px * l.sz;
  }
  return usd;
}

export interface FillRealismInput {
  side: OrderSide;
  /** VWAP from walking the fresh book. */
  bookAvgPx: number;
  /** Mark at the moment the decision was made (favorable-selection clamp). */
  decisionPx?: number | null;
  /** Notional that filled (for the impact ratio). */
  filledNotionalUsd: number;
  /** Resting depth within the band (denominator of the impact ratio). */
  bandDepthUsd: number;
  /** Per-coin base adverse slippage (bps). */
  baseBps: number;
  /** Cap on the impact multiplier (default 3×). */
  maxImpactMult?: number;
}

export interface FillRealismResult {
  /** Conservative fill price (worse than or equal to the raw book VWAP). */
  effectivePx: number;
  appliedBps: number;
  impactMult: number;
}

export function applyFillRealism(inp: FillRealismInput): FillRealismResult {
  if (!(inp.bookAvgPx > 0)) return { effectivePx: inp.bookAvgPx, appliedBps: 0, impactMult: 1 };

  // 1) favorable-selection clamp — base is no better than the decision mark.
  let base = inp.bookAvgPx;
  if (inp.decisionPx != null && inp.decisionPx > 0) {
    base = inp.side === 'buy' ? Math.max(inp.bookAvgPx, inp.decisionPx) : Math.min(inp.bookAvgPx, inp.decisionPx);
  }

  // 2) size/depth impact — sweeping a thin book costs more.
  const depth = inp.bandDepthUsd > 0 ? inp.bandDepthUsd : inp.filledNotionalUsd || 1;
  const ratio = depth > 0 ? inp.filledNotionalUsd / depth : 0;
  const impactMult = Math.min(inp.maxImpactMult ?? 3, 1 + Math.max(0, ratio));
  const appliedBps = inp.baseBps * impactMult;

  // 3) adverse offset (buy fills higher, sell fills lower).
  const sign = inp.side === 'buy' ? 1 : -1;
  const effectivePx = base * (1 + (sign * appliedBps) / 10_000);
  return { effectivePx, appliedBps, impactMult };
}
