'use client';

/**
 * Generic Supabase realtime subscription hook (CLIENT-ONLY).
 *
 * Subscribes to Postgres INSERT/UPDATE/DELETE events on one `table`, filtered to a
 * `sessionId`, via the anon browser client (RLS select-only). It also fetches an
 * initial snapshot so the panel is populated before the first realtime event.
 * Raw DB rows are mapped to domain objects by a PURE mapper (see
 * realtime-row-mappers.ts) and accumulated by id.
 *
 * A thin wrapper: the snapshot, channel and visibility lifecycle live in
 * useRealtimeRows.
 */

import type { RealtimeRow } from './realtime-row-mappers';
import { useRealtimeRows, type RealtimeRowsState } from './useRealtimeRows';

export interface UseRealtimeChannelOptions<T extends { id: string }> {
  /** DB table name (e.g. 'analysis_log'). */
  table: string;
  /** Session to filter on; when null the hook is inert (no subscription). */
  sessionId: string | null;
  /** PURE row → domain mapper. */
  map: (row: RealtimeRow) => T;
  /** Sort comparator applied after each accumulate. */
  compare: (a: T, b: T) => number;
  /** Max rows to retain (oldest dropped). Default 200. */
  limit?: number;
  /** Initial-fetch order column + direction (default created_at desc). */
  orderColumn?: string;
  orderAscending?: boolean;
}

export type RealtimeChannelState<T> = RealtimeRowsState<T>;

/**
 * Subscribe to one session-scoped table. Returns accumulated rows + status.
 * Re-subscribes when `table` or `sessionId` change.
 */
export function useRealtimeChannel<T extends { id: string }>(
  opts: UseRealtimeChannelOptions<T>,
): RealtimeChannelState<T> {
  const { table, sessionId, map, compare, limit } = opts;
  return useRealtimeRows({
    table,
    filter: sessionId ? { column: 'session_id', value: sessionId } : null,
    topic: `rt:${table}:${sessionId}`,
    map,
    compare,
    limit,
    orderColumn: opts.orderColumn ?? 'created_at',
    orderAscending: opts.orderAscending ?? false,
    // No session ⇒ inert (no fetch, no subscription).
    enabled: Boolean(sessionId),
  });
}
