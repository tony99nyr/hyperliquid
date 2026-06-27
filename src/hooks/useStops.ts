'use client';

/**
 * Polls /api/cockpit/stops for the account's resting protective stops, keyed by
 * coin, so the positions panel can show each row's protection (✓ stop / ⚠ no stop).
 * Stops rest on HL (not in Supabase realtime), so we POLL — pausing while the tab is
 * hidden (same idiom as useCandles). `enabled=false` (test/RSC seed) skips fetching.
 */

import { useEffect, useState } from 'react';
import type { RestingStop } from '@/lib/trading/stop-order-service';

export interface UseStopsState {
  stopsByCoin: Record<string, RestingStop>;
  /** True once the first fetch resolves — until then, rows must NOT claim "no stop". */
  loaded: boolean;
  error: string | null;
}

const POLL_MS = 25_000;

export function useStops(enabled: boolean): UseStopsState {
  const [stopsByCoin, setStopsByCoin] = useState<Record<string, RestingStop>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const load = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const res = await fetch('/api/cockpit/stops', { credentials: 'same-origin' });
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; stops?: Record<string, RestingStop>; error?: string };
        if (!active) return;
        if (json.ok && json.stops) { setStopsByCoin(json.stops); setError(null); }
        else setError(json.error ?? `failed (${res.status})`);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (active) setLoaded(true);
      }
    };
    void load();
    const timer = setInterval(load, POLL_MS);
    const onVis = () => { if (!document.hidden) void load(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
    return () => {
      active = false;
      clearInterval(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
    };
  }, [enabled]);

  return { stopsByCoin, loaded, error };
}
