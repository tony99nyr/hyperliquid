'use client';

/**
 * useFavoritePlays — the repurposed Opportunities feed: what the operator's
 * FAVORITED traders are doing. Composes the favorites set + the (favorites-only)
 * leader_positions + recent leader_actions, all already polled by their hooks, and
 * derives NEW opens + PROFITABLE holds via the PURE deriveFavoritePlays. No new I/O.
 */

import { useEffect, useMemo, useState } from 'react';
import { useFavorites } from './useFavorites';
import { useLeaderPositionsTable } from './useLeaderPositionsTable';
import { useLeaderActionsFeed } from './useLeaderActionsFeed';
import { deriveFavoritePlays, type FavoritePlay } from '@/lib/cockpit/favorite-plays-business-logic';

export interface UseFavoritePlaysState {
  newPlays: FavoritePlay[];
  profitablePlays: FavoritePlay[];
  /** Current clock (ticked every 30s) for relative "Xm ago" labels — render-pure. */
  nowMs: number;
  /** True until favorites + both leader feeds have loaded their first snapshot. */
  loading: boolean;
  /** True when the operator has no favorites yet (drives the cold-start empty copy). */
  noFavorites: boolean;
}

export function useFavoritePlays(): UseFavoritePlaysState {
  const fav = useFavorites();
  const positions = useLeaderPositionsTable();
  const actions = useLeaderActionsFeed({ limit: 100 });

  // Self-ticking clock (lazy init keeps Date.now() out of render-purity; the tick
  // lives in the interval callback, not the effect body) so the "new" window + the
  // "ago" labels never call Date.now() during render — mirrors OpportunityBoard.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const { newPlays, profitablePlays } = useMemo(
    () =>
      deriveFavoritePlays({
        opens: actions.rows,
        positions: positions.rows,
        favorites: fav.favorites,
        nowMs,
      }),
    [actions.rows, positions.rows, fav.favorites, nowMs],
  );

  return {
    newPlays,
    profitablePlays,
    nowMs,
    loading: fav.loading || !positions.loaded || !actions.loaded,
    noFavorites: !fav.loading && fav.favorites.size === 0,
  };
}
