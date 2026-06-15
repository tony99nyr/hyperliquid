'use client';

/**
 * Realtime hook for the user's live position + P&L. Subscribes to BOTH the
 * `positions` table (the folded open position per coin) and the `pnl` table (the
 * periodic snapshots that carry mark price + unrealized P&L). The PositionPanel
 * reads the position for size/entry and the latest pnl snapshot for mark/uPnL.
 */

import { useRealtimeChannel } from './useRealtimeChannel';
import {
  byCreatedAtDesc,
  mapPnlRow,
  mapPositionRow,
  type PnlSnapshot,
  type PositionRow,
} from './realtime-row-mappers';

export interface PositionPnlState {
  /** Open positions (one per coin) folded from fills. */
  positions: PositionRow[];
  /** Most-recent pnl snapshot per coin (carries mark price + unrealized P&L). */
  latestPnlByCoin: Record<string, PnlSnapshot>;
  loaded: boolean;
  subscribed: boolean;
  error: string | null;
}

export function usePositionPnl(sessionId: string | null): PositionPnlState {
  // Positions are keyed (session, coin); they update in place. Sort by coin via
  // updatedAt desc so the freshest write surfaces first.
  const positions = useRealtimeChannel<PositionRow>({
    table: 'positions',
    sessionId,
    map: mapPositionRow,
    compare: (a, b) => b.updatedAt - a.updatedAt,
    orderColumn: 'updated_at',
  });

  const pnl = useRealtimeChannel<PnlSnapshot>({
    table: 'pnl',
    sessionId,
    map: mapPnlRow,
    compare: byCreatedAtDesc,
  });

  // Reduce pnl snapshots to the newest per coin (rows already newest-first).
  const latestPnlByCoin: Record<string, PnlSnapshot> = {};
  for (const snap of pnl.rows) {
    if (!latestPnlByCoin[snap.coin]) latestPnlByCoin[snap.coin] = snap;
  }

  return {
    positions: positions.rows.filter((p) => p.side !== 'flat'),
    latestPnlByCoin,
    loaded: positions.loaded && pnl.loaded,
    subscribed: positions.subscribed && pnl.subscribed,
    error: positions.error ?? pnl.error,
  };
}
