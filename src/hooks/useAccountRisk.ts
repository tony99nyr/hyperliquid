'use client';

/**
 * Polls /api/cockpit/account-risk for the operator's REAL per-coin liquidation +
 * effective leverage (which reflect posted margin), so the positions panel can show
 * the true liq distance instead of the fold's margin-blind formula. Pauses while the
 * tab is hidden (same idiom as useStops). `enabled=false` (test/RSC) skips fetching.
 */

import { useEffect, useState } from 'react';
import type { AccountRisk } from '@/lib/trading/account-risk-service';

export interface UseAccountRiskState {
  riskByCoin: Record<string, AccountRisk>;
  loaded: boolean;
  error: string | null;
}

const POLL_MS = 20_000;

export function useAccountRisk(enabled: boolean): UseAccountRiskState {
  const [riskByCoin, setRiskByCoin] = useState<Record<string, AccountRisk>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const load = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const res = await fetch('/api/cockpit/account-risk', { credentials: 'same-origin' });
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; risk?: Record<string, AccountRisk>; error?: string };
        if (!active) return;
        if (json.ok && json.risk) { setRiskByCoin(json.risk); setError(null); }
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

  return { riskByCoin, loaded, error };
}
