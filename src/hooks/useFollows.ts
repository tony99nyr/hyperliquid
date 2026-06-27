'use client';

/**
 * useFollows — the operator's FOLLOWED leader positions (drives the cockpit's
 * Following panel + the keep-matched alerts). Reads `followed_positions` (active)
 * via the anon client (select-only RLS; off realtime → POLL every 60s) and toggles
 * through the admin-authed `/api/cockpit/follows` route (optimistic, reverts on
 * failure). Keyed `addr|COIN` (lowercased addr, uppercased coin) to match the daemon.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getBrowserClient } from '@/lib/cockpit/supabase-browser';

const REFRESH_MS = 60_000;

/** Canonical follow key: lowercased address + uppercased coin. */
export function followKey(address: string, coin: string): string {
  return `${address.toLowerCase()}|${coin.toUpperCase()}`;
}

export interface UseFollowsState {
  /** Active follows as `addr|COIN` keys. */
  follows: Set<string>;
  loading: boolean;
  isFollowing: (address: string, coin: string) => boolean;
  /** Optimistically follow/unfollow; posts to the authed route, reverts on failure. */
  toggle: (address: string, coin: string) => Promise<void>;
  refetch: () => Promise<void>;
}

export function useFollows(): UseFollowsState {
  const [follows, setFollows] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const inFlight = useRef<Set<string>>(new Set());

  const refetch = useCallback(async () => {
    const { data, error } = await getBrowserClient()
      .from('followed_positions')
      .select('leader_address, coin')
      .eq('status', 'active');
    if (!error) {
      setFollows(new Set((data ?? []).map((r) => {
        const row = r as { leader_address: string; coin: string };
        return followKey(row.leader_address, row.coin);
      })));
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

  const isFollowing = useCallback((a: string, c: string) => follows.has(followKey(a, c)), [follows]);

  const toggle = useCallback(
    async (address: string, coin: string) => {
      const key = followKey(address, coin);
      if (inFlight.current.has(key)) return; // ignore re-entrant toggle
      inFlight.current.add(key);
      const adding = !follows.has(key);
      setFollows((prev) => {
        const s = new Set(prev);
        if (adding) s.add(key); else s.delete(key);
        return s;
      });
      try {
        const res = await fetch('/api/cockpit/follows', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ leaderAddress: address.toLowerCase(), coin: coin.toUpperCase(), action: adding ? 'follow' : 'unfollow' }),
        });
        if (!res.ok) throw new Error(`follows route ${res.status}`);
      } catch (err) {
        setFollows((prev) => {
          const s = new Set(prev);
          if (adding) s.delete(key); else s.add(key);
          return s;
        });
        throw err;
      } finally {
        inFlight.current.delete(key);
      }
    },
    [follows],
  );

  return { follows, loading, isFollowing, toggle, refetch };
}
