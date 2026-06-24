'use client';

/**
 * useScoutPerformance — the autonomous scout's track record (net paper P&L, KPIs,
 * 30-day cumulative-P&L curve), polled from the read-only /api/cockpit/scout-
 * performance route. Slow cadence (a paper track record doesn't move fast) +
 * pause-on-hidden (don't fold the ledger for a backgrounded tab). Fail-soft: a
 * failed poll keeps the last good summary. `enabled:false` is inert (test/RSC).
 */

import { useEffect, useState } from 'react';
import type { PerformanceSummary } from '@/lib/cockpit/performance-service';

const POLL_MS = 60_000;

export interface ScoutPerformanceState {
  summary: PerformanceSummary | null;
  loading: boolean;
  error: string | null;
}

export function useScoutPerformance(opts: { enabled?: boolean } = {}): ScoutPerformanceState {
  const enabled = opts.enabled ?? true;
  const [state, setState] = useState<ScoutPerformanceState>({ summary: null, loading: enabled, error: null });

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll(): Promise<void> {
      if (typeof document !== 'undefined' && document.hidden) {
        timer = setTimeout(() => void poll(), POLL_MS);
        return;
      }
      try {
        const res = await fetch('/api/cockpit/scout-performance', { headers: { accept: 'application/json' } });
        if (!active) return;
        if (res.ok) {
          const json = (await res.json()) as { ok: boolean; summary?: PerformanceSummary };
          if (json.summary) setState({ summary: json.summary, loading: false, error: null });
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
    const onVis = () => { if (!document.hidden) void poll(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
    };
  }, [enabled]);

  return state;
}
