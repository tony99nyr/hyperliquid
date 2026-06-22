'use client';

/**
 * useScoutHeartbeat — liveness of the scout daemons. Subscribes to scout_heartbeat
 * (realtime) so the cockpit can show "scout last tick Nm ago" and flag a hung/dead
 * daemon (crash, OAuth expiry) instead of a silently-stale panel.
 */

import { useRealtimeTable, type RealtimeTableState } from './useRealtimeTable';
import type { RealtimeRow } from './realtime-row-mappers';

export interface ScoutHeartbeat {
  id: string;
  source: string;
  lastTickMs: number;
  status: string;
  detail: string;
}

function mapHeartbeatRow(row: RealtimeRow): ScoutHeartbeat {
  const source = typeof row.source === 'string' ? row.source : 'scout';
  const t = row.last_tick_at;
  const lastTickMs = typeof t === 'string' ? new Date(t).getTime() : typeof t === 'number' ? t : 0;
  return {
    id: source,
    source,
    lastTickMs: Number.isFinite(lastTickMs) ? lastTickMs : 0,
    status: typeof row.status === 'string' ? row.status : '',
    detail: typeof row.detail === 'string' ? row.detail : '',
  };
}

const byLastTickDesc = (a: ScoutHeartbeat, b: ScoutHeartbeat): number => b.lastTickMs - a.lastTickMs;

export function useScoutHeartbeat(opts: { enabled?: boolean } = {}): RealtimeTableState<ScoutHeartbeat> {
  return useRealtimeTable<ScoutHeartbeat>({
    table: 'scout_heartbeat',
    map: mapHeartbeatRow,
    compare: byLastTickDesc,
    filter: null,
    orderColumn: 'last_tick_at',
    orderAscending: false,
    limit: 5,
    enabled: opts.enabled ?? true,
  });
}
