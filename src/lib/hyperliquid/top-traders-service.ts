/**
 * Slim top-traders selector for the cockpit's left rail. Reads the vendored
 * rated-wallets dataset (server-only fs read) and returns a small ranked list —
 * the heavy 2.8MB dataset must never reach the client, so the RSC page calls this
 * and passes only the slim rows down.
 *
 * Ranking: composite score desc (nulls last), tie-broken by leaderboardTop. Risk
 * flags are surfaced so the rail can color blow-up-risk wallets red.
 */

import {
  loadRatedWallets,
  RISK_FLAGS,
  type RatedWallet,
  type RatedWalletMetrics,
} from './rated-wallets-service';

/** The metrics the trader-detail drawer renders as numbers (a slim subset). */
export interface TopTraderMetrics {
  sharpe: number | null;
  winRate: number | null;
  profitFactor: number | null;
  maxDrawdownFrac: number | null;
  aggregatePnlUsd: number | null;
  medianHoldHours: number | null;
  nFills: number | null;
  worstLossVsMedianWin: number | null;
}

export interface TopTraderRow {
  address: string;
  short: string;
  displayName: string | null;
  composite: number | null;
  /** True when any flag is a risk flag the rail should color red. */
  hasRisk: boolean;
  /** Up to 3 flags for the chip row (risk flags first). */
  flags: string[];
  /** ALL flags (risk first), for the trader-detail risk/health read. */
  allFlags: string[];
  leaderboardTop: boolean;
  topCoins: string[];
  /** Slim metrics for the trader-detail drawer (numbers-first). */
  metrics: TopTraderMetrics;
}

function n(v: number | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Project the full rated metrics down to the slim drawer subset. PURE. */
export function slimMetrics(m: RatedWalletMetrics): TopTraderMetrics {
  return {
    sharpe: n(m.sharpe),
    winRate: n(m.winRate),
    profitFactor: n(m.profitFactor),
    maxDrawdownFrac: n(m.maxDrawdownFrac),
    aggregatePnlUsd: n(m.aggregatePnlUsd),
    medianHoldHours: n(m.medianHoldHours),
    nFills: n(m.nFills),
    worstLossVsMedianWin: n(m.worstLossVsMedianWin),
  };
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
      const allFlags = [...riskFlags, ...cleanFlags];
      return {
        address: w.address,
        short: w.short,
        displayName: w.displayName,
        composite: w.composite,
        hasRisk: riskFlags.length > 0,
        flags: allFlags.slice(0, 3),
        allFlags,
        leaderboardTop: w.leaderboardTop ?? false,
        topCoins: (w.topCoins ?? []).slice(0, 3),
        metrics: slimMetrics(w.metrics),
      };
    });
}
