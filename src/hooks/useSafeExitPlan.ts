'use client';

/**
 * Realtime hook for a session's `safe_exit_plan` (one row per session). Surfaces
 * the current plan + a derived freshness flag so the Safe-Exit button can show
 * "plan updated Ns ago" vs "Claude offline — will market-close full position".
 *
 * The `safe_exit_plan` table has no `created_at` column, so the generic channel
 * is told to order/initial-fetch on `updated_at`. There is at most one row per
 * session, so `plan` is simply the newest.
 */

import { useEffect, useState } from 'react';
import { useRealtimeChannel } from './useRealtimeChannel';
import { byUpdatedAtDesc, mapSafeExitPlanRow } from './realtime-row-mappers';
import { isPlanFresh, DEFAULT_SAFE_EXIT_STALENESS_MS } from '@/lib/trading/safe-exit-business-logic';
import type { SafeExitPlan } from '@/types/cockpit';

export interface SafeExitPlanState {
  plan: SafeExitPlan | null;
  /** True when the plan is fresh enough to trust (Claude is keeping it armed). */
  fresh: boolean;
  /** Age of the plan in ms (null when no plan). Recomputed ~each second. */
  ageMs: number | null;
  loaded: boolean;
  subscribed: boolean;
  error: string | null;
}

export function useSafeExitPlan(
  sessionId: string | null,
  stalenessMs = DEFAULT_SAFE_EXIT_STALENESS_MS,
): SafeExitPlanState {
  const { rows, loaded, subscribed, error } = useRealtimeChannel<SafeExitPlan>({
    table: 'safe_exit_plan',
    sessionId,
    map: mapSafeExitPlanRow,
    compare: byUpdatedAtDesc,
    orderColumn: 'updated_at',
  });
  const plan = rows[0] ?? null;

  // Tick a clock so freshness/age re-render as the plan ages without a new row.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const fresh = plan ? isPlanFresh(plan.updatedAt, now, stalenessMs) : false;
  const ageMs = plan ? Math.max(0, now - plan.updatedAt) : null;
  return { plan, fresh, ageMs, loaded, subscribed, error };
}
