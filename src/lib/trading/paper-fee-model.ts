/**
 * Paper fill fee model (PURE). Documents the assumed Hyperliquid fee schedule
 * used to estimate `feeUsd` on paper fills so paper P&L stays economically
 * faithful (ADR-0001 / ADR-0004). Live fills use the REAL fee from the HL
 * confirmation; this model is paper-only.
 *
 * Assumed HL perp fee schedule (base tier, no referral/staking discounts):
 *   - TAKER: 0.045% = 4.5 bps of notional
 *   - MAKER: 0.015% = 1.5 bps of notional
 *
 * Source: Hyperliquid's published perpetuals fee schedule (base tier). These are
 * intentionally conservative defaults; tune via config later if the trial shows
 * drift. A paper order that walks the book is a TAKER (it crosses the spread); a
 * resting limit that does not cross would be a MAKER — but the cockpit paper
 * model treats any order that fills against the current book as a taker, which is
 * the honest worst case for a market-style entry. See ADR-0004.
 */

/** HL base-tier taker fee in basis points (1 bp = 0.01%). */
export const HL_TAKER_FEE_BPS = 4.5;
/** HL base-tier maker fee in basis points. */
export const HL_MAKER_FEE_BPS = 1.5;

export type FeeRole = 'taker' | 'maker';

/**
 * Fee in USD = notional * (bps / 10_000). A paper fill that consumes resting
 * book liquidity is a taker; pass 'maker' only for a non-crossing resting order.
 */
export function modelFeeUsd(notionalUsd: number, role: FeeRole = 'taker'): number {
  if (!(notionalUsd > 0)) return 0;
  const bps = role === 'maker' ? HL_MAKER_FEE_BPS : HL_TAKER_FEE_BPS;
  return notionalUsd * (bps / 10_000);
}
