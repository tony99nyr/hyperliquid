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
  /** Adverse slippage (bps) applied to BOTH entry and exit fills. */
  slippageBps: number;
  /** Hours represented by one bar (for funding accrual). */
  barHours: number;
  /** Notional per trade (USD) — fixed sizing for comparability. */
  notionalUsd: number;
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
  let open: { side: Side; entryPx: number; entryTime: number; entryIdx: number; stop: number; target: number; fundingHourly: number } | null = null;

  const closeTrade = (exitPxRaw: number, exitTime: number, exitIdx: number, reason: BacktestTrade['reason']) => {
    if (!open) return;
    // Exit fill is adverse: a long sells (lower), a short buys (higher).
    const exitPx = bps(exitPxRaw, cfg.slippageBps, open.side === 'long' ? -1 : 1);
    const dir = open.side === 'long' ? 1 : -1;
    const qty = cfg.notionalUsd / open.entryPx;
    const grossPnlUsd = dir * (exitPx - open.entryPx) * qty;
    const barsHeld = Math.max(1, exitIdx - open.entryIdx);
    const holdingHours = barsHeld * cfg.barHours;
    // Funding: longs pay positive rate, shorts earn it. cost>0 = paid.
    const fundingUsd = dir * open.fundingHourly * cfg.notionalUsd * holdingHours;
    const netPnlUsd = grossPnlUsd - fundingUsd;
    trades.push({
      side: open.side,
      entryTime: open.entryTime,
      exitTime,
      entryPx: open.entryPx,
      exitPx,
      barsHeld,
      grossPnlUsd,
      fundingUsd,
      netPnlUsd,
      reason,
    });
    open = null;
  };

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // Manage an open position FIRST (stop/target on this bar's range, then flip).
    if (open) {
      if (open.side === 'long') {
        if (bar.low <= open.stop) closeTrade(open.stop, bar.time, i, 'stop');
        else if (bar.high >= open.target) closeTrade(open.target, bar.time, i, 'target');
      } else {
        if (bar.high >= open.stop) closeTrade(open.stop, bar.time, i, 'stop');
        else if (bar.low <= open.target) closeTrade(open.target, bar.time, i, 'target');
      }
      // Signal flip: a GO on the OPPOSITE side closes at this bar's close.
      if (open && bar.go && bar.side !== 'none' && bar.side !== open.side) {
        closeTrade(bar.close, bar.time, i, 'flip');
      }
    }

    // Enter on a fresh GO when flat. Entry fill is adverse (buy higher / sell lower).
    if (!open && bar.go && bar.side !== 'none') {
      const entryPx = bps(bar.close, cfg.slippageBps, bar.side === 'long' ? 1 : -1);
      open = {
        side: bar.side,
        entryPx,
        entryTime: bar.time,
        entryIdx: i,
        stop: bar.invalidation,
        target: bar.target,
        fundingHourly: bar.fundingHourly,
      };
    }
  }

  // Close any residual position at the last bar's close.
  if (open && bars.length > 0) {
    const last = bars[bars.length - 1];
    closeTrade(last.close, last.time, bars.length - 1, 'end');
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
