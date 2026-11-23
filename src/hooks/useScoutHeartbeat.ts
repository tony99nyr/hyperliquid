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
  // source is the not-null primary key (migration 0010): every row and every
  // key-only DELETE `old` carries it, so the hook needs no default.
  const source = String(row.source);
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
    // Room for every source (scout x2, prod crons x2, reconcile-ok) plus headroom: the
    // Scout tab finds its rows by source, and a full window would drop the slowest one.
    limit: 10,
    enabled: opts.enabled ?? true,
  });
}
