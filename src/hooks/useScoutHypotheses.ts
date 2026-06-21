'use client';

/**
 * useScoutHypotheses — the autonomous scout's track record, live, SCOPED to scout
 * sessions (title='scout') so the ScoutPanel never shows manual trades as scout
 * activity. Subscribes to the global `hypotheses` table (realtime), then filters
 * to the scout's own sessions (ids fetched + periodically refreshed). Zero client
 * HL calls. Mirrors useRubricScores (realtime, enabled-gated).
 */

import { useEffect, useMemo, useState } from 'react';
import { getBrowserClient } from '@/lib/cockpit/supabase-browser';
import { mapHypothesisRow, byCreatedAtDesc } from './realtime-row-mappers';
import { useRealtimeTable, type RealtimeTableState } from './useRealtimeTable';
import type { Hypothesis } from '@/types/cockpit';

export function useScoutHypotheses(opts: { enabled?: boolean } = {}): RealtimeTableState<Hypothesis> {
  const enabled = opts.enabled ?? true;
  const all = useRealtimeTable<Hypothesis>({
    table: 'hypotheses',
    map: mapHypothesisRow,
    compare: byCreatedAtDesc,
    filter: null,
    orderColumn: 'created_at',
    orderAscending: false,
    limit: 60,
    enabled,
  });

  // Scout session ids (title='scout') — fetched once + refreshed so new scout
  // sessions are picked up. null until the first fetch resolves (drives loading).
  const [scoutIds, setScoutIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const fetchIds = async () => {
      try {
        const { data } = await getBrowserClient().from('sessions').select('id').eq('title', 'scout');
        if (!cancelled) setScoutIds(new Set((data ?? []).map((r) => (r as { id: string }).id)));
      } catch {
        if (!cancelled) setScoutIds(new Set());
      }
    };
    void fetchIds();
    const t = setInterval(() => void fetchIds(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [enabled]);

  const rows = useMemo(
    () => (scoutIds == null ? [] : all.rows.filter((h) => scoutIds.has(h.sessionId))),
    [all.rows, scoutIds],
  );

  // Not "loaded" until BOTH the realtime snapshot AND the scout-id set are ready,
  // so the panel shows "reading…" rather than a false "no theses yet" flash.
  return { ...all, rows, loaded: enabled ? all.loaded && scoutIds != null : all.loaded };
}
