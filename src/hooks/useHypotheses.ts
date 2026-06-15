'use client';

/**
 * Realtime hook for the session's hypotheses (trade theses + their outcomes).
 * Open theses surfaced separately so the board can foreground them.
 */

import { useRealtimeChannel } from './useRealtimeChannel';
import { byCreatedAtDesc, mapHypothesisRow } from './realtime-row-mappers';
import type { Hypothesis } from '@/types/cockpit';

export interface HypothesesState {
  hypotheses: Hypothesis[];
  open: Hypothesis[];
  resolved: Hypothesis[];
  loaded: boolean;
  subscribed: boolean;
  error: string | null;
}

export function useHypotheses(sessionId: string | null): HypothesesState {
  const { rows, loaded, subscribed, error } = useRealtimeChannel<Hypothesis>({
    table: 'hypotheses',
    sessionId,
    map: mapHypothesisRow,
    compare: byCreatedAtDesc,
  });
  return {
    hypotheses: rows,
    open: rows.filter((h) => h.status === 'open'),
    resolved: rows.filter((h) => h.status !== 'open'),
    loaded,
    subscribed,
    error,
  };
}
