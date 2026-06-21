'use client';

/**
 * useScoutHypotheses — the autonomous scout's track record, live. Subscribes to
 * the global `hypotheses` table (the scout writes a thesis per paper trade and
 * resolves it on close), so the ScoutPanel can show what the scout decided + how
 * it worked out with no client HL calls. Mirrors useRubricScores (global table,
 * realtime, enabled-gated).
 */

import { mapHypothesisRow, byCreatedAtDesc } from './realtime-row-mappers';
import { useRealtimeTable, type RealtimeTableState } from './useRealtimeTable';
import type { Hypothesis } from '@/types/cockpit';

export function useScoutHypotheses(opts: { enabled?: boolean } = {}): RealtimeTableState<Hypothesis> {
  return useRealtimeTable<Hypothesis>({
    table: 'hypotheses',
    map: mapHypothesisRow,
    compare: byCreatedAtDesc,
    filter: null,
    orderColumn: 'created_at',
    orderAscending: false,
    limit: 30,
    enabled: opts.enabled ?? true,
  });
}
