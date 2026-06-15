/**
 * PURE order-book derivations for the useHlOrderbook hook + Orderbook island.
 * Given a LiveMarketState (or its bids/asks), compute spread / mid / depth. No
 * I/O, no React — fixture-testable.
 */

import type { LiveMarketState, MarketBookLevel } from '@/types/market';

export interface BookSummary {
  /** Best bid price (highest), or null when no bids. */
  bestBid: number | null;
  /** Best ask price (lowest), or null when no asks. */
  bestAsk: number | null;
  /** (bestBid + bestAsk) / 2, or null when either side is empty. */
  mid: number | null;
  /** bestAsk − bestBid, or null when either side is empty. */
  spread: number | null;
  /** spread / mid as a fraction (e.g. 0.0005 = 5 bps), or null. */
  spreadPct: number | null;
}

/** Compute best bid/ask, mid, and spread from a book. PURE. */
export function summarizeBook(bids: MarketBookLevel[], asks: MarketBookLevel[]): BookSummary {
  const bestBid = bids.length > 0 ? bids[0].px : null;
  const bestAsk = asks.length > 0 ? asks[0].px : null;
  if (bestBid === null || bestAsk === null) {
    return { bestBid, bestAsk, mid: null, spread: null, spreadPct: null };
  }
  const mid = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  const spreadPct = mid > 0 ? spread / mid : null;
  return { bestBid, bestAsk, mid, spread, spreadPct };
}

/**
 * Add a running cumulative size to each level (best-first). Used by the
 * Orderbook island to draw depth bars. PURE.
 */
export interface DepthLevel extends MarketBookLevel {
  /** Cumulative size from the best level down to (and including) this one. */
  cumSz: number;
}

export function withCumulativeDepth(levels: MarketBookLevel[]): DepthLevel[] {
  let cum = 0;
  return levels.map((l) => {
    cum += l.sz;
    return { ...l, cumSz: cum };
  });
}

/** The "lastPx" the UI should show: prefer last trade, fall back to mid. PURE. */
export function effectiveLastPx(state: Pick<LiveMarketState, 'lastPx' | 'midPx'>): number | null {
  if (state.lastPx !== null) return state.lastPx;
  return state.midPx;
}
