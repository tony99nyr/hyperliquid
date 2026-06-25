/**
 * PURE watch-set resolution for the trade-watch daemon (fixture-testable, no I/O).
 *
 * The copy-trading pivot gates the live watch from "top-50 every cycle" down to the
 * operator's FAVORITED traders plus the leaders of any ACTIVELY-FOLLOWED position —
 * the ~84% HL-call cut. The daemon reads `favorited_traders` + active
 * `followed_positions` from Supabase each cycle and feeds the rows here to get the
 * normalized address set to watch. Selection is the only thing that changes; the
 * per-leader fetch/diff/persist pipeline is unchanged.
 */

export interface WatchSetInput {
  /** Favorited leader addresses (any case). */
  favorites: string[];
  /** Leaders of active follows (any case) — followed even if not separately favorited. */
  followLeaders: string[];
}

/** Normalize an address for the watch set + leader_positions keying (trim + lowercase). */
export function normalizeLeaderAddress(addr: string): string {
  return addr.trim().toLowerCase();
}

/**
 * Resolve the watch set = favorites ∪ follow-leaders, normalized, deduped, sorted
 * (stable order for deterministic tests + cycle logs). Empties/whitespace dropped.
 * An empty result means "watch nothing" — the caller logs it; seeding (done in the
 * I/O layer) is what prevents a cold-start empty.
 */
export function resolveWatchSet(input: WatchSetInput): string[] {
  const set = new Set<string>();
  for (const raw of [...input.favorites, ...input.followLeaders]) {
    if (typeof raw !== 'string') continue;
    const norm = normalizeLeaderAddress(raw);
    if (norm) set.add(norm);
  }
  return [...set].sort();
}
