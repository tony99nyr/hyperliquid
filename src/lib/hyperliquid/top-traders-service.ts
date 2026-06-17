/**
 * Slim top-traders selector for the cockpit's left rail. Reads the vendored
 * rated-wallets dataset (server-only fs read) and returns a small ranked list —
 * the heavy 2.8MB dataset must never reach the client, so the RSC page calls this
 * and passes only the slim rows down.
 *
 * Ranking: composite score desc (nulls last), tie-broken by leaderboardTop. Risk
 * flags are surfaced so the rail can color blow-up-risk wallets red.
 */

import { loadRatedWallets, RISK_FLAGS, type RatedWallet } from './rated-wallets-service';

export interface TopTraderRow {
  address: string;
  short: string;
  displayName: string | null;
  composite: number | null;
  /** True when any flag is a risk flag the rail should color red. */
  hasRisk: boolean;
  /** Up to 3 flags for the chip row (risk flags first). */
  flags: string[];
  leaderboardTop: boolean;
  topCoins: string[];
}

function rank(a: RatedWallet, b: RatedWallet): number {
  const ca = a.composite ?? -Infinity;
  const cb = b.composite ?? -Infinity;
  if (cb !== ca) return cb - ca;
  return Number(b.leaderboardTop ?? false) - Number(a.leaderboardTop ?? false);
}

/** Top `limit` rated wallets as slim rows (default 12). */
export function getTopTraders(limit = 12): TopTraderRow[] {
  const { wallets } = loadRatedWallets();
  return [...wallets]
    .sort(rank)
    .slice(0, limit)
    .map((w) => {
      const riskFlags = w.flags.filter((f) => RISK_FLAGS.has(f));
      const cleanFlags = w.flags.filter((f) => !RISK_FLAGS.has(f));
      return {
        address: w.address,
        short: w.short,
        displayName: w.displayName,
        composite: w.composite,
        hasRisk: riskFlags.length > 0,
        flags: [...riskFlags, ...cleanFlags].slice(0, 3),
        leaderboardTop: w.leaderboardTop ?? false,
        topCoins: (w.topCoins ?? []).slice(0, 3),
      };
    });
}
