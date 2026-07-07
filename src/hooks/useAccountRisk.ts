'use client';

/**
 * Polls /api/cockpit/account-risk for the operator's REAL per-coin liquidation +
 * effective leverage (which reflect posted margin), so the positions panel shows the
 * true liq distance instead of the fold's margin-blind formula. Thin wrapper over
 * usePolledEndpoint.
 */

import { usePolledEndpoint } from './usePolledEndpoint';
import type { AccountRisk } from '@/lib/trading/account-risk-service';

export interface UseAccountRiskState {
  riskByCoin: Record<string, AccountRisk>;
  loaded: boolean;
  error: string | null;
}

const pickRisk = (j: { ok?: boolean } & Record<string, unknown>) => j.risk as Record<string, AccountRisk> | undefined;

export function useAccountRisk(enabled: boolean): UseAccountRiskState {
  const { data, loaded, error } = usePolledEndpoint('/api/cockpit/account-risk', enabled, pickRisk, 60_000); // was 20s — liq/margin at 2x moves slowly; HL round-trip per poll (CPU trim)
  return { riskByCoin: data ?? {}, loaded, error };
}
