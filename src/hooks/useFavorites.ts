'use client';

/**
 * useFavorites — the operator's favorited traders (drives the favorites-gated
 * watch). Reads `favorited_traders` via the anon client (select-only RLS; the
 * table is off realtime so we POLL every 60s) and toggles through the admin-authed
 * `/api/cockpit/favorites` route (optimistic, reverts on failure). Addresses are
 * normalized lowercase to match the daemon's watch-set keying.
 */

import { useCallback, useEffect, useState } from 'react';
import { getBrowserClient } from '@/lib/cockpit/supabase-browser';

const REFRESH_MS = 60_000;

export interface UseFavoritesState {
  /** Lowercased favorited addresses. */
  favorites: Set<string>;
  loading: boolean;
  isFavorite: (address: string) => boolean;
  /** Optimistically add/remove; posts to the authed route, reverts on failure. */
  toggle: (address: string) => Promise<void>;
  refetch: () => Promise<void>;
}

export function useFavorites(): UseFavoritesState {
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    const { data, error } = await getBrowserClient().from('favorited_traders').select('leader_address');
    if (!error) {
      setFavorites(new Set((data ?? []).map((r) => String((r as { leader_address: string }).leader_address).toLowerCase())));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    let active = true;
    const run = () => { if (active) void refetch(); };
    run();
    const id = setInterval(run, REFRESH_MS);
    return () => { active = false; clearInterval(id); };
  }, [refetch]);

  const isFavorite = useCallback((a: string) => favorites.has(a.toLowerCase()), [favorites]);

  const toggle = useCallback(
    async (address: string) => {
      const addr = address.toLowerCase();
      const adding = !favorites.has(addr);
      setFavorites((prev) => {
        const s = new Set(prev);
        if (adding) s.add(addr);
        else s.delete(addr);
        return s;
      });
      try {
        const res = await fetch('/api/cockpit/favorites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ address: addr, action: adding ? 'add' : 'remove' }),
        });
        if (!res.ok) throw new Error(`favorites route ${res.status}`);
      } catch (err) {
        // Revert the optimistic change on failure.
        setFavorites((prev) => {
          const s = new Set(prev);
          if (adding) s.delete(addr);
          else s.add(addr);
          return s;
        });
        throw err;
      }
    },
    [favorites],
  );

  return { favorites, loading, isFavorite, toggle, refetch };
}
