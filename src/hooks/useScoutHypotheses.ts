'use client';

/**
 * useScoutHypotheses — the autonomous scout's track record, live, SCOPED to scout
 * sessions (title='scout') so the ScoutPanel never shows manual trades as scout
 * activity. Subscribes to the global `hypotheses` table (realtime), then filters
 * to the scout's own sessions (ids fetched + periodically refreshed). Zero client
 * HL calls. Mirrors useRubricScores (realtime, enabled-gated).
 */

import { useMemo } from 'react';
import { mapHypothesisRow, byCreatedAtDesc } from './realtime-row-mappers';
import { useRealtimeTable, type RealtimeTableState } from './useRealtimeTable';
import { useScoutSessionIds } from './useScoutSessionIds';
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

  // Scout session ids (title='scout', shared hook) — null until the first fetch
  // resolves (drives loading so the feed doesn't flash a false "no theses yet").
  const { set: scoutIds } = useScoutSessionIds(enabled);

  const rows = useMemo(
    () => (scoutIds == null ? [] : all.rows.filter((h) => scoutIds.has(h.sessionId))),
    [all.rows, scoutIds],
  );

  // Not "loaded" until BOTH the realtime snapshot AND the scout-id set are ready,
  // so the panel shows "reading…" rather than a false "no theses yet" flash.
  return { ...all, rows, loaded: enabled ? all.loaded && scoutIds != null : all.loaded };
}
