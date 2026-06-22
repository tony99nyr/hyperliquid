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
  slowBleedDays: number; // slow-bleed: KILL on negative net past this many days, any trade count
  minTradesToGraduate: number; // GRADUATE needs at least this many closed trades (sample size)
  maxDrawdownPct: number; // graduation DD ceiling (e.g. 0.15)
  graduationDays: number; // min track-record length before "graduate" (e.g. 90)
}

export const DEFAULT_SCORECARD_CONFIG: ScorecardConfig = {
  monthlyBarUsd: 1000,
  killAfterTrades: 15,
  slowBleedDays: 21,
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
  netUsd: number; // honest: gross − slippage − funding
  monthlyRunRateUsd: number; // net projected to 30 days
  vsBarUsd: number; // monthlyRunRate − bar
  maxDrawdownPct: number | null;
  verdict: ScoutVerdict;
  reason: string;
}

export function buildScorecard(input: ScorecardInput, cfg: ScorecardConfig = DEFAULT_SCORECARD_CONFIG): Scorecard {
  const netUsd = input.realizedGrossUsd - input.slippageHaircutUsd - input.fundingHaircutUsd;

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
  } else if (netUsd < 0 && periodDays >= cfg.slowBleedDays) {
    // Slow bleed: negative for weeks even without churn-level trade counts.
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
