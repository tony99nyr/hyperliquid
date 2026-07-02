/**
 * Leader guard — PURE detection of "the copied leader left the trade" (fixture-tested).
 *
 * A copy-thesis ladder (ladders.leader_address set) should not stay armed once the wallet
 * it copies has exited or flipped the coin — that is the playbook's #1 dead-zone rule
 * ("thesis-break ≠ stop-hit: if the REASON you entered is gone, disarm"). This module only
 * DECIDES; the service disarms. **Disarm-only authority — it can never fire or trade.**
 *
 * Signals, strongest first (deterministic, ambiguity → NO action):
 *  1. A leader_actions row of kind 'close'/'flip' for (leader, coin) AFTER the ladder was
 *     armed — unambiguous: the feed recorded the exit event itself.
 *  2. A live leader_positions row for (leader, coin) on the OPPOSITE side — flipped.
 *  3. NO row for (leader, coin) while the leader HAS other fresh rows — the feed mirrors
 *     the live book (closed coins are deleted), so absence-with-coverage = exited.
 *  4. No rows for the leader at all → AMBIGUOUS (unwatched wallet vs flat-everywhere) →
 *     no action. A guard that disarms on missing data would kill valid authorizations.
 */

import type { LadderSide } from './ladder-types';

export interface LeaderPositionRow {
  coin: string;
  side: LadderSide;
  updatedAtMs: number;
}

export interface LeaderActionRow {
  coin: string;
  kind: 'open' | 'add' | 'reduce' | 'close' | 'flip';
  atMs: number;
}

export interface LeaderGuardInput {
  /** The coin + side the ladder copies. */
  coin: string;
  side: LadderSide;
  /** Epoch ms the ladder was armed — only exits AFTER this count. */
  armedAtMs: number;
  /** The leader's CURRENT rows (live-book mirror; empty = flat-or-unwatched). */
  positions: LeaderPositionRow[];
  /** The leader's recent action events (any coin). */
  actions: LeaderActionRow[];
  /** Rows older than this are ignored for the absence signal (stale coverage). */
  maxFeedAgeMs: number;
  now: number;
}

export interface LeaderGuardVerdict {
  shouldDisarm: boolean;
  reason: string | null;
}

export function leaderGuardVerdict(input: LeaderGuardInput): LeaderGuardVerdict {
  const coin = input.coin.toUpperCase();

  // 1) An explicit close/flip event on this coin after arming — the strongest signal.
  const exitEvent = input.actions.find(
    (a) => a.coin.toUpperCase() === coin && (a.kind === 'close' || a.kind === 'flip') && a.atMs >= input.armedAtMs && a.atMs <= input.now,
  );
  if (exitEvent) {
    return { shouldDisarm: true, reason: `leader-${exitEvent.kind}: the copied wallet ${exitEvent.kind === 'flip' ? 'flipped' : 'closed'} ${coin} after arming` };
  }

  // 2) A live position on the OPPOSITE side — flipped (even without a recorded event).
  const row = input.positions.find((p) => p.coin.toUpperCase() === coin);
  if (row && row.side !== input.side) {
    return { shouldDisarm: true, reason: `leader-flip: the copied wallet now holds ${coin} ${row.side} (ladder is ${input.side})` };
  }
  if (row) return { shouldDisarm: false, reason: null }; // still in, same side.

  // 3) Absent from the coin while the feed demonstrably covers the leader → exited.
  const freshest = input.positions.reduce((a, p) => Math.max(a, p.updatedAtMs), 0);
  if (input.positions.length > 0 && input.now - freshest <= input.maxFeedAgeMs) {
    return { shouldDisarm: true, reason: `leader-exit: the copied wallet no longer holds ${coin} (live-book mirror, feed fresh)` };
  }

  // 4) No coverage (unwatched, or flat everywhere — indistinguishable) → never disarm blind.
  return { shouldDisarm: false, reason: null };
}
