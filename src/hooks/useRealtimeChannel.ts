'use client';

/**
 * Generic Supabase realtime subscription hook (CLIENT-ONLY).
 *
 * Subscribes to Postgres INSERT/UPDATE events on one `table`, filtered to a
 * `sessionId`, via the anon browser client (RLS select-only). It also fetches an
 * initial snapshot so the panel is populated before the first realtime event.
 * Raw DB rows are mapped to domain objects by a PURE mapper (see
 * realtime-row-mappers.ts) and accumulated by id.
 *
 * The hook is deliberately thin: subscribe on mount, unsubscribe on unmount,
 * accumulate rows. All transform/sort logic is in the tested pure helpers.
 */

import { useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { getBrowserClient } from '@/lib/cockpit/supabase-browser';
import {
  accumulateById,
  type RealtimeRow,
} from './realtime-row-mappers';

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

export interface RealtimeChannelState<T> {
  rows: T[];
  /** True once the initial snapshot has been fetched (success or empty). */
  loaded: boolean;
  /** True while the realtime channel is SUBSCRIBED. */
  subscribed: boolean;
  /** Set if the initial fetch or subscription errored. */
  error: string | null;
}

const DEFAULT_LIMIT = 200;

/**
 * Subscribe to one session-scoped table. Returns accumulated rows + status.
 * Re-subscribes when `table` or `sessionId` change.
 */
export function useRealtimeChannel<T extends { id: string }>(
  opts: UseRealtimeChannelOptions<T>,
): RealtimeChannelState<T> {
  const { table, sessionId, map, compare, limit = DEFAULT_LIMIT } = opts;
  const orderColumn = opts.orderColumn ?? 'created_at';
  const orderAscending = opts.orderAscending ?? false;

  const [rows, setRows] = useState<T[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep latest map/compare in refs so the subscribe effect needn't depend on
  // them (they are typically inline closures). Assigned in an effect, never
  // during render.
  const mapRef = useRef(map);
  const compareRef = useRef(compare);
  useEffect(() => {
    mapRef.current = map;
    compareRef.current = compare;
  });

  useEffect(() => {
    // No session ⇒ stay inert. Any prior subscription's cleanup already reset
    // the rows; nothing to do here (no synchronous setState in the effect body).
    if (!sessionId) return;

    let active = true;
    const client = getBrowserClient();

    // 1) Initial snapshot.
    void client
      .from(table)
      .select('*')
      .eq('session_id', sessionId)
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

    // 2) Realtime channel for INSERT + UPDATE.
    const channel: RealtimeChannel = client
      .channel(`rt:${table}:${sessionId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table,
          filter: `session_id=eq.${sessionId}`,
        },
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
      // Reset on teardown (session/table/coin change or unmount) so the next
      // subscription starts clean. Done in cleanup, not the effect body.
      setRows([]);
      setLoaded(false);
      setSubscribed(false);
      setError(null);
    };
  }, [table, sessionId, limit, orderColumn, orderAscending]);

  return { rows, loaded, subscribed, error };
}
