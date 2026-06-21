/**
 * PURE scout scorecard — turns the paper track record into the ONE honest number
 * the pre-registered bar is judged on: net P&L after the modeled funding +
 * slippage haircut, projected to a monthly run-rate, with a kill/continue/graduate
 * verdict. No I/O — the script reads the ledger + funding and feeds aggregates in.
 * Fixture-tested. The verdict thresholds ARE the pre-registered bar.
 */

export interface ScorecardInput {
  /** Realized P&L from the ledger, net of taker fees (the gross we start from). */
  realizedGrossUsd: number;
  /** Sum of ENTRY notional across all closed trades (drives the slippage haircut). */
  totalEntryNotionalUsd: number;
  /** Pre-computed funding haircut (USD) — sum of per-position funding-while-holding. */
  fundingHaircutUsd: number;
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
  slippageBps: number; // adverse bps per leg
  monthlyBarUsd: number; // graduation target (~$1000/mo)
  killAfterTrades: number; // min trades before a "kill" verdict is allowed
  maxDrawdownPct: number; // graduation DD ceiling (e.g. 0.15)
  graduationDays: number; // min track-record length before "graduate" (e.g. 90)
}

export const DEFAULT_SCORECARD_CONFIG: ScorecardConfig = {
  slippageBps: 5,
  monthlyBarUsd: 1000,
  killAfterTrades: 15,
  maxDrawdownPct: 0.15,
  graduationDays: 90,
};

export type ScoutVerdict = 'kill' | 'continue' | 'graduate';

export interface Scorecard {
  tradeCount: number;
  winRate: number; // 0–1
  realizedGrossUsd: number;
  slippageHaircutUsd: number;
  fundingHaircutUsd: number;
  netUsd: number; // honest: gross − slippage − funding
  monthlyRunRateUsd: number; // net projected to 30 days
  vsBarUsd: number; // monthlyRunRate − bar
  maxDrawdownPct: number | null;
  verdict: ScoutVerdict;
  reason: string;
}

export function buildScorecard(input: ScorecardInput, cfg: ScorecardConfig = DEFAULT_SCORECARD_CONFIG): Scorecard {
  const slippageHaircutUsd = input.totalEntryNotionalUsd * (cfg.slippageBps / 10_000) * 2; // entry + exit
  const netUsd = input.realizedGrossUsd - slippageHaircutUsd - input.fundingHaircutUsd;

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
  } else if (
    monthlyRunRateUsd >= cfg.monthlyBarUsd &&
    periodDays >= cfg.graduationDays &&
    ddPct != null &&
    ddPct < cfg.maxDrawdownPct
  ) {
    verdict = 'graduate';
    reason = `run-rate $${monthlyRunRateUsd.toFixed(0)}/mo over ${periodDays}d, DD ${(ddPct * 100).toFixed(1)}% < ${(cfg.maxDrawdownPct * 100).toFixed(0)}% — clears the bar; consider the live seam.`;
  } else {
    verdict = 'continue';
    reason = `run-rate $${monthlyRunRateUsd.toFixed(0)}/mo over ${periodDays}d — keep gathering (bar $${cfg.monthlyBarUsd}/mo @ ${cfg.graduationDays}d, DD < ${(cfg.maxDrawdownPct * 100).toFixed(0)}%).`;
  }

  return {
    tradeCount: input.tradeCount,
    winRate,
    realizedGrossUsd: input.realizedGrossUsd,
    slippageHaircutUsd,
    fundingHaircutUsd: input.fundingHaircutUsd,
    netUsd,
    monthlyRunRateUsd,
    vsBarUsd,
    maxDrawdownPct: ddPct,
    verdict,
    reason,
  };
}
