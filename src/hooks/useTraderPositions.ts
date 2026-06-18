'use client';

/**
 * useTraderPositions — a trader's live open positions, Supabase-WHEN-WATCHED with
 * an on-demand HL FALLBACK.
 *
 * The trade-watch watcher keeps `leader_positions` fresh for the leaders it
 * covers. So:
 *   - If the watcher has rows for this address → read them from Supabase (realtime,
 *     ZERO HL load). source='supabase'.
 *   - If Supabase has loaded with NO rows → the address is either not-watched OR
 *     watched-but-flat; we can't tell, so fall back to the on-demand HL proxy
 *     (useTraderDetail) which returns the truth either way. source='hl'.
 *
 * The HL fetch fires ONLY in the fallback case (Supabase loaded + empty) — a
 * watched leader holding positions never hits HL. A null address is fully inert.
 *
 * Returns the SAME shape useTraderDetail did (positions + accountValueUsd +
 * loading/error/stale) so it drops into the existing drawer, plus a `source` tag.
 */

import { useLeaderPositionsScoped } from './useLeaderPositionsTable';
import { useTraderDetail } from './useTraderDetail';
import { leaderPositionRowsToHlPositions, accountValueFromRows } from './leader-position-adapt';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';

export interface TraderPositionsState {
  positions: HlPosition[];
  accountValueUsd: number | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
  /** Where the data came from — 'supabase' (watched) | 'hl' (fallback) | null. */
  source: 'supabase' | 'hl' | null;
}

export function useTraderPositions(address: string | null): TraderPositionsState {
  // Supabase (realtime, scoped, INERT when address is null).
  const sb = useLeaderPositionsScoped(address);
  const watched = sb.loaded && sb.rows.length > 0;

  // HL fallback fires ONLY when Supabase has loaded with NO rows (not-watched or
  // flat). While Supabase is still loading, hlAddress stays null so HL doesn't
  // fire prematurely; a watched leader never reaches here.
  const hlAddress = address && sb.loaded && sb.rows.length === 0 ? address : null;
  const hl = useTraderDetail(hlAddress);

  if (watched) {
    return {
      positions: leaderPositionRowsToHlPositions(sb.rows),
      accountValueUsd: accountValueFromRows(sb.rows),
      loading: false,
      error: null,
      stale: false,
      source: 'supabase',
    };
  }

  // Address present but Supabase not yet resolved → loading (don't flash the
  // HL-empty state before we know whether the watcher covers this leader).
  if (address && !sb.loaded) {
    return { positions: [], accountValueUsd: null, loading: true, error: null, stale: false, source: null };
  }

  // Fallback (Supabase loaded + empty) → the on-demand HL result; or fully inert
  // when there's no address.
  return { ...hl, source: address ? 'hl' : null };
}
