'use client';

/**
 * Realtime hook for the session's health_snapshots. Newest first; the latest is
 * surfaced separately for the HealthPanel gauge.
 */

import { useRealtimeChannel } from './useRealtimeChannel';
import { byCreatedAtDesc, mapHealthSnapshotRow } from './realtime-row-mappers';
import type { HealthSnapshot } from '@/types/cockpit';

export interface HealthSnapshotsState {
  snapshots: HealthSnapshot[];
  /** Most-recent snapshot, or null before any arrive. */
  latest: HealthSnapshot | null;
  loaded: boolean;
  subscribed: boolean;
  error: string | null;
}

export function useHealthSnapshots(sessionId: string | null): HealthSnapshotsState {
  const { rows, loaded, subscribed, error } = useRealtimeChannel<HealthSnapshot>({
    table: 'health_snapshots',
    sessionId,
    map: mapHealthSnapshotRow,
    compare: byCreatedAtDesc,
  });
  return { snapshots: rows, latest: rows[0] ?? null, loaded, subscribed, error };
}
