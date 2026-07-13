/**
 * Scout decision-context — PURE math for the enriched snapshot (no I/O).
 *
 * The scout's judgment model gets the same signal surface the human desk uses:
 * taker flow + book imbalance (tape), the leader book per coin, the Assistance
 * Fund buy rate, and funding/OI expressed as PERCENTILES of the coin's OWN
 * recorded history (`market_snapshots`) instead of bare point-in-time numbers.
 * Everything here is ADVISORY context — nothing auto-scores or gates a trade
 * (the roadmap rule: signals graduate into weights only after a backtest).
 */

/** One coin's tape read (point sample — null flow = not measured, never 0). */
export interface ScoutTapeRead {
  coin: string;
  /** Notional-weighted aggressor skew in [-1, 1]; null = tape unavailable. */
  takerFlow: number | null;
  /** Depth imbalance in [-1, 1] near mid (+ = bid-heavy); null = book unavailable. */
  bookImbalance: number | null;
  /** Top-of-book spread in bps; null when unavailable. */
  spreadBps: number | null;
}

/** One coin's leader-book summary from the trader-watch feed. */
export interface ScoutLeaderRead {
  coin: string;
  longUsd: number;
  shortUsd: number;
  longWallets: number;
  shortWallets: number;
  /** The single largest position (signed context for "is this one whale or many"). */
  topWalletUsd: number;
  topWalletSide: 'long' | 'short' | null;
}

/** Funding / OI framed against the coin's own recorded history. */
export interface ScoutPercentileRead {
  coin: string;
  /** Percentile [0,1] of current funding vs the recorded series; null = series too thin. */
  fundingPctile: number | null;
  /** Percentile [0,1] of current OI vs the recorded series; null = series too thin. */
  oiPctile: number | null;
  /** How many recorded points backed the percentiles (honesty about depth). */
  sampleCount: number;
}

/** Minimum history points before a percentile is meaningful (≈ half a day @20min). */
export const PERCENTILE_MIN_SAMPLES = 36;

/**
 * Percentile rank of `current` within `history` (fraction of points strictly
 * below + half the ties — the standard mid-rank). Null when the series is too
 * thin to mean anything (< PERCENTILE_MIN_SAMPLES) or current is not finite.
 */
export function percentileRank(history: number[], current: number): number | null {
  if (!Number.isFinite(current)) return null;
  const vals = history.filter((v) => Number.isFinite(v));
  if (vals.length < PERCENTILE_MIN_SAMPLES) return null;
  let below = 0;
  let ties = 0;
  for (const v of vals) {
    if (v < current) below++;
    else if (v === current) ties++;
  }
  return (below + ties / 2) / vals.length;
}

/** Raw leader_positions row shape (subset) this module folds. */
export interface LeaderPositionRow {
  coin: string;
  side: string;
  position_value: number | string | null;
}

/** Fold leader_positions rows into per-coin books. Unknown sides are dropped. */
export function summarizeLeaderBook(rows: LeaderPositionRow[]): ScoutLeaderRead[] {
  const byCoin = new Map<string, ScoutLeaderRead>();
  for (const r of rows) {
    const side = r.side === 'long' ? 'long' : r.side === 'short' ? 'short' : null;
    if (!side) continue;
    const usd = Number(r.position_value);
    if (!Number.isFinite(usd) || usd <= 0) continue;
    const coin = r.coin.trim().toUpperCase();
    const cur =
      byCoin.get(coin) ??
      ({ coin, longUsd: 0, shortUsd: 0, longWallets: 0, shortWallets: 0, topWalletUsd: 0, topWalletSide: null } as ScoutLeaderRead);
    if (side === 'long') {
      cur.longUsd += usd;
      cur.longWallets += 1;
    } else {
      cur.shortUsd += usd;
      cur.shortWallets += 1;
    }
    if (usd > cur.topWalletUsd) {
      cur.topWalletUsd = usd;
      cur.topWalletSide = side;
    }
    byCoin.set(coin, cur);
  }
  return [...byCoin.values()];
}

/**
 * Assistance-Fund buy rate normalized to HYPE/24h from two balance readings.
 * Null when either reading is missing or the window is too short to annualize
 * honestly (< 2h). Negative deltas return as-is (a real outflow is information).
 */
export function afDailyRate(
  latest: { atMs: number; balance: number } | null,
  earlier: { atMs: number; balance: number } | null,
): number | null {
  if (!latest || !earlier) return null;
  const dtMs = latest.atMs - earlier.atMs;
  if (!(dtMs >= 2 * 3_600_000)) return null;
  if (!Number.isFinite(latest.balance) || !Number.isFinite(earlier.balance)) return null;
  return ((latest.balance - earlier.balance) * 24 * 3_600_000) / dtMs;
}
