/**
 * PURE paper-realism adjustments — the "honesty fix" for the autonomous paper
 * scout. Live trading pays funding-while-holding and suffers entry/exit slippage;
 * the paper fill source models neither (it walks a fresh book + taker fee only).
 * Without these, paper P&L systematically OVERSTATES the edge and the
 * pre-registered success bar would be measuring fiction.
 *
 * These are applied to PAPER results ONLY — never folded into the shared
 * `pnl-business-logic` (which must stay mode-unaware; live funding/slippage are
 * already real in the exchange fills). The scout-cycle + scout-review use these
 * to record + report an honest net P&L. No I/O. Fixture-tested.
 *
 * Funding sign convention (Hyperliquid): a POSITIVE hourly funding rate means
 * LONGS PAY shorts (matches `rubric-scorers-business-logic` carry: long pays
 * positive funding). So a long's funding COST is +rate·notional·hours; a short's
 * is the negative of that (the short RECEIVES when the rate is positive).
 */

export type Side = 'long' | 'short';

export interface FundingCostInput {
  side: Side;
  /** Position notional in USD (px · sz), always ≥ 0. */
  notionalUsd: number;
  /** Signed hourly funding rate (e.g. 0.0000125 = +0.00125%/hr). + ⇒ longs pay. */
  fundingRateHourly: number;
  /** Hours the position was (or has been) held. */
  holdingHours: number;
}

/**
 * Funding PAID by this side over the holding period, in USD.
 * Positive = a cost to this side; negative = funding received.
 */
export function fundingCostUsd(inp: FundingCostInput): number {
  if (inp.notionalUsd <= 0 || inp.holdingHours <= 0) return 0;
  const longSign = inp.side === 'long' ? 1 : -1;
  return longSign * inp.fundingRateHourly * inp.notionalUsd * inp.holdingHours;
}

export interface SlippagePenaltyInput {
  /** Notional crossing the book on this leg, in USD. */
  notionalUsd: number;
  /** Adverse penalty in basis points to model decision→fill latency + impact. */
  slippageBps: number;
}

/** Adverse slippage cost for ONE leg (entry or exit), in USD (always ≥ 0). */
export function slippagePenaltyUsd(inp: SlippagePenaltyInput): number {
  if (inp.notionalUsd <= 0 || inp.slippageBps <= 0) return 0;
  return inp.notionalUsd * (inp.slippageBps / 10_000);
}

export interface PaperRealismInput {
  side: Side;
  /** Notional at entry (≈ exit) in USD. */
  notionalUsd: number;
  fundingRateHourly: number;
  holdingHours: number;
  /** Adverse slippage bps applied to BOTH legs (entry + exit). */
  slippageBps: number;
}

export interface PaperRealismAdjustment {
  fundingUsd: number; // signed (cost > 0, received < 0)
  slippageUsd: number; // ≥ 0, both legs
  /** Total to SUBTRACT from gross paper P&L to get an honest net. */
  totalUsd: number;
}

/**
 * The full round-trip realism haircut: funding-while-holding + two-leg slippage.
 * `totalUsd` is what the scout subtracts from gross paper P&L. A short in a
 * negative-funding regime can have a NEGATIVE funding component (it earns carry),
 * which correctly REDUCES the haircut.
 */
export function paperRealismAdjustmentUsd(inp: PaperRealismInput): PaperRealismAdjustment {
  const fundingUsd = fundingCostUsd({
    side: inp.side,
    notionalUsd: inp.notionalUsd,
    fundingRateHourly: inp.fundingRateHourly,
    holdingHours: inp.holdingHours,
  });
  // Entry + exit both cross the book.
  const slippageUsd = 2 * slippagePenaltyUsd({ notionalUsd: inp.notionalUsd, slippageBps: inp.slippageBps });
  return { fundingUsd, slippageUsd, totalUsd: fundingUsd + slippageUsd };
}

/** Default adverse slippage (bps per leg) for an LLM-paced paper scout. */
export const DEFAULT_PAPER_SLIPPAGE_BPS = 5;

/** Convenience: honest net = gross − realism haircut. */
export function honestNetUsd(grossPnlUsd: number, adj: PaperRealismAdjustment): number {
  return grossPnlUsd - adj.totalUsd;
}
