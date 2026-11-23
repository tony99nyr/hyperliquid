'use client';

/**
 * The shared core of `useRealtimeChannel` (session-scoped) and `useRealtimeTable`
 * (whole table or one `column=eq.value` filter). CLIENT-ONLY, READ-ONLY: anon
 * client, RLS select-only.
 *
 * It fetches a snapshot of the latest rows, subscribes to postgres_changes, and
 * applies each event with the pure `applyRealtimeChange`. The snapshot refetch is
 * the safety net for a dropped or idle socket. All transform and sort logic is in
 * the tested pure helpers in realtime-row-mappers.ts.
 */

import { useEffect, useRef, useState } from 'react';
import { isPageActive } from './page-activity';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { getBrowserClient } from '@/lib/cockpit/supabase-browser';
import { applyRealtimeChange, type RealtimeChangePayload, type RealtimeRow } from './realtime-row-mappers';

export interface RealtimeRowsOptions<T extends { id: string }> {
  /** DB table name (e.g. 'analysis_log'). */
  table: string;
  /** Optional single-column equality filter for the snapshot and the channel. */
  filter: { column: string; value: string } | null;
  /** Channel topic base. The hook adds a unique suffix per subscribe. */
  topic: string;
  /** PURE row → domain mapper. */
  map: (row: RealtimeRow) => T;
  /** Sort comparator applied after each accumulate. */
  compare: (a: T, b: T) => number;
  /** Max rows to retain (oldest dropped after sort). */
  limit: number;
  /** Snapshot order column and direction. */
  orderColumn: string;
  orderAscending: boolean;
  /** When false the hook is inert (no fetch, no subscription). */
  enabled: boolean;
}

export interface RealtimeRowsState<T> {
  rows: T[];
  /** True once the initial snapshot has been fetched (success or empty). */
  loaded: boolean;
  /** True while the realtime channel is SUBSCRIBED. */
  subscribed: boolean;
  /** Set if the initial fetch or subscription errored. */
  error: string | null;
}

/**
 * Fallback snapshot-refetch cadence. Realtime drives instant updates when the
 * socket is healthy; this is the SAFETY NET so a dropped/idle websocket (or a
 * missed event during a reconnect window) can never leave a panel stale until a
 * manual page refresh. The worst-case staleness is one interval. The hook also
 * refetches at once on tab-visible and network-reconnect.
 *
 * 60s (was 20s): for tables DROPPED from the realtime publication (the high-churn
 * leader feeds, rubric, heartbeat) this poll is the PRIMARY update path, so it
 * must stay cheap on Supabase egress.
 */
const REALTIME_REFETCH_MS = 60_000;

/**
 * Per-subscribe uniqueness for the realtime channel topic.
 *
 * THE BUG THIS GUARDS AGAINST: Supabase's `client.channel(topic)` returns an
 * EXISTING channel object when one with that topic is still registered on the
 * client. Teardown does a fire-and-forget `void client.removeChannel(...)`
 * (async). When the subscribe effect re-runs (sessionId resolves/changes, or a
 * remount/StrictMode double-invoke) BEFORE that async removal lands,
 * `client.channel(sameTopic)` hands back the already-SUBSCRIBED channel, and the
 * chained `.on('postgres_changes', …)` throws
 * `cannot add 'postgres_changes' callbacks … after subscribe()`, crashing render.
 *
 * A topic that is unique PER SUBSCRIBE means a re-run can never collide with a
 * not-yet-removed prior channel. Overlap during async removal is harmless.
 */
let channelNonceCounter = 0;
function uniqueTopicSuffix(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback for environments without crypto.randomUUID (some test runners).
  channelNonceCounter += 1;
  return `${channelNonceCounter}-${Math.random().toString(36).slice(2)}`;
}

export function useRealtimeRows<T extends { id: string }>(opts: RealtimeRowsOptions<T>): RealtimeRowsState<T> {
  const { table, topic, map, compare, limit, orderColumn, orderAscending, enabled } = opts;
  const filterColumn = opts.filter?.column ?? null;
  const filterValue = opts.filter?.value ?? null;

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
    // Inert ⇒ nothing to do. A prior subscription's cleanup already reset state.
    if (!enabled) return;

    let active = true;
    const client = getBrowserClient();
    const hidden = () => typeof document !== 'undefined' && document.hidden;
    const apply = (prev: T[], payload: RealtimeChangePayload) =>
      applyRealtimeChange(prev, payload, mapRef.current, compareRef.current, limit);

    // Snapshots in flight, by start order, each with the events that arrived after
    // it started. A snapshot may have been read before an event (a DELETE would
    // put the row back), so it replays them. Replay is safe: accumulate is by id
    // and a DELETE of a missing row is a no-op. A snapshot that resolves after a
    // later-started one was applied is stale, so the hook drops it. Known gap: a
    // replayed upsert whose DELETE was lost in a disconnect stays until the next
    // snapshot, which on an idle visible tab waits for activity or a reconnect.
    const inFlight = new Map<number, RealtimeChangePayload[]>();
    let started = 0;
    let applied = 0;

    // 1) Snapshot loader: the authoritative latest-N rows. Runs on mount, then
    // periodically and on tab-visible/reconnect as the realtime safety net.
    const loadSnapshot = async () => {
      const seq = ++started;
      const missed: RealtimeChangePayload[] = [];
      inFlight.set(seq, missed);
      try {
        let q = client.from(table).select('*');
        if (filterColumn && filterValue !== null) q = q.eq(filterColumn, filterValue);
        const { data, error: fetchErr } = await q.order(orderColumn, { ascending: orderAscending }).limit(limit);
        if (!active || seq < applied) return;
        if (fetchErr) {
          setError(fetchErr.message);
          setLoaded(true);
          return;
        }
        applied = seq;
        // Older snapshots still in flight are now stale: stop recording for them.
        for (const s of inFlight.keys()) if (s < seq) inFlight.delete(s);
        const mapped = (data ?? []).map((r) => mapRef.current(r as RealtimeRow));
        mapped.sort(compareRef.current);
        setRows(missed.reduce(apply, mapped.slice(0, limit)));
        setLoaded(true);
      } finally {
        inFlight.delete(seq);
      }
    };

    // 2) Realtime channel lifecycle, gated by tab visibility. While HIDDEN the
    // channel is torn down so Supabase stops delivering messages (the realtime +
    // egress cost of a left-open-but-unwatched cockpit). VISIBLE refetches and
    // resubscribes. `.on()` is always chained before `.subscribe()`.
    let channel: RealtimeChannel | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;

    const subscribe = () => {
      if (channel) return;
      const pgFilter = filterColumn && filterValue !== null ? `${filterColumn}=eq.${filterValue}` : undefined;
      channel = client
        .channel(`${topic}:${uniqueTopicSuffix()}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table, ...(pgFilter ? { filter: pgFilter } : {}) },
          (payload) => {
            if (!active) return;
            for (const missed of inFlight.values()) missed.push(payload);
            setRows((prev) => apply(prev, payload));
          },
        )
        .subscribe((status) => {
          if (!active) return;
          setSubscribed(status === 'SUBSCRIBED');
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            setError(`realtime ${status.toLowerCase()}`);
            // A dropped channel won't deliver events: refetch at once so the panel
            // recovers without waiting for the interval.
            void loadSnapshot();
          }
        });
      // The fallback refetch is idle-aware: a visible but unattended tab (a wall
      // monitor) stops hitting the snapshot endpoint (egress fix, Aug 2026).
      interval = setInterval(() => { if (isPageActive()) void loadSnapshot(); }, REALTIME_REFETCH_MS);
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
      // Reset on teardown so the next subscription starts clean. Done in cleanup,
      // not the effect body.
      setRows([]);
      setLoaded(false);
      setSubscribed(false);
      setError(null);
    };
  }, [table, topic, enabled, filterColumn, filterValue, limit, orderColumn, orderAscending]);

  return { rows, loaded, subscribed, error };
}
