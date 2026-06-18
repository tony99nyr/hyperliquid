/**
 * PURE adapter: a trade-watch `leader_positions` row → the `HlPosition` shape the
 * cockpit position panels already consume. leader_positions deliberately MIRRORS
 * HlPosition (see mapLeaderPositionRow), so this is a near-1:1 field copy; the two
 * fields the watcher doesn't store (marginUsed, maxLeverage) are derived/nulled.
 *
 * This lets the trader-detail drawer + Leader-vs-You read the watcher's live,
 * reconciled book from Supabase (zero HL load) and drop it straight into the
 * existing panels, with the on-demand HL proxy kept as the fallback for
 * addresses the watcher doesn't cover. No React, no I/O — unit tested.
 */

import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';
import type { LeaderPositionRow } from './realtime-row-mappers';

export function leaderPositionRowToHlPosition(r: LeaderPositionRow): HlPosition {
  const lev = r.leverage;
  // leader_positions stores neither marginUsed nor maxLeverage. Derive a sane
  // margin (notional / leverage) for display; leave maxLeverage null (the
  // approval popup resolves the coin's max server-side regardless).
  const marginUsed =
    lev && lev > 0 ? Math.round((r.positionValue / lev) * 100) / 100 : r.positionValue;
  return {
    coin: r.coin,
    side: r.side,
    szi: r.szi,
    size: r.size,
    entryPx: r.entryPx,
    positionValue: r.positionValue,
    unrealizedPnl: r.unrealizedPnl,
    returnOnEquity: r.returnOnEquity,
    leverage: r.leverage,
    leverageType: r.leverageType,
    liquidationPx: r.liquidationPx,
    marginUsed,
    maxLeverage: null,
  };
}

/** Map a whole set of leader rows → HlPosition[] (open positions only; size>0). */
export function leaderPositionRowsToHlPositions(rows: readonly LeaderPositionRow[]): HlPosition[] {
  return rows.filter((r) => r.size > 0).map(leaderPositionRowToHlPosition);
}

/** The most recent account value across a leader's rows (they share one). */
export function accountValueFromRows(rows: readonly LeaderPositionRow[]): number | null {
  for (const r of rows) {
    if (r.accountValueUsd != null && Number.isFinite(r.accountValueUsd)) return r.accountValueUsd;
  }
  return null;
}
