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
 * It reuses the unique-topic-per-effect-run fix from useRealtimeChannel (a stale
 * channel can never be handed back during async removeChannel), and the pure
 * helpers in realtime-row-mappers.ts. READ-ONLY — anon client, RLS select-only.
 */

import { useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { getBrowserClient } from '@/lib/cockpit/supabase-browser';
import { accumulateById, type RealtimeRow } from './realtime-row-mappers';

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

export interface RealtimeTableState<T> {
  rows: T[];
  /** True once the initial snapshot has been fetched (success or empty). */
  loaded: boolean;
  /** True while the realtime channel is SUBSCRIBED. */
  subscribed: boolean;
  /** Set if the initial fetch or subscription errored. */
  error: string | null;
}

const DEFAULT_LIMIT = 200;

let nonceCounter = 0;
function uniqueTopicSuffix(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  nonceCounter += 1;
  return `${nonceCounter}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Subscribe to one GLOBAL (un-session-scoped) table. Returns accumulated rows +
 * status. Re-subscribes when table / filter / order / enabled change.
 */
export function useRealtimeTable<T extends { id: string }>(
  opts: UseRealtimeTableOptions<T>,
): RealtimeTableState<T> {
  const { table, map, compare, limit = DEFAULT_LIMIT } = opts;
  const orderColumn = opts.orderColumn ?? 'updated_at';
  const orderAscending = opts.orderAscending ?? false;
  const filterColumn = opts.filter?.column ?? null;
  const filterValue = opts.filter?.value ?? null;
  // An address-scoped read with a missing value is inert (caller intends to wait).
  const filterInert = filterColumn !== null && filterValue === null;
  const enabled = opts.enabled !== false && !filterInert;

  const [rows, setRows] = useState<T[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mapRef = useRef(map);
  const compareRef = useRef(compare);
  useEffect(() => {
    mapRef.current = map;
    compareRef.current = compare;
  });

  useEffect(() => {
    if (!enabled) return;

    let active = true;
    const client = getBrowserClient();
    const pgFilter =
      filterColumn && filterValue !== null ? `${filterColumn}=eq.${filterValue}` : undefined;

    // 1) Initial snapshot.
    let q = client.from(table).select('*');
    if (filterColumn && filterValue !== null) q = q.eq(filterColumn, filterValue);
    void q
      .order(orderColumn, { ascending: orderAscending })
      .limit(limit)
      .then(({ data, error: fetchErr }) => {
        if (!active) return;
        if (fetchErr) {
          setError(fetchErr.message);
          setLoaded(true);
          return;
        }
        const mapped = (data ?? []).map((r) => mapRef.current(r as RealtimeRow));
        mapped.sort(compareRef.current);
        setRows(mapped.slice(0, limit));
        setLoaded(true);
      });

    // 2) Realtime channel for INSERT + UPDATE (+ DELETE handled by accumulate).
    // Unique topic per effect run — see useRealtimeChannel for the rationale.
    const topic = `rt-table:${table}:${pgFilter ?? '*'}:${uniqueTopicSuffix()}`;
    const channel: RealtimeChannel = client
      .channel(topic)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table, ...(pgFilter ? { filter: pgFilter } : {}) },
        (payload) => {
          if (!active) return;
          const raw = (payload.new ?? payload.old) as RealtimeRow | undefined;
          if (!raw) return;
          const mapped = mapRef.current(raw);
          setRows((prev) => {
            const acc = accumulateById(prev, mapped, compareRef.current);
            return acc.slice(0, limit);
          });
        },
      )
      .subscribe((status) => {
        if (!active) return;
        setSubscribed(status === 'SUBSCRIBED');
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setError(`realtime ${status.toLowerCase()}`);
        }
      });

    return () => {
      active = false;
      void client.removeChannel(channel);
      setRows([]);
      setLoaded(false);
      setSubscribed(false);
      setError(null);
    };
  }, [table, enabled, filterColumn, filterValue, limit, orderColumn, orderAscending]);

  return { rows, loaded, subscribed, error };
}
