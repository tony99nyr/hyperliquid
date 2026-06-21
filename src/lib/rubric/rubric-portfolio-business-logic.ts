/**
 * PURE portfolio crypto-beta cap. The composer scores each asset in isolation;
 * this is the cross-asset guard so "short ETH + short BTC + short HYPE" isn't
 * silently one giant 2.5×-leverage "crypto down" bet. ETH+BTC are highly
 * correlated → the same-direction PAIR counts as ~btcEthBeta (not 2×); HYPE adds
 * its own beta. A GO leg that would push same-direction exposure over the cap is
 * downgraded to WATCH (still shown) with noTradeReason 'portfolio-cap'. No I/O.
 */

import type { RubricConfig } from './rubric-config-types';
import type { RubricResult, Side } from './rubric-types';

export interface OpenLeg {
  coin: string;
  side: Side;
}

/** Summed crypto-beta of a set of same-direction coins (ETH+BTC pair discounted). */
export function directionExposure(coins: Set<string>, cfg: RubricConfig): number {
  const has = (c: string) => coins.has(c.toUpperCase());
  let exp = 0;
  const eth = has('ETH');
  const btc = has('BTC');
  if (eth && btc) exp += cfg.portfolio.btcEthBeta; // correlated pair counts as ~one larger bet
  else if (eth || btc) exp += 1; // a single major
  if (has('HYPE')) exp += cfg.portfolio.hypeBeta;
  return exp;
}

/**
 * Apply the cap across all per-asset results given the currently open legs.
 * Each GO leg is tested as if added to the same-direction book; over-cap → WATCH.
 */
export function applyPortfolioCaps(
  results: RubricResult[],
  openPositions: OpenLeg[],
  cfg: RubricConfig,
): RubricResult[] {
  const openLong = new Set(openPositions.filter((p) => p.side === 'long').map((p) => p.coin.toUpperCase()));
  const openShort = new Set(openPositions.filter((p) => p.side === 'short').map((p) => p.coin.toUpperCase()));

  return results.map((r) => {
    if (r.chosenSide === 'none') return r;
    const base = r.chosenSide === 'long' ? openLong : openShort;
    if (base.has(r.coin.toUpperCase())) return r; // already in the book on this side — not a new leg
    const withLeg = new Set(base);
    withLeg.add(r.coin.toUpperCase());
    const exposure = directionExposure(withLeg, cfg);
    if (exposure > cfg.portfolio.maxSameDirBeta) {
      return { ...r, badge: 'WATCH', chosenSide: 'none', noTradeReason: 'portfolio-cap' };
    }
    return r;
  });
}
