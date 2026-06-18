/**
 * PURE filter logic for the Top-Traders rail chips (no React, no I/O — unit
 * tested). The rail ships a slim server-projected list (TopTraderRow[]); these
 * helpers narrow it client-side as the operator toggles the filter chips.
 *
 * Zero-import LEAF on purpose: it also owns the canonical TRADEABLE_COINS set +
 * normalizeCoin, which the SERVER-ONLY top-traders-service imports to compute
 * `tradesTradeableCoin`. Keeping these here (dependency-free) means the client
 * rail can import them without dragging node:fs into the browser bundle. Do NOT
 * add imports that pull in server-only modules.
 */

import type { TopTraderRow } from '@/lib/hyperliquid/top-traders-service';

/**
 * The coins the cockpit can trade. The rail's "tradeable only" filter keeps a
 * wallet only if its traded coins intersect this set. Single source of truth —
 * the cockpit coins prop + the server-side tradesTradeableCoin both derive from
 * it.
 */
export const TRADEABLE_COINS = ['ETH', 'BTC', 'HYPE'] as const;

const TRADEABLE_SET = new Set<string>(TRADEABLE_COINS);

/** Normalize a coin tag to its bare symbol (drops perp/spot/builder decoration). */
export function normalizeCoin(raw: string): string {
  // HL spot pairs look like "PURR/USDC"; builder/sub-markets like "@107" or
  // "xyz:GOLD". Take the leading symbol segment and upper-case it.
  return (raw.split('/')[0] ?? raw).trim().toUpperCase();
}

/** True when ANY of the supplied coin tags is in the tradeable set. PURE. */
export function coinsIntersectTradeable(coins: readonly string[]): boolean {
  return coins.some((c) => TRADEABLE_SET.has(normalizeCoin(c)));
}

/** The rail's filter chip state. All default to the un-narrowed list except
 *  `tradeableOnly`, which defaults ON (the cockpit only trades ETH/BTC/HYPE). */
export interface TraderFilterState {
  /** Show only wallets flagged CLEAN_BOOK. */
  cleanBook: boolean;
  /** Hide wallets carrying any risk flag (hasRisk). */
  hideAtRisk: boolean;
  /** Show only wallets whose traded coins intersect the tradeable set. */
  tradeableOnly: boolean;
}

export const DEFAULT_FILTER_STATE: TraderFilterState = {
  cleanBook: false,
  hideAtRisk: false,
  tradeableOnly: true,
};

/** Does a single row survive the active filters? Filters compose (AND). PURE. */
export function rowPasses(row: TopTraderRow, f: TraderFilterState): boolean {
  if (f.cleanBook && !row.cleanBook) return false;
  if (f.hideAtRisk && row.hasRisk) return false;
  if (f.tradeableOnly && !row.tradesTradeableCoin) return false;
  return true;
}

/** Apply the active filter chips to a rail list. Order is preserved. PURE. */
export function applyTraderFilters(
  rows: readonly TopTraderRow[],
  f: TraderFilterState,
): TopTraderRow[] {
  return rows.filter((r) => rowPasses(r, f));
}
