'use client';

/**
 * useScoutPerformance — the autonomous scout's track record (net paper P&L, KPIs,
 * 30-day cumulative-P&L curve), polled from the read-only /api/cockpit/scout-
 * performance route. Slow cadence (a paper track record doesn't move fast) +
 * pause-on-hidden (don't fold the ledger for a backgrounded tab). Fail-soft: a
 * failed poll keeps the last good summary. `enabled:false` is inert (test/RSC).
 */

import { useEffect, useState } from 'react';
import { isPageActive, onActivityResume } from './page-activity';
import type { PerformanceSummary } from '@/lib/cockpit/performance-service';
import type { LaneCard } from '@/types/scout';

const POLL_MS = 60_000;

export interface ScoutLanes {
  account: LaneCard | null;
  lanes: LaneCard[];
  updatedAt: string | null;
}

export interface ScoutPerformanceState {
  summary: PerformanceSummary | null;
  /** Per-lane scorecard breakdown (directional + vault/carry benchmarks). */
  lanes: ScoutLanes | null;
  loading: boolean;
  error: string | null;
}

export function useScoutPerformance(opts: { enabled?: boolean } = {}): ScoutPerformanceState {
  const enabled = opts.enabled ?? true;
  const [state, setState] = useState<ScoutPerformanceState>({ summary: null, lanes: null, loading: enabled, error: null });

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll(): Promise<void> {
      if (!isPageActive()) {
        timer = setTimeout(() => void poll(), POLL_MS);
        return;
      }
      try {
        const res = await fetch('/api/cockpit/scout-performance', { headers: { accept: 'application/json' } });
        if (!active) return;
        if (res.ok) {
          const json = (await res.json()) as { ok: boolean; summary?: PerformanceSummary; lanes?: ScoutLanes };
          if (json.summary) setState({ summary: json.summary, lanes: json.lanes ?? null, loading: false, error: null });
        } else {
          setState((s) => ({ ...s, loading: false, error: `scout perf fetch failed (${res.status})` }));
        }
      } catch {
        if (active) setState((s) => ({ ...s, loading: false, error: 'scout perf refresh failed' }));
      } finally {
        if (active) timer = setTimeout(() => void poll(), POLL_MS);
      }
    }

    void poll();
    const stopResume = onActivityResume(() => void poll());
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      stopResume();
    };
  }, [enabled]);

  return state;
}
