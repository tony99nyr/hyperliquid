/**
 * PURE backtest simulator — replays a sequence of per-bar rubric decisions over
 * historical OHLC and simulates the scout's entry/exit, with realistic frictions
 * (adverse slippage on each leg + funding-while-holding). Produces closed trades
 * + aggregates that feed the SAME scorecard the live scout is judged by, so a
 * backtest verdict is directly comparable to the paper bar.
 *
 * No I/O, no look-ahead: the decision on bar i is computed (by the replay service)
 * from candles UP TO bar i; entry is at bar i's close; exits are detected on
 * SUBSEQUENT bars' high/low (stop/target) or a signal flip. Fixture-tested.
 *
 * Scope (honest): the replay feeds a rubric signal with leaders/carry/micro
 * ABLATED (no historical L2/leader/funding) — this is the leaders-ablation test
 * of the regime/trend core. Funding is a flat assumption historically.
 */

export type Side = 'long' | 'short';

/** One historical bar carrying the rubric's decision for it (computed up to its close). */
export interface BacktestBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** The would-be trade side this bar (none = stand down). */
  side: Side | 'none';
  /** True when the rubric said GO on `side` at this bar. */
  go: boolean;
  /** Levels for the chosen side (from deriveLevels). */
  invalidation: number; // stop
  target: number;
  /** Hourly funding rate to accrue while holding (flat/assumed historically). */
  fundingHourly: number;
}

export interface BacktestSimConfig {
  /** Adverse slippage (bps) applied to TAKER fills. */
  slippageBps: number;
  /** Hours represented by one bar (for funding accrual). */
  barHours: number;
  /** Notional per trade (USD) — fixed sizing for comparability. */
  notionalUsd: number;
  /**
   * Execution model. 'taker' (default): cross the spread immediately at the
   * signal bar's close, paying adverse slippage on both legs. 'maker': post a
   * passive limit at the signal close and ONLY fill if a later bar trades to it
   * within maxBarsToFill (else the entry is MISSED — the adverse-selection that
   * makes passive entries miss runaway winners); maker entry + target exits earn
   * the rebate; protective STOP exits still cross as taker (you can't post a stop).
   */
  fillModel?: 'taker' | 'maker';
  /** Maker rebate (bps) earned on each passive fill (default 1.5 = HL maker). */
  makerRebateBps?: number;
  /** Bars a posted maker entry rests before it's abandoned unfilled (default 3). */
  maxBarsToFill?: number;
}

export interface BacktestTrade {
  side: Side;
  entryTime: number;
  exitTime: number;
  entryPx: number;
  exitPx: number;
  barsHeld: number;
  grossPnlUsd: number; // price move on notional, after entry+exit slippage
  fundingUsd: number; // signed cost (− = earned)
  netPnlUsd: number;
  reason: 'target' | 'stop' | 'flip' | 'end';
}

export interface BacktestResult {
  trades: BacktestTrade[];
  wins: number;
  losses: number;
  netUsd: number;
  /** Peak-to-trough drawdown of the cumulative net curve (USD, ≥0). */
  maxDrawdownUsd: number;
}

const bps = (px: number, b: number, adverseSign: number): number => px * (1 + (adverseSign * b) / 10_000);

/**
 * Walk the bars; hold at most one position. Enter at the close of a GO bar; exit
 * on the first subsequent bar whose low/high crosses the stop/target, on a signal
 * flip (opposite-side GO), or at the series end. Slippage worsens every fill;
 * funding accrues per bar held (signed: a short in positive funding earns carry).
 */
export function simulateBacktest(bars: BacktestBar[], cfg: BacktestSimConfig): BacktestResult {
  const trades: BacktestTrade[] = [];
  const model = cfg.fillModel ?? 'taker';
  const rebateUsd = cfg.notionalUsd * ((cfg.makerRebateBps ?? 1.5) / 10_000);
  const maxBarsToFill = cfg.maxBarsToFill ?? 3;

  let open:
    | { side: Side; entryPx: number; entryTime: number; entryIdx: number; stop: number; target: number; fundingHourly: number; entryRebateUsd: number }
    | null = null;
  // Maker-only: a posted passive entry awaiting fill (fills when price trades to it).
  let pending: { side: Side; limit: number; stop: number; target: number; fundingHourly: number; postedIdx: number; postedTime: number } | null = null;

  // leg='taker' → cross the spread (adverse slippage, no rebate); 'maker' → fill at
  // the posted price (no adverse) + earn the rebate. Rebates are credited into gross.
  const closeTrade = (exitPxRaw: number, exitTime: number, exitIdx: number, reason: BacktestTrade['reason'], leg: 'taker' | 'maker') => {
    if (!open) return;
    const exitPx = leg === 'taker' ? bps(exitPxRaw, cfg.slippageBps, open.side === 'long' ? -1 : 1) : exitPxRaw;
    const exitRebateUsd = leg === 'maker' ? rebateUsd : 0;
    const dir = open.side === 'long' ? 1 : -1;
    const qty = cfg.notionalUsd / open.entryPx;
    const grossPnlUsd = dir * (exitPx - open.entryPx) * qty + open.entryRebateUsd + exitRebateUsd;
    const barsHeld = Math.max(1, exitIdx - open.entryIdx);
    const fundingUsd = dir * open.fundingHourly * cfg.notionalUsd * (barsHeld * cfg.barHours);
    const netPnlUsd = grossPnlUsd - fundingUsd;
    trades.push({ side: open.side, entryTime: open.entryTime, exitTime, entryPx: open.entryPx, exitPx, barsHeld, grossPnlUsd, fundingUsd, netPnlUsd, reason });
    open = null;
  };

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // Manage an open position FIRST. STOP always crosses (taker — you can't post a
    // protective stop); TARGET is a resting limit (maker when in maker mode); a
    // signal FLIP crosses out (taker).
    if (open) {
      const targetLeg = model === 'maker' ? 'maker' : 'taker';
      if (open.side === 'long') {
        if (bar.low <= open.stop) closeTrade(open.stop, bar.time, i, 'stop', 'taker');
        else if (bar.high >= open.target) closeTrade(open.target, bar.time, i, 'target', targetLeg);
      } else {
        if (bar.high >= open.stop) closeTrade(open.stop, bar.time, i, 'stop', 'taker');
        else if (bar.low <= open.target) closeTrade(open.target, bar.time, i, 'target', targetLeg);
      }
      if (open && bar.go && bar.side !== 'none' && bar.side !== open.side) {
        closeTrade(bar.close, bar.time, i, 'flip', 'taker');
      }
    }

    if (model === 'taker') {
      // Cross immediately at this bar's close (adverse).
      if (!open && bar.go && bar.side !== 'none') {
        const entryPx = bps(bar.close, cfg.slippageBps, bar.side === 'long' ? 1 : -1);
        open = { side: bar.side, entryPx, entryTime: bar.time, entryIdx: i, stop: bar.invalidation, target: bar.target, fundingHourly: bar.fundingHourly, entryRebateUsd: 0 };
      }
    } else {
      // MAKER: fill a resting entry only if price trades to it; else it ages out
      // (a MISSED entry — the adverse selection that skips runaway winners).
      if (pending && !open) {
        const touched = pending.side === 'long' ? bar.low <= pending.limit : bar.high >= pending.limit;
        if (touched) {
          open = { side: pending.side, entryPx: pending.limit, entryTime: bar.time, entryIdx: i, stop: pending.stop, target: pending.target, fundingHourly: pending.fundingHourly, entryRebateUsd: rebateUsd };
          pending = null;
        } else if (i - pending.postedIdx >= maxBarsToFill) {
          pending = null; // expired unfilled — missed
        }
      }
      // Post a fresh passive entry at the signal close when flat + nothing pending.
      if (!open && !pending && bar.go && bar.side !== 'none') {
        pending = { side: bar.side, limit: bar.close, stop: bar.invalidation, target: bar.target, fundingHourly: bar.fundingHourly, postedIdx: i, postedTime: bar.time };
      }
    }
  }

  // Close any residual position at the last bar's close.
  if (open && bars.length > 0) {
    const last = bars[bars.length - 1];
    closeTrade(last.close, last.time, bars.length - 1, 'end', 'taker');
  }

  // Aggregate + drawdown over the cumulative net curve.
  let wins = 0;
  let losses = 0;
  let netUsd = 0;
  let peak = 0;
  let maxDrawdownUsd = 0;
  let cum = 0;
  for (const t of trades) {
    netUsd += t.netPnlUsd;
    if (t.netPnlUsd > 0) wins++;
    else if (t.netPnlUsd < 0) losses++;
    cum += t.netPnlUsd;
    peak = Math.max(peak, cum);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - cum);
  }

  return { trades, wins, losses, netUsd, maxDrawdownUsd };
}
