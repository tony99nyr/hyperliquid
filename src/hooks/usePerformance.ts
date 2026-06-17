'use client';

/**
 * usePerformance — the Performance view's derived data (trade ledger + KPI strip
 * + 30-day equity series), polled from the read-only /api/cockpit/performance
 * route. The summary is folded server-side from the durable `fills` ledger; this
 * hook just refreshes it so open-position marks + today's realized PnL stay live.
 *
 * READ-ONLY. A null sessionId is inert (no poll). Fail-soft — a failed poll keeps
 * the last good summary.
 */

import { useEffect, useState } from 'react';
import type { PerformanceSummary } from '@/lib/cockpit/performance-service';

export interface PerformanceState {
  summary: PerformanceSummary | null;
  loading: boolean;
  error: string | null;
}

/** Refresh cadence — KPIs/ledger move on fills + marks; 12s is plenty. */
const DEFAULT_POLL_MS = 12_000;

export function usePerformance(
  sessionId: string | null,
  pollMs: number = DEFAULT_POLL_MS,
): PerformanceState {
  const [state, setState] = useState<PerformanceState>({
    summary: null,
    loading: sessionId !== null,
    error: null,
  });

  // Reset synchronously on session change (no ref read during render).
  const [renderedId, setRenderedId] = useState(sessionId);
  if (renderedId !== sessionId) {
    setRenderedId(sessionId);
    setState({ summary: null, loading: sessionId !== null, error: null });
  }

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll(): Promise<void> {
      try {
        const res = await fetch(
          `/api/cockpit/performance?sessionId=${encodeURIComponent(sessionId as string)}`,
          { headers: { accept: 'application/json' } },
        );
        if (!active) return;
        if (res.ok) {
          const json = (await res.json()) as { ok: boolean; summary?: PerformanceSummary };
          if (json.summary) setState({ summary: json.summary, loading: false, error: null });
        } else {
          setState((s) => ({ ...s, loading: false, error: `performance fetch failed (${res.status})` }));
        }
      } catch {
        if (active) setState((s) => ({ ...s, loading: false, error: 'performance refresh failed' }));
      } finally {
        if (active) timer = setTimeout(() => void poll(), pollMs);
      }
    }

    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, pollMs]);

  return state;
}
