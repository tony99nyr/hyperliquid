'use client';

/**
 * useFollowing — composes the operator's active follows (useFollows) with the live
 * leader_positions feed (useLeaderPositionsTable) into the cockpit's Following panel
 * rows. Each followed (leader, coin) is matched to its live position when the leader
 * is still in it + watched; otherwise `position` is null (leader closed / unwatched).
 * No new I/O — both feeds are already polled by their own hooks.
 */

import { useMemo } from 'react';
import { useFollows, followKey } from './useFollows';
import { useLeaderPositionsTable } from './useLeaderPositionsTable';
import type { LeaderPositionRow } from './realtime-row-mappers';

export interface FollowingRow {
  leaderAddress: string;
  coin: string;
  /** The leader's live position, or null when it's no longer open/watched. */
  position: LeaderPositionRow | null;
}

export interface UseFollowingState {
  rows: FollowingRow[];
  loading: boolean;
  noFollows: boolean;
  /** Unfollow a (leader, coin) — optimistic, reverts on failure. */
  unfollow: (address: string, coin: string) => Promise<void>;
}

export function useFollowing(): UseFollowingState {
  const f = useFollows();
  const positions = useLeaderPositionsTable();

  const byKey = useMemo(() => {
    const m = new Map<string, LeaderPositionRow>();
    for (const r of positions.rows) m.set(followKey(r.leaderAddress, r.coin), r);
    return m;
  }, [positions.rows]);

  const rows = useMemo<FollowingRow[]>(
    () =>
      [...f.follows].sort().map((key) => {
        const [leaderAddress, coin] = key.split('|');
        return { leaderAddress, coin, position: byKey.get(key) ?? null };
      }),
    [f.follows, byKey],
  );

  return {
    rows,
    loading: f.loading || !positions.loaded,
    noFollows: !f.loading && f.follows.size === 0,
    unfollow: (a, c) => f.toggle(a, c),
  };
}
