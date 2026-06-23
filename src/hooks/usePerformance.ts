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
const DEFAULT_POLL_MS = 30_000; // 30s (was 12s): equity/ledger don't need 12s freshness — fewer function calls

export function usePerformance(
  sessionId: string | null,
  pollMs: number = DEFAULT_POLL_MS,
): PerformanceState {
  const [state, setState] = useState<PerformanceState>({
    summary: null,
    loading: true,
    error: null,
  });

  // Reset synchronously on session change (no ref read during render).
  const [renderedId, setRenderedId] = useState(sessionId);
  if (renderedId !== sessionId) {
    setRenderedId(sessionId);
    setState({ summary: null, loading: true, error: null });
  }

  useEffect(() => {
    // Polls EVEN with no session: the route then returns the live ACCOUNT equity
    // (not session-scoped) so the top bar shows the real balance on a clean slate.
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll(): Promise<void> {
      // Pause while hidden — don't keep folding the account ledger for a backgrounded
      // tab (Vercel CPU + egress). Resumes on visibilitychange.
      if (typeof document !== 'undefined' && document.hidden) {
        timer = setTimeout(() => void poll(), pollMs);
        return;
      }
      try {
        const res = await fetch(
          sessionId ? `/api/cockpit/performance?sessionId=${encodeURIComponent(sessionId)}` : '/api/cockpit/performance',
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
    const onVis = () => { if (!document.hidden) void poll(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
    };
  }, [sessionId, pollMs]);

  return state;
}
