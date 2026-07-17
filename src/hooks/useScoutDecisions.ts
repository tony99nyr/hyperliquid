'use client';

/**
 * useScoutDecisions — the scout's per-cycle TRIAL LEDGER (scout_decisions), the
 * "what is it considering right now" feed: every headless cycle's decision —
 * stand-downs with reasoning, opens/closes (executed flag), steward proposals,
 * parse errors. Polls (60s) rather than realtime: scout tables were trimmed from
 * the realtime publication (0024) and a 30-min cadence doesn't need a socket.
 * Read-only (anon RLS select).
 */

import { useEffect, useState } from 'react';
import { getBrowserClient } from '@/lib/cockpit/supabase-browser';

export interface ScoutDecisionRow {
  id: string;
  createdAtMs: number;
  kind: 'open' | 'close' | 'propose' | 'stand-down' | 'error';
  coin: string | null;
  lane: string | null;
  reasoning: string;
  executed: boolean;
}

export interface ScoutDecisionsState {
  rows: ScoutDecisionRow[];
  loaded: boolean;
}

export function useScoutDecisions(opts: { enabled?: boolean; limit?: number } = {}): ScoutDecisionsState {
  const enabled = opts.enabled ?? true;
  const limit = opts.limit ?? 8;
  const [state, setState] = useState<ScoutDecisionsState>({ rows: [], loaded: false });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const fetchRows = async (): Promise<void> => {
      try {
        const { data } = await getBrowserClient()
          .from('scout_decisions')
          .select('id, created_at, kind, coin, lane, reasoning, executed')
          .order('created_at', { ascending: false })
          .limit(limit);
        if (cancelled) return;
        const rows: ScoutDecisionRow[] = (data ?? []).map((r) => {
          const row = r as { id: string; created_at: string; kind: ScoutDecisionRow['kind']; coin: string | null; lane: string | null; reasoning: string; executed: boolean };
          return {
            id: row.id,
            createdAtMs: Date.parse(row.created_at),
            kind: row.kind,
            coin: row.coin,
            lane: row.lane,
            reasoning: row.reasoning ?? '',
            executed: row.executed === true,
          };
        });
        setState({ rows, loaded: true });
      } catch {
        if (!cancelled) setState((s) => ({ ...s, loaded: true }));
      }
    };
    void fetchRows();
    const t = setInterval(() => void fetchRows(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [enabled, limit]);

  return state;
}
