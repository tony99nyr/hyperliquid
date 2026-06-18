'use client';

/**
 * useLeaderActionsFeed — subscribes to the GLOBAL append-only `leader_actions`
 * event log (the trade-watch watcher's open/add/reduce/close/flip events across
 * every watched leader), realtime, newest-first. Un-session-scoped. READ-ONLY.
 *
 * Powers the left-rail live action feed ("0xecb6 ADD short ETH +258"). Pass an
 * address to scope to one leader (the trader-detail drawer's "recent activity").
 */

import {
  mapLeaderActionRow,
  byDetectedAtDesc,
  type LeaderActionRow,
} from './realtime-row-mappers';
import { useRealtimeTable, type RealtimeTableState } from './useRealtimeTable';

/** Default feed cap — plenty for the rail without unbounded growth. */
const DEFAULT_LIMIT = 50;

export function useLeaderActionsFeed(
  options: { leaderAddress?: string | null; limit?: number } = {},
): RealtimeTableState<LeaderActionRow> {
  const addr = options.leaderAddress ? options.leaderAddress.toLowerCase() : null;
  return useRealtimeTable<LeaderActionRow>({
    table: 'leader_actions',
    map: mapLeaderActionRow,
    compare: byDetectedAtDesc,
    filter: addr ? { column: 'leader_address', value: addr } : null,
    orderColumn: 'detected_at',
    orderAscending: false,
    limit: options.limit ?? DEFAULT_LIMIT,
  });
}
