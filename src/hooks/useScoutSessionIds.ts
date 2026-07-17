'use client';

/**
 * useScoutSessionIds — the autonomous scout's session ids (current + archived),
 * newest-first. Shared by the scout views so they agree on "which sessions are
 * the scout's": useScoutHypotheses filters the global hypotheses feed by the
 * membership `set`, and the ScoutPanel reads the `latestId` (the active scout
 * session) for the scout's open positions. Fetched once + refreshed every 60s so
 * a freshly-opened scout session is picked up. `enabled:false` keeps it inert
 * (controlled/test renders). Zero HL calls — a small Supabase read.
 */

import { useEffect, useMemo, useState } from 'react';
import { getBrowserClient } from '@/lib/cockpit/supabase-browser';

export interface ScoutSessionIds {
  /** All scout session ids, newest-first. null until the first fetch resolves. */
  ids: string[] | null;
  /** Membership set for filtering rows to scout sessions (null until loaded). */
  set: Set<string> | null;
  /** The most-recent scout session id (the active one), or null. */
  latestId: string | null;
}

export function useScoutSessionIds(enabled = true): ScoutSessionIds {
  const [ids, setIds] = useState<string[] | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const fetchIds = async (): Promise<void> => {
      try {
        const { data } = await getBrowserClient()
          .from('sessions')
          .select('id')
          // Mirrors the server resolver's title branch (scout + archived history) —
          // the bare eq('title','scout') went blind when the session was archived.
          .or('title.eq.scout,title.like.scout-archived%')
          .order('created_at', { ascending: false });
        if (!cancelled) setIds((data ?? []).map((r) => (r as { id: string }).id));
      } catch {
        if (!cancelled) setIds([]);
      }
    };
    void fetchIds();
    const t = setInterval(() => void fetchIds(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [enabled]);

  const set = useMemo(() => (ids == null ? null : new Set(ids)), [ids]);
  return { ids, set, latestId: ids?.[0] ?? null };
}
