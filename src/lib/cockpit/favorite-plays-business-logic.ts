/**
 * PURE derivation of "Favorites' Plays" — the repurposed Opportunities board
 * (fixture-tested). Instead of our own rubric signals, it surfaces what the
 * operator's FAVORITED traders are doing:
 *   - NEW   = favorites' recent `leader_actions` kind='open' (timely, least extended)
 *   - PROFITABLE = favorites' `leader_positions` with uPnL > 0 (context, not a signal)
 *
 * Per review A5: NEW is the headline (default); PROFITABLE structurally surfaces the
 * most-EXTENDED entries (you see them after they worked), so each profitable play
 * carries an `extendedPct` (move from entry in the position's favor) for an anti-chase
 * badge — and the board hides ones past `EXTENDED_HIDE_PCT` by default.
 */

import type { LeaderPositionRow, LeaderActionRow } from '@/hooks/realtime-row-mappers';
import { markFromPosition } from './position-health-business-logic';

export interface FavoritePlay {
  id: string;
  leaderAddress: string;
  coin: string;
  side: 'long' | 'short';
  kind: 'new' | 'profitable';
  entryPx: number | null;
  markPx: number | null;
  /** % move from entry to mark IN the position's favor (long: up; short: down). */
  extendedPct: number | null;
  unrealizedPnl: number | null;
  detectedAtMs: number | null;
}

/** "New" = opened within this window. */
export const NEW_PLAY_WINDOW_MS = 6 * 60 * 60 * 1000;
/** Profitable plays more extended than this are hidden by default (anti-chase). */
export const EXTENDED_HIDE_PCT = 8;

export function deriveFavoritePlays(input: {
  opens: LeaderActionRow[];
  positions: LeaderPositionRow[];
  favorites: Set<string>;
  nowMs: number;
  newWindowMs?: number;
}): { newPlays: FavoritePlay[]; profitablePlays: FavoritePlay[] } {
  const isFav = (a: string) => input.favorites.has(a.toLowerCase());
  const win = input.newWindowMs ?? NEW_PLAY_WINDOW_MS;

  const newPlays: FavoritePlay[] = input.opens
    .filter((a) => {
      const age = input.nowMs - a.detectedAt;
      // Lower bound guards clock skew: a future-dated detectedAt (negative age)
      // would otherwise pass `<= win` and render a nonsensical "ago".
      return a.kind === 'open' && isFav(a.leaderAddress) && age >= 0 && age <= win;
    })
    .map((a) => ({
      id: a.id,
      leaderAddress: a.leaderAddress,
      coin: a.coin,
      side: a.newSide ?? 'long',
      kind: 'new' as const,
      entryPx: a.entryPx,
      markPx: null,
      extendedPct: null,
      unrealizedPnl: a.unrealizedPnl,
      detectedAtMs: a.detectedAt,
    }))
    .sort((x, y) => (y.detectedAtMs ?? 0) - (x.detectedAtMs ?? 0));

  const profitablePlays: FavoritePlay[] = input.positions
    .filter((p) => isFav(p.leaderAddress) && p.unrealizedPnl > 0)
    .map((p) => {
      const markPx = markFromPosition(p.positionValue, p.size);
      const extendedPct =
        p.entryPx != null && p.entryPx > 0 && markPx != null
          ? ((markPx - p.entryPx) / p.entryPx) * 100 * (p.side === 'short' ? -1 : 1)
          : null;
      return {
        id: p.id,
        leaderAddress: p.leaderAddress,
        coin: p.coin,
        side: p.side,
        kind: 'profitable' as const,
        entryPx: p.entryPx,
        markPx,
        extendedPct,
        unrealizedPnl: p.unrealizedPnl,
        detectedAtMs: null,
      };
    })
    .sort((x, y) => (y.unrealizedPnl ?? 0) - (x.unrealizedPnl ?? 0));

  return { newPlays, profitablePlays };
}

/** True when a profitable play is too extended to lead with (anti-chase default hide). */
export function isOverExtended(play: FavoritePlay, thresholdPct = EXTENDED_HIDE_PCT): boolean {
  return play.extendedPct != null && play.extendedPct > thresholdPct;
}
