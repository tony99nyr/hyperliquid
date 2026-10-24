'use client';

import { useCallback, useEffect, useState } from 'react';
import type { LanePerformanceReport } from '@/lib/performance/lane-performance-business-logic';
import { isPageActive, onActivityResume } from './page-activity';

export interface LanePerformanceState {
  data: LanePerformanceReport | null;
  lastGood: LanePerformanceReport | null;
  error: string | null;
  isStale: boolean;
  status: number | null;
  retry: () => void;
  confirmMarker: (id: string) => void;
}

export function useLanePerformance(pollMs = 60_000, enabled = true): LanePerformanceState {
  const [data, setData] = useState<LanePerformanceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [optimistic, setOptimistic] = useState<Record<string, string>>({});
  const retry = useCallback(() => setRetryCount((count) => count + 1), []);
  const confirmMarker = useCallback((id: string) => setOptimistic((current) => ({ ...current, [id]: new Date().toISOString() })), []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll(force = false): Promise<void> {
      if (inFlight) return;
      if (!force && !isPageActive()) {
        timer = setTimeout(() => void poll(), pollMs);
        return;
      }
      inFlight = true;
      try {
        const response = await fetch('/api/cockpit/lane-performance', { headers: { accept: 'application/json' } });
        if (!active) return;
        if (!response.ok) {
          let detail: string | null = null;
          try {
            const body = await response.json() as { error?: unknown };
            if (typeof body.error === 'string') detail = body.error;
          } catch { /* A failed request can have an empty or non-JSON body. */ }
          if (!active) return;
          setStatus(response.status);
          setError(response.status === 401 ? 'Sign in again' : detail ?? `Lane performance request failed (${response.status})`);
          setIsStale(true);
          return;
        }
        const report = await response.json() as LanePerformanceReport;
        if (!active) return;
        if (report.schemaVersion !== 1) {
          setStatus(422);
          setError('The server and view use different report schemas. Redeploy or restart it.');
          setIsStale(true);
          return;
        }
        setData(report);
        setOptimistic((current) => {
          const remaining = Object.fromEntries(Object.entries(current).filter(([id]) => !report.markers.some((marker) => marker.id === id && marker.confirmed_at)));
          return Object.keys(remaining).length === Object.keys(current).length ? current : remaining;
        });
        setError(null);
        setStatus(null);
        setIsStale(false);
      } catch (cause) {
        if (active) {
          setStatus(0);
          setError(cause instanceof Error ? cause.message : 'Lane performance refresh failed');
          setIsStale(true);
        }
      } finally {
        inFlight = false;
        if (active) timer = setTimeout(() => void poll(), pollMs);
      }
    }
    void poll(retryCount > 0);
    const stopResume = onActivityResume(() => void poll(true));
    return () => { active = false; if (timer) clearTimeout(timer); stopResume(); };
  }, [pollMs, retryCount, enabled]);

  const visible = data && Object.keys(optimistic).length ? {
    ...data,
    markers: data.markers.map((marker) => optimistic[marker.id] && !marker.confirmed_at ? { ...marker, confirmed_at: optimistic[marker.id]! } : marker),
  } : data;
  return { data: visible, lastGood: visible, error, isStale, status, retry, confirmMarker };
}
