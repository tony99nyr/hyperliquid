'use client';

/**
 * Polls /api/cockpit/stops for the account's resting protective stops, keyed by coin,
 * so the positions panel can show each row's protection (✓ stop / ⚠ no stop). Thin
 * wrapper over usePolledEndpoint (poll mechanics + last-good-on-error live there).
 */

import { usePolledEndpoint } from './usePolledEndpoint';
import type { RestingStop } from '@/lib/trading/stop-order-service';

export interface UseStopsState {
  stopsByCoin: Record<string, RestingStop>;
  /** True once the first fetch resolves — until then, rows must NOT claim "no stop". */
  loaded: boolean;
  error: string | null;
}

const pickStops = (j: { ok?: boolean } & Record<string, unknown>) => j.stops as Record<string, RestingStop> | undefined;

export function useStops(enabled: boolean): UseStopsState {
  const { data, loaded, error } = usePolledEndpoint('/api/cockpit/stops', enabled, pickStops, 25_000);
  return { stopsByCoin: data ?? {}, loaded, error };
}
