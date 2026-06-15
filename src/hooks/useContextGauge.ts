'use client';

/**
 * Realtime hook for Claude's context-budget gauge. Surfaces the latest sample
 * (the only one the UI shows) plus the recent history for a sparkline if needed.
 */

import { useRealtimeChannel } from './useRealtimeChannel';
import { byCreatedAtDesc, mapContextGaugeRow } from './realtime-row-mappers';
import type { ContextGauge } from '@/types/cockpit';

export interface ContextGaugeState {
  samples: ContextGauge[];
  /** Most-recent gauge sample, or null before any arrive. */
  latest: ContextGauge | null;
  loaded: boolean;
  subscribed: boolean;
  error: string | null;
}

export function useContextGauge(sessionId: string | null): ContextGaugeState {
  const { rows, loaded, subscribed, error } = useRealtimeChannel<ContextGauge>({
    table: 'context_gauge',
    sessionId,
    map: mapContextGaugeRow,
    compare: byCreatedAtDesc,
    limit: 50,
  });
  return { samples: rows, latest: rows[0] ?? null, loaded, subscribed, error };
}
