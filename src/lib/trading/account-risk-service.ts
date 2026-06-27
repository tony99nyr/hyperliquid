/**
 * Real per-coin risk for the operator's OWN HL account — the ACTUAL liquidation price
 * + effective leverage, which reflect posted isolated margin. The cockpit's position
 * fold only carries size/entry/leverage-SETTING, so its health formula (entry×lev)
 * ignores margin you add — showing a pessimistic, static liq distance. This reads the
 * truth straight from HL `clearinghouseState` (one call) so the panels can show the
 * real number. Empty when no account address (paper / unset) → panels fall back to
 * the formula.
 */

import 'server-only';
import { getHlAccountAddress } from '@/lib/auto-exit/auto-exit-config';
import { fetchClearinghouseState } from '@/lib/hyperliquid/hyperliquid-info-service';

export interface AccountRisk {
  /** Real HL liquidation price (reflects posted isolated margin), or null. */
  liqPx: number | null;
  /** Effective leverage = notional / margin used (reflects added margin), or null. */
  effLeverage: number | null;
  /** Isolated margin currently backing the position (USD). */
  marginUsed: number;
}

export async function fetchAccountRisk(): Promise<Record<string, AccountRisk>> {
  const address = getHlAccountAddress();
  if (!address) return {};
  const state = await fetchClearinghouseState(address, { uncached: true });
  const out: Record<string, AccountRisk> = {};
  for (const p of state.positions) {
    if (!p.szi) continue;
    const notional = Math.abs(p.positionValue);
    out[p.coin.toUpperCase()] = {
      liqPx: p.liquidationPx,
      effLeverage: p.marginUsed > 0 ? notional / p.marginUsed : null,
      marginUsed: p.marginUsed,
    };
  }
  return out;
}
