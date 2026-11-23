'use client';

/**
 * Un-session-scoped Supabase realtime subscription hook (CLIENT-ONLY).
 *
 * The sibling `useRealtimeChannel` filters by `session_id` — it serves the
 * per-session cockpit tables (analysis_log, positions, pnl, …). The leader
 * tables (`leader_positions`, `leader_actions`) populated by the trade-watch
 * watcher are GLOBAL — they have no `session_id` and are shared across every
 * session. This hook subscribes to the WHOLE table (optionally narrowed by a
 * single `column=eq.value` filter, e.g. `leader_address`) and fetches an initial
 * snapshot, mapping raw rows via a PURE mapper and accumulating by id.
 *
 * A thin wrapper: the snapshot, channel and visibility lifecycle live in
 * useRealtimeRows. READ-ONLY: anon client, RLS select-only.
 */

import type { RealtimeRow } from './realtime-row-mappers';
import { useRealtimeRows, type RealtimeRowsState } from './useRealtimeRows';

export interface UseRealtimeTableOptions<T extends { id: string }> {
  /** DB table name (e.g. 'leader_positions'). */
  table: string;
  /** PURE row → domain mapper. */
  map: (row: RealtimeRow) => T;
  /** Sort comparator applied after each accumulate. */
  compare: (a: T, b: T) => number;
  /**
   * Optional single-column equality filter, e.g. `{ column: 'leader_address',
   * value: '0xabc' }`. When null the hook subscribes to the WHOLE table. A
   * `value` of null/undefined makes the hook inert (no subscription) — used to
   * pause an address-scoped read until the address resolves.
   */
  filter?: { column: string; value: string | null } | null;
  /** Max rows to retain (oldest dropped after sort). Default 200. */
  limit?: number;
  /** Initial-fetch order column + direction. Default updated_at desc. */
  orderColumn?: string;
  orderAscending?: boolean;
  /**
   * When false the hook is inert (no fetch, no subscription). Lets a caller mount
   * the hook unconditionally (hooks rules) while gating it on, e.g., a session.
   */
  enabled?: boolean;
}

export type RealtimeTableState<T> = RealtimeRowsState<T>;

const DEFAULT_LIMIT = 200;

/**
 * Subscribe to one GLOBAL (un-session-scoped) table. Returns accumulated rows +
 * status. Re-subscribes when table / filter / order / enabled change.
 */
export function useRealtimeTable<T extends { id: string }>(
  opts: UseRealtimeTableOptions<T>,
): RealtimeTableState<T> {
  const { table, map, compare, limit = DEFAULT_LIMIT } = opts;
  const filterColumn = opts.filter?.column ?? null;
  const filterValue = opts.filter?.value ?? null;
  // An address-scoped read with a missing value is inert (caller intends to wait).
  const filterInert = filterColumn !== null && filterValue === null;
  const filter = filterColumn !== null && filterValue !== null ? { column: filterColumn, value: filterValue } : null;
  return useRealtimeRows({
    table,
    filter,
    topic: `rt-table:${table}:${filter ? `${filter.column}=eq.${filter.value}` : '*'}`,
    map,
    compare,
    limit,
    orderColumn: opts.orderColumn ?? 'updated_at',
    orderAscending: opts.orderAscending ?? false,
    enabled: opts.enabled !== false && !filterInert,
  });
}
