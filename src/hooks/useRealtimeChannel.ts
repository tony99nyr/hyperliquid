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
 * Fallback snapshot-refetch cadence. Realtime drives instant updates when the
 * socket is healthy; this is the SAFETY NET so a dropped/idle websocket (or a
 * missed event during a reconnect window) can never leave a panel stale until a
 * manual page refresh — the worst-case staleness is one interval. We also refetch
 * immediately on tab-visible + network-reconnect.
 *
 * 60s (was 20s): for tables DROPPED from the realtime publication (the high-churn
 * leader feeds) this poll is now the PRIMARY update path, so it must stay cheap on
 * Supabase egress; realtime-pushed tables still feel instant via the socket.
 */
const REALTIME_REFETCH_MS = 60_000;

/**
 * Per-effect-run uniqueness for the realtime channel topic.
 *
 * THE BUG THIS GUARDS AGAINST: Supabase's `client.channel(topic)` returns an
 * EXISTING channel object when one with that topic is still registered on the
 * client. Our teardown does a fire-and-forget `void client.removeChannel(...)`
 * (async). When the subscribe effect re-runs (sessionId resolves/changes, or a
 * remount/StrictMode double-invoke) BEFORE that async removal lands,
 * `client.channel(sameTopic)` hands back the already-SUBSCRIBED channel — and
 * the chained `.on('postgres_changes', …)` throws
 * `cannot add 'postgres_changes' callbacks … after subscribe()`, crashing render.
 *
 * Making the topic unique PER EFFECT RUN means a re-run can never collide with a
 * not-yet-removed prior channel: the new run always gets a brand-new, unsubscribed
 * channel. Overlap during async removal is harmless (different topics).
 */
let channelNonceCounter = 0;
function uniqueTopicSuffix(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback for environments without crypto.randomUUID (e.g. some test runners):
  // a monotonic counter + a non-time random component is sufficient for
  // per-run uniqueness within a single client instance.
  channelNonceCounter += 1;
  return `${channelNonceCounter}-${Math.random().toString(36).slice(2)}`;
}

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
    const hidden = () => typeof document !== 'undefined' && document.hidden;

    // 1) Snapshot loader — the authoritative latest-N rows. Run on mount, then
    // periodically + on tab-visible/reconnect as the realtime safety net.
    const loadSnapshot = async () => {
      const { data, error: fetchErr } = await client
        .from(table)
        .select('*')
        .eq('session_id', sessionId)
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

    // 2) Realtime channel lifecycle, gated by tab visibility. While HIDDEN the
    // channel is torn down so Supabase stops delivering messages (realtime + egress
    // cost of a left-open-but-unwatched cockpit); VISIBLE refetches + resubscribes.
    // Topic is unique PER SUBSCRIBE (uniqueTopicSuffix) so client.channel() can
    // never return a stale already-subscribed channel. `.on()` before `.subscribe()`.
    let channel: RealtimeChannel | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;

    const subscribe = () => {
      if (channel) return;
      const topic = `rt:${table}:${sessionId}:${uniqueTopicSuffix()}`;
      channel = client
        .channel(topic)
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
            // A dropped channel won't deliver events — lean on the fallback refetch
            // immediately so the panel recovers without waiting for the interval.
            void loadSnapshot();
          }
        });
      interval = setInterval(() => void loadSnapshot(), REALTIME_REFETCH_MS);
    };

    const unsubscribe = () => {
      if (interval) { clearInterval(interval); interval = null; }
      if (channel) { void client.removeChannel(channel); channel = null; }
      if (active) setSubscribed(false);
    };

    void loadSnapshot();
    if (!hidden()) subscribe();

    const onVisible = () => {
      if (hidden()) {
        unsubscribe();
      } else {
        void loadSnapshot();
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
