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
        const client = getBrowserClient();
        // Branch 1 — TITLE (newest-first, drives latestId = the active scout session).
        // mode='paper' is REQUIRED: without it a live session ever titled 'scout*' would
        // surface as scout (paper) rows in the anon Scout panel (lane conflation).
        const { data: titled } = await client
          .from('sessions')
          .select('id')
          .eq('mode', 'paper')
          .or('title.eq.scout,title.like.scout-archived%')
          .order('created_at', { ascending: false });
        const ordered = (titled ?? []).map((r) => (r as { id: string }).id);
        const seen = new Set(ordered);

        // Branch 2 — HYPOTHESES-OWNER (membership completeness; mirrors the server
        // `scoutSessionIds` resolver): paper sessions that own a lane-tagged hypothesis but
        // aren't titled scout*. Appended AFTER the title branch so latestId is unchanged.
        const { data: hyp } = await client
          .from('hypotheses')
          .select('session_id')
          .not('lane', 'is', null)
          .order('created_at', { ascending: false })
          .limit(1000);
        const hypIds = Array.from(new Set((hyp ?? []).map((h) => (h as { session_id: string }).session_id))).filter(
          (id) => id && !seen.has(id),
        );
        if (hypIds.length > 0) {
          const { data: owners } = await client.from('sessions').select('id').eq('mode', 'paper').in('id', hypIds);
          for (const s of owners ?? []) {
            const id = (s as { id: string }).id;
            if (!seen.has(id)) {
              ordered.push(id);
              seen.add(id);
            }
          }
        }
        if (!cancelled) setIds(ordered);
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
