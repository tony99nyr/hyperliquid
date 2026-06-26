/**
 * PURE scout scorecard — turns the paper track record into the ONE honest number
 * the pre-registered bar is judged on: net P&L after the modeled funding +
 * slippage haircut, projected to a monthly run-rate, with a kill/continue/graduate
 * verdict. No I/O — the script reads the ledger + funding and feeds aggregates in.
 * Fixture-tested. The verdict thresholds ARE the pre-registered bar.
 *
 * HONESTY (post-adversarial-review):
 * - `realizedGrossUsd` is CLOSED-only (open-position entry fees no longer drag it).
 * - `fundingHaircutUsd` is SIGNED (− = net carry earned), computed per-coin with
 *   the real funding sign upstream — not a flat side-agnostic cost.
 * - `slippageHaircutUsd` is pre-computed per-coin upstream (thin books cost more).
 * - GRADUATE requires a minimum TRADE COUNT (not just days) so a lucky short
 *   streak can't project past the bar; a SLOW-BLEED kill trips on a negative net
 *   over a time window even when trade count stays under the churn threshold.
 */

export type ScoutVerdict = 'kill' | 'continue' | 'graduate';

export interface ScorecardInput {
  /** Realized P&L from CLOSED round-trips, net of taker fees (the gross). */
  realizedGrossUsd: number;
  /** Pre-computed slippage haircut (USD, ≥0) — per-coin, both legs. */
  slippageHaircutUsd: number;
  /** Pre-computed funding haircut, SIGNED: + = net cost, − = net carry earned. */
  fundingHaircutUsd: number;
  /**
   * Open mark-to-market P&L, SIGNED (+ = unrealized gain). Default/omitted = 0, so
   * the existing realized-only (single-leg perp) lanes are unchanged. The
   * vault-allocation lane (Lane A) has NO closed round-trips — its edge IS the open
   * NAV track — so it feeds the NAV change here. Folded into `netUsd` below.
   * (Lane-specific gates — vault bad-debt kill, allocated-capital drawdown — are
   * layered by the lane, not here; this only makes the headline number honest.)
   */
  unrealizedPnlUsd?: number;
  /** Closed round-trips. */
  tradeCount: number;
  wins: number;
  losses: number;
  /** Days the track record spans (for the monthly run-rate projection). */
  periodDays: number;
  /** Peak-to-trough drawdown of the cumulative net curve (USD, ≥ 0), if known. */
  maxDrawdownUsd?: number;
  /** Account equity the drawdown is measured against (for the % gate), if known. */
  equityUsd?: number;
}

export interface ScorecardConfig {
  monthlyBarUsd: number; // graduation target (~$1000/mo)
  killAfterTrades: number; // churn: min trades before a negative-net KILL
  slowBleedDays: number; // slow-bleed: KILL on negative net past this many days
  slowBleedMinTrades: number; // ...but only once there are at least this many CLOSED trades (so unclosed entry-fee drag alone can't KILL)
  minTradesToGraduate: number; // GRADUATE needs at least this many closed trades (sample size)
  maxDrawdownPct: number; // graduation DD ceiling (e.g. 0.15)
  graduationDays: number; // min track-record length before "graduate" (e.g. 90)
}

export const DEFAULT_SCORECARD_CONFIG: ScorecardConfig = {
  monthlyBarUsd: 1000,
  killAfterTrades: 15,
  slowBleedDays: 21,
  slowBleedMinTrades: 3,
  minTradesToGraduate: 30,
  maxDrawdownPct: 0.15,
  graduationDays: 90,
};

export interface Scorecard {
  tradeCount: number;
  winRate: number; // 0–1
  realizedGrossUsd: number;
  slippageHaircutUsd: number;
  fundingHaircutUsd: number; // signed
  netUsd: number; // honest: realized gross − slippage − funding + open mark-to-market
  monthlyRunRateUsd: number; // net projected to 30 days
  vsBarUsd: number; // monthlyRunRate − bar
  maxDrawdownPct: number | null;
  verdict: ScoutVerdict;
  reason: string;
}

export function buildScorecard(input: ScorecardInput, cfg: ScorecardConfig = DEFAULT_SCORECARD_CONFIG): Scorecard {
  const netUsd =
    input.realizedGrossUsd - input.slippageHaircutUsd - input.fundingHaircutUsd + (input.unrealizedPnlUsd ?? 0);

  const decided = input.wins + input.losses;
  const winRate = decided > 0 ? input.wins / decided : 0;

  const periodDays = Math.max(1, input.periodDays);
  const monthlyRunRateUsd = (netUsd / periodDays) * 30;
  const vsBarUsd = monthlyRunRateUsd - cfg.monthlyBarUsd;

  const ddPct =
    input.maxDrawdownUsd != null && input.equityUsd != null && input.equityUsd > 0
      ? input.maxDrawdownUsd / input.equityUsd
      : null;

  let verdict: ScoutVerdict;
  let reason: string;
  if (netUsd < 0 && input.tradeCount >= cfg.killAfterTrades) {
    verdict = 'kill';
    reason = `net $${netUsd.toFixed(0)} over ${input.tradeCount} trades — bleeding after the realism haircut; kill the lane.`;
  } else if (netUsd < 0 && periodDays >= cfg.slowBleedDays && input.tradeCount >= cfg.slowBleedMinTrades) {
    // Slow bleed: negative for weeks WITH at least a few closed trades (so an
    // open position's unclosed entry fee alone — 0 closed trades — can't KILL).
    verdict = 'kill';
    reason = `net $${netUsd.toFixed(0)} over ${periodDays.toFixed(0)}d (${input.tradeCount} trades) — slow bleed past ${cfg.slowBleedDays}d; kill the lane.`;
  } else if (
    monthlyRunRateUsd >= cfg.monthlyBarUsd &&
    periodDays >= cfg.graduationDays &&
    input.tradeCount >= cfg.minTradesToGraduate &&
    ddPct != null &&
    ddPct < cfg.maxDrawdownPct
  ) {
    verdict = 'graduate';
    reason = `run-rate $${monthlyRunRateUsd.toFixed(0)}/mo over ${periodDays.toFixed(0)}d, ${input.tradeCount} trades, DD ${(ddPct * 100).toFixed(1)}% < ${(cfg.maxDrawdownPct * 100).toFixed(0)}% — clears the bar; consider the live seam.`;
  } else {
    verdict = 'continue';
    const gates: string[] = [];
    if (monthlyRunRateUsd < cfg.monthlyBarUsd) gates.push(`run-rate $${monthlyRunRateUsd.toFixed(0)}<$${cfg.monthlyBarUsd}/mo`);
    if (periodDays < cfg.graduationDays) gates.push(`${periodDays.toFixed(0)}<${cfg.graduationDays}d`);
    if (input.tradeCount < cfg.minTradesToGraduate) gates.push(`${input.tradeCount}<${cfg.minTradesToGraduate} trades`);
    if (ddPct == null) gates.push('DD unknown');
    reason = `keep gathering — ${gates.join(', ')} (need run-rate ≥ bar, ≥${cfg.graduationDays}d, ≥${cfg.minTradesToGraduate} trades, DD < ${(cfg.maxDrawdownPct * 100).toFixed(0)}%).`;
  }

  return {
    tradeCount: input.tradeCount,
    winRate,
    realizedGrossUsd: input.realizedGrossUsd,
    slippageHaircutUsd: input.slippageHaircutUsd,
    fundingHaircutUsd: input.fundingHaircutUsd,
    netUsd,
    monthlyRunRateUsd,
    vsBarUsd,
    maxDrawdownPct: ddPct,
    verdict,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Per-lane scorecards (scout multi-lane refactor) — PURE.
// ---------------------------------------------------------------------------

/** A NULL/empty lane folds into the legacy directional book. */
export const DEFAULT_LANE = 'directional';

export interface LanePositionRow {
  lane: string | null;
  coin: string;
  side: string; // 'long' | 'short' | 'flat'
  realizedPnlUsd: number;
  feesPaidUsd: number;
}

export interface LaneHypothesisRow {
  lane: string | null;
  status: string; // 'open' | 'confirmed' | 'invalidated' | 'resolved'
}

export interface LaneScorecard {
  lane: string;
  openCount: number;
  card: Scorecard;
}

const normLane = (l: string | null | undefined): string =>
  typeof l === 'string' && l.trim() !== '' ? l.trim() : DEFAULT_LANE;

/**
 * Build ONE scorecard per lane from the scout's lane-tagged ledger. PURE.
 *
 * Realized P&L + open counts group by `positions.lane`; win/loss by
 * `hypotheses.lane`; funding is attributed per lane via a coin→lane map derived
 * from the positions (each coin's signed funding haircut is charged to the lane
 * that holds it). ASSUMPTION (documented): a coin is traded in at most ONE lane
 * at a time — true for the early multi-lane setup (lanes trade distinct
 * instruments; the vault lane does no perp fills at all). If a coin ever spans
 * lanes, its funding lands in whichever lane the coin→lane map resolves last.
 *
 * The account-level verdict (the pre-registered bar + circuit breaker) stays a
 * SEPARATE aggregate scorecard — these per-lane cards are the breakdown the
 * weekly review reads to decide which lane lives or dies.
 */
export function buildLaneScorecards(args: {
  positions: LanePositionRow[];
  hypotheses: LaneHypothesisRow[];
  /** Signed funding haircut per coin (+ = cost, − = carry earned). */
  fundingByCoin: Record<string, number>;
  periodDays: number;
  /** Optional per-lane config override (e.g. a lower bar for the passive vault lane). */
  configFor?: (lane: string) => ScorecardConfig;
}): LaneScorecard[] {
  const lanes = new Set<string>();
  const realized = new Map<string, number>();
  const openCount = new Map<string, number>();
  const coinToLane = new Map<string, string>();
  const wins = new Map<string, number>();
  const losses = new Map<string, number>();
  const closed = new Map<string, number>();

  const bump = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

  for (const p of args.positions) {
    const lane = normLane(p.lane);
    lanes.add(lane);
    bump(realized, lane, (Number(p.realizedPnlUsd) || 0) - (Number(p.feesPaidUsd) || 0));
    if (p.side !== 'flat') bump(openCount, lane);
    if (p.coin) coinToLane.set(p.coin.toUpperCase(), lane);
  }

  // Attribute each coin's signed funding to the lane that holds it.
  const fundingByLane = new Map<string, number>();
  for (const [coin, amt] of Object.entries(args.fundingByCoin)) {
    const lane = coinToLane.get(coin.toUpperCase()) ?? DEFAULT_LANE;
    lanes.add(lane);
    bump(fundingByLane, lane, Number(amt) || 0);
  }

  for (const h of args.hypotheses) {
    const lane = normLane(h.lane);
    lanes.add(lane);
    if (h.status === 'confirmed') { bump(wins, lane); bump(closed, lane); }
    else if (h.status === 'invalidated') { bump(losses, lane); bump(closed, lane); }
    else if (h.status === 'resolved') bump(closed, lane);
  }

  return [...lanes].sort().map((lane) => {
    const input: ScorecardInput = {
      realizedGrossUsd: realized.get(lane) ?? 0,
      slippageHaircutUsd: 0, // slippage is embedded in the fill price (paper-fill-realism)
      fundingHaircutUsd: fundingByLane.get(lane) ?? 0,
      tradeCount: closed.get(lane) ?? 0,
      wins: wins.get(lane) ?? 0,
      losses: losses.get(lane) ?? 0,
      periodDays: args.periodDays,
    };
    const cfg = args.configFor?.(lane) ?? DEFAULT_SCORECARD_CONFIG;
    return { lane, openCount: openCount.get(lane) ?? 0, card: buildScorecard(input, cfg) };
  });
}
