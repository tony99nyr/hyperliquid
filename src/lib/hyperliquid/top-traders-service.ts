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
// TRADEABLE_COINS + normalizeCoin live in the zero-import filter helper so a
// CLIENT component (the rail) can import them without dragging this server-only
// fs module into the browser bundle. The server computes tradesTradeableCoin
// here against the FULL topCoins list (the chip subset is sliced to 3).
import { TRADEABLE_COINS, normalizeCoin } from '@/app/cockpit/components/left-rail/top-traders-filter-helpers';

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
  /** True when the wallet carries the CLEAN_BOOK positive signal. */
  cleanBook: boolean;
  /**
   * True when ANY of the wallet's traded coins intersects our tradeable set
   * (ETH/BTC/HYPE). Computed server-side from the FULL topCoins list (not the
   * sliced chip subset) so the rail's "tradeable only" filter is accurate.
   */
  tradesTradeableCoin: boolean;
  /** Up to 3 flags for the chip row (risk flags first). */
  flags: string[];
  /** ALL flags (risk first), for the trader-detail risk/health read. */
  allFlags: string[];
  leaderboardTop: boolean;
  topCoins: string[];
  /** Slim metrics for the trader-detail drawer (numbers-first). */
  metrics: TopTraderMetrics;
}

const TRADEABLE_SET = new Set<string>(TRADEABLE_COINS);

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

/** Project a single rated wallet to its slim rail row. PURE. */
function toRow(w: RatedWallet): TopTraderRow {
  const riskFlags = w.flags.filter((f) => RISK_FLAGS.has(f));
  const cleanFlags = w.flags.filter((f) => !RISK_FLAGS.has(f));
  const allFlags = [...riskFlags, ...cleanFlags];
  const coins = w.topCoins ?? [];
  return {
    address: w.address,
    short: w.short,
    displayName: w.displayName,
    composite: w.composite,
    hasRisk: riskFlags.length > 0,
    cleanBook: w.flags.includes('CLEAN_BOOK'),
    tradesTradeableCoin: coins.some((c) => TRADEABLE_SET.has(normalizeCoin(c))),
    flags: allFlags.slice(0, 3),
    allFlags,
    leaderboardTop: w.leaderboardTop ?? false,
    topCoins: coins.slice(0, 3),
    metrics: slimMetrics(w.metrics),
  };
}

/**
 * Top `limit` rated wallets as slim rows (default 12). Used by the trade-watch
 * backend (leader selection) and the cockpit rail. Ranked composite-desc.
 */
export function getTopTraders(limit = 12): TopTraderRow[] {
  return rankRailTraders(loadRatedWallets().wallets, limit);
}

/**
 * PURE: rank a wallet list (composite desc, leaderboardTop tiebreak) → slim rail
 * rows. Shared by the file-based readers AND the async Supabase read path (the
 * cockpit page ranks DB-loaded wallets with this), so neither pulls the other's
 * I/O. No fs, no network.
 */
export function rankRailTraders(wallets: RatedWallet[], limit: number): TopTraderRow[] {
  return [...wallets].sort(rank).slice(0, limit).map(toRow);
}

/**
 * A LARGER ranked slice for the left rail (default 50) so the operator can
 * scroll through many rated wallets and filter client-side. Still a slim
 * server-projection — the 2.8MB dataset never reaches the client. Separate from
 * getTopTraders so the backend's leader-selection default (12) is unaffected.
 */
export function getRailTraders(limit = 50): TopTraderRow[] {
  return getTopTraders(limit);
}

/** Dataset-level freshness metadata for the rail's "ratings" indicator. */
export interface RatedMeta {
  /** ISO timestamp the rated-wallets dataset was generated (null if unknown). */
  generatedAt: string | null;
  /** Number of rated wallets. */
  count: number;
}

/**
 * Read the rated-wallets dataset's freshness metadata (server-only fs read). The
 * weekly re-rank pipeline stamps `generatedAt`; the rail shows it so the operator
 * can see when the rankings were last refreshed (and whether they're stale).
 */
export function getRatedMeta(): RatedMeta {
  const ds = loadRatedWallets();
  return {
    generatedAt: ds.generatedAt ?? null,
    count: typeof ds.count === 'number' ? ds.count : ds.wallets.length,
  };
}
