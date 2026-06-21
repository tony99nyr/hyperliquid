'use client';

/**
 * useRubricScores — subscribes to the GLOBAL `rubric_scores` table (the
 * deterministic opportunity reads, one row per coin×side). Un-session-scoped, so
 * it works on the cold-start/flat cockpit too. id = `${coin}:${side}` → realtime
 * updates REPLACE, so we always hold the newest read per coin/side. READ-ONLY.
 *
 * Powers the Opportunity board + chart overlays. Reads ONLY Supabase — zero
 * client HL calls (the NAS rubric scan does all the HL work).
 */

import { mapRubricScoreRow, byCoinSideAsc, type RubricScoreUiRow } from './realtime-row-mappers';
import { useRealtimeTable, type RealtimeTableState } from './useRealtimeTable';

export function useRubricScores(opts: { enabled?: boolean } = {}): RealtimeTableState<RubricScoreUiRow> {
  return useRealtimeTable<RubricScoreUiRow>({
    table: 'rubric_scores',
    map: mapRubricScoreRow,
    compare: byCoinSideAsc,
    filter: null, // whole table — only ~2 rows per scanned coin
    orderColumn: 'computed_at',
    orderAscending: false,
    limit: 40,
    enabled: opts.enabled ?? true,
  });
}
