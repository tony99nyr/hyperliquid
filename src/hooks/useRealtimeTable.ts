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
/** Fallback snapshot-refetch cadence — see useRealtimeChannel for the rationale.
 *  60s (was 20s): the PRIMARY update path for tables dropped from the realtime
 *  publication (leader feeds), so it stays cheap on Supabase egress. */
const REALTIME_REFETCH_MS = 60_000;

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
    const hidden = () => typeof document !== 'undefined' && document.hidden;

    // 1) Snapshot loader — authoritative latest-N rows. Run on mount, then
    // periodically + on tab-visible/reconnect as the realtime safety net (a
    // dropped/idle socket must not leave the table stale until a manual refresh).
    const loadSnapshot = async () => {
      let q = client.from(table).select('*');
      if (filterColumn && filterValue !== null) q = q.eq(filterColumn, filterValue);
      const { data, error: fetchErr } = await q
        .order(orderColumn, { ascending: orderAscending })
        .limit(limit);
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
    };

    // 2) Realtime channel lifecycle, gated by tab visibility. While HIDDEN we tear
    // the channel down so Supabase stops delivering postgres_changes messages (the
    // realtime-message + egress cost of a left-open-but-unwatched cockpit). On
    // VISIBLE we refetch a snapshot (catch up on anything missed) + resubscribe.
    let channel: RealtimeChannel | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;

    const subscribe = () => {
      if (channel) return; // already subscribed
      // Unique topic per subscribe — see useRealtimeChannel for the rationale.
      const topic = `rt-table:${table}:${pgFilter ?? '*'}:${uniqueTopicSuffix()}`;
      channel = client
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
            void loadSnapshot();
          }
        });
      // Safety-net refetch runs only while subscribed (i.e. visible).
      interval = setInterval(() => void loadSnapshot(), REALTIME_REFETCH_MS);
    };

    const unsubscribe = () => {
      if (interval) { clearInterval(interval); interval = null; }
      if (channel) { void client.removeChannel(channel); channel = null; }
      if (active) setSubscribed(false);
    };

    // Initial: always snapshot; subscribe only if currently visible.
    void loadSnapshot();
    if (!hidden()) subscribe();

    const onVisible = () => {
      if (hidden()) {
        unsubscribe(); // PAUSE realtime while the tab is not being watched
      } else {
        void loadSnapshot(); // catch up on whatever changed while paused
        subscribe();
      }
    };
    const onOnline = () => void loadSnapshot();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    if (typeof window !== 'undefined') window.addEventListener('online', onOnline);

    return () => {
      active = false;
      unsubscribe();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
      setRows([]);
      setLoaded(false);
      setSubscribed(false);
      setError(null);
    };
  }, [table, enabled, filterColumn, filterValue, limit, orderColumn, orderAscending]);

  return { rows, loaded, subscribed, error };
}
