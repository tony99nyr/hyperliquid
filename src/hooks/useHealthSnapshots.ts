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
  /** Most-recent snapshot across all coins, or null before any arrive. */
  latest: HealthSnapshot | null;
  /**
   * Most-recent snapshot PER COIN (upper-cased key). The panel reads THIS so each
   * open position shows its OWN health instead of whichever coin's assessment was
   * written last (the multi-position thrash). Legacy null-coin rows are excluded
   * (they can't be attributed to a coin).
   */
  latestByCoin: Record<string, HealthSnapshot>;
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
  // rows are newest-first → the first seen per coin is its latest.
  const latestByCoin: Record<string, HealthSnapshot> = {};
  for (const s of rows) {
    if (!s.coin) continue;
    const key = s.coin.toUpperCase();
    if (!latestByCoin[key]) latestByCoin[key] = s;
  }
  return { snapshots: rows, latest: rows[0] ?? null, latestByCoin, loaded, subscribed, error };
}
