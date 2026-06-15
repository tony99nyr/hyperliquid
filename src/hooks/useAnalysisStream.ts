'use client';

/**
 * Realtime hook for Claude's analysis_log feed (newest first). Thin wrapper over
 * useRealtimeChannel with the analysis-log mapper.
 */

import { useRealtimeChannel } from './useRealtimeChannel';
import { byCreatedAtDesc, mapAnalysisLogRow } from './realtime-row-mappers';
import type { AnalysisLogEntry } from '@/types/cockpit';

export interface AnalysisStreamState {
  entries: AnalysisLogEntry[];
  loaded: boolean;
  subscribed: boolean;
  error: string | null;
}

export function useAnalysisStream(sessionId: string | null): AnalysisStreamState {
  const { rows, loaded, subscribed, error } = useRealtimeChannel<AnalysisLogEntry>({
    table: 'analysis_log',
    sessionId,
    map: mapAnalysisLogRow,
    compare: byCreatedAtDesc,
  });
  return { entries: rows, loaded, subscribed, error };
}
