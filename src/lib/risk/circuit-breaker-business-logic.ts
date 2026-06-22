/**
 * PURE account-level circuit breaker — the portfolio brake the senior-analyst
 * review flagged as the #1 missing risk control. Per-trade stops protect single
 * positions; this protects the ACCOUNT: when the day's loss or the peak-to-trough
 * drawdown crosses a threshold, it BLOCKS new entries (and flags a flatten on a
 * drawdown halt). It is the thing that lets slow capital compound without a
 * correlated cluster move quietly flattening the book.
 *
 * No I/O — the service tracks equity/peak/day-start and feeds them in. The breaker
 * never auto-fires a trade: it gates new opens + RECOMMENDS a flatten (executed by
 * the existing exit machinery / human), preserving no-auto-fire for real funds.
 * Deterministic, fixture-tested.
 */

export interface CircuitBreakerConfig {
  /** Block new entries when the day's loss ≥ this fraction of day-start equity. */
  maxDailyLossPct: number;
  /** Hard halt (+ flatten recommendation) when drawdown from peak ≥ this fraction. */
  maxDrawdownPct: number;
  /** Recommend flattening when the drawdown halt trips (alert; never auto-fires). */
  flattenOnDrawdownHalt: boolean;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  maxDailyLossPct: 0.05, // 5% of the day's opening equity
  maxDrawdownPct: 0.15, // 15% peak-to-trough
  flattenOnDrawdownHalt: true,
};

export interface CircuitBreakerInput {
  /** Current account equity (paper: starting + realized + unrealized; live: clearinghouse value). */
  equityUsd: number;
  /** Equity at the start of the current UTC day. */
  dayStartEquityUsd: number;
  /** Highest equity ever seen (the drawdown reference). */
  peakEquityUsd: number;
}

export type CircuitBreakerTrip = 'daily-loss' | 'drawdown' | null;

export interface CircuitBreakerDecision {
  blockNewEntries: boolean;
  flattenRecommended: boolean;
  tripped: CircuitBreakerTrip;
  /** Current day loss as a fraction of day-start equity (positive = down). */
  dailyLossPct: number;
  /** Current drawdown from peak as a fraction (positive = down). */
  drawdownPct: number;
  reason: string;
}

export function evaluateCircuitBreaker(
  inp: CircuitBreakerInput,
  cfg: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG,
): CircuitBreakerDecision {
  const dailyLossPct = inp.dayStartEquityUsd > 0 ? (inp.dayStartEquityUsd - inp.equityUsd) / inp.dayStartEquityUsd : 0;
  const drawdownPct = inp.peakEquityUsd > 0 ? (inp.peakEquityUsd - inp.equityUsd) / inp.peakEquityUsd : 0;

  const ddTrip = drawdownPct >= cfg.maxDrawdownPct;
  const dailyTrip = dailyLossPct >= cfg.maxDailyLossPct;
  // Drawdown is the more severe state → report it first.
  const tripped: CircuitBreakerTrip = ddTrip ? 'drawdown' : dailyTrip ? 'daily-loss' : null;

  const blockNewEntries = ddTrip || dailyTrip;
  const flattenRecommended = ddTrip && cfg.flattenOnDrawdownHalt;

  let reason: string;
  if (ddTrip) {
    reason = `HALT — drawdown ${(drawdownPct * 100).toFixed(1)}% ≥ ${(cfg.maxDrawdownPct * 100).toFixed(0)}% from peak. Block new entries${flattenRecommended ? ' + flatten recommended' : ''}.`;
  } else if (dailyTrip) {
    reason = `daily-loss halt — down ${(dailyLossPct * 100).toFixed(1)}% ≥ ${(cfg.maxDailyLossPct * 100).toFixed(0)}% on the day. Block new entries until the next UTC day.`;
  } else {
    reason = `ok — day ${dailyLossPct >= 0 ? '−' : '+'}${Math.abs(dailyLossPct * 100).toFixed(1)}%, drawdown ${(drawdownPct * 100).toFixed(1)}%.`;
  }

  return { blockNewEntries, flattenRecommended, tripped, dailyLossPct, drawdownPct, reason };
}

export interface CircuitBreakerState {
  peakEquityUsd: number;
  dayStartEquityUsd: number;
  /** Epoch ms when the current day's equity was anchored. */
  dayStartAtMs: number;
}

const utcDay = (ms: number): number => Math.floor(ms / 86_400_000);

/**
 * Advance the carried state with a fresh equity reading: lift the peak, and
 * re-anchor day-start equity at the first reading of a new UTC day. PURE — the
 * service persists the returned state.
 */
export function rollCircuitBreakerState(
  prev: CircuitBreakerState | null,
  equityUsd: number,
  now: number,
): CircuitBreakerState {
  if (!prev) {
    return { peakEquityUsd: equityUsd, dayStartEquityUsd: equityUsd, dayStartAtMs: now };
  }
  const sameDay = utcDay(prev.dayStartAtMs) === utcDay(now);
  return {
    peakEquityUsd: Math.max(prev.peakEquityUsd, equityUsd),
    dayStartEquityUsd: sameDay ? prev.dayStartEquityUsd : equityUsd,
    dayStartAtMs: sameDay ? prev.dayStartAtMs : now,
  };
}
