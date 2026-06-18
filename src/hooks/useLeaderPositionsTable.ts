'use client';

/**
 * useLeaderPositionsTable — subscribes to the GLOBAL `leader_positions` table
 * (the trade-watch watcher's live, reconciled book of every watched leader),
 * realtime. Un-session-scoped (these rows have no session_id). READ-ONLY.
 *
 * This is the cockpit's replacement for hitting the on-demand HL proxy for
 * leader/trader positions: the watcher already keeps Supabase fresh, so the UI
 * reads Supabase (zero HL load, no 429 risk, always-fresh). Powers the rail's
 * "has position" filter, Leader-vs-You, and the trader-detail drawer.
 *
 * Pass no address to subscribe to the WHOLE table (the rail needs every leader's
 * held coins); pass an address to scope to one leader (the panels).
 */

import {
  mapLeaderPositionRow,
  byUpdatedAtDesc,
  type LeaderPositionRow,
} from './realtime-row-mappers';
import { useRealtimeTable, type RealtimeTableState } from './useRealtimeTable';

/**
 * @param leaderAddress when provided, scopes the read to that leader; when
 *   omitted/null subscribes to the whole table. (A `null` value passed
 *   explicitly is treated as "subscribe to all" here — callers that want an
 *   inert read should not mount this address-scoped variant.)
 */
export function useLeaderPositionsTable(
  leaderAddress?: string | null,
): RealtimeTableState<LeaderPositionRow> {
  const addr = leaderAddress ? leaderAddress.toLowerCase() : null;
  return useRealtimeTable<LeaderPositionRow>({
    table: 'leader_positions',
    map: mapLeaderPositionRow,
    compare: byUpdatedAtDesc,
    // Subscribe to the whole table when no address; otherwise narrow to one leader.
    filter: addr ? { column: 'leader_address', value: addr } : null,
    orderColumn: 'updated_at',
    orderAscending: false,
    limit: 400,
  });
}
