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
  /** Regime/rubric confidence at this bar (0–1) — carried onto the trade for the
   *  calibration check (do higher-confidence entries actually perform better?). */
  confidence?: number;
  /** Levels for the chosen side (from deriveLevels). */
  invalidation: number; // stop
  target: number;
  /** ATR at this bar — used by the trailing-stop exit mode to ratchet the stop. */
  atr?: number;
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
  /**
   * REALISM: price must trade THROUGH the posted limit by ≥ this many bps to
   * clear the queue ahead of you and fill (0 = a mere touch fills — optimistic).
   */
  makerQueueClearBps?: number;
  /**
   * REALISM: adverse-selection penalty (bps) applied to a maker ENTRY fill — you
   * tend to fill because informed flow ran into you, so the position starts more
   * underwater ("filled-then-reversed"). Counters the rebate. 0 = none (optimistic).
   */
  makerAdverseSelBps?: number;
  /**
   * Exit policy. 'fixed' (default): exit at the precomputed ATR target (caps the
   * winner) or the fixed invalidation stop. 'trail': NO fixed target — the stop
   * starts at the invalidation and RATCHETS in the favorable direction by
   * `trailAtrMult × bar.atr` each bar, letting winners run until the trend breaks
   * (the trend-following exit). Requires bar.atr; falls back to fixed if absent.
   */
  exitMode?: 'fixed' | 'trail';
  /** Trailing-stop distance in ATRs (default = the entry stop multiplier, ~1.5). */
  trailAtrMult?: number;
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
  reason: 'target' | 'stop' | 'flip' | 'end' | 'trail';
  /** Regime/rubric confidence at the entry bar (0–1) — for the calibration check. */
  entryConfidence: number;
  /** ATR as a fraction of entry price at the entry bar — the entry-vol calibration
   *  metric (do low-vol/tight-stop entries perform better → size them up?). */
  entryAtrPct: number;
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

/** One confidence band's realized stats — the unit of the calibration check. */
export interface CalibrationBucket {
  /** Inclusive lower / exclusive upper confidence edge (last band's upper is inclusive). */
  loEdge: number;
  hiEdge: number;
  label: string;
  trades: number;
  wins: number;
  winRate: number; // wins / trades (0 when empty)
  totalNetUsd: number;
  avgNetUsd: number; // expectancy per trade (0 when empty)
}

export interface CalibrationReport {
  buckets: CalibrationBucket[];
  /** True if avg net per trade is non-decreasing across populated bands (calibrated). */
  monotonic: boolean;
  /** Spearman-style sign of the avg-net trend across populated bands: +1 up, −1 down, 0 flat/mixed. */
  trend: 1 | 0 | -1;
}

/**
 * PURE — bucket closed trades by a numeric ENTRY metric (via `selector`) and report
 * realized win-rate + expectancy per band. The calibration question: does the metric
 * predict trade outcome? If avg-net rises monotonically AND materially across bands,
 * the metric is calibrated and sizing by it is justified; if flat/mixed, it's a gate
 * only and sizing should stay fixed (avoid overfitting size to a non-signal).
 * `edges` are ascending band boundaries (the last band's upper edge is inclusive).
 */
export function bucketTrades(trades: BacktestTrade[], edges: number[], selector: (t: BacktestTrade) => number): CalibrationReport {
  const buckets: CalibrationBucket[] = [];
  for (let b = 0; b < edges.length - 1; b++) {
    const loEdge = edges[b];
    const hiEdge = edges[b + 1];
    const isLast = b === edges.length - 2;
    const inBand = trades.filter((t) => selector(t) >= loEdge && (isLast ? selector(t) <= hiEdge : selector(t) < hiEdge));
    const wins = inBand.filter((t) => t.netPnlUsd > 0).length;
    const totalNetUsd = inBand.reduce((s, t) => s + t.netPnlUsd, 0);
    buckets.push({
      loEdge,
      hiEdge,
      label: `${loEdge.toFixed(2)}–${hiEdge.toFixed(2)}`,
      trades: inBand.length,
      wins,
      winRate: inBand.length > 0 ? wins / inBand.length : 0,
      totalNetUsd,
      avgNetUsd: inBand.length > 0 ? totalNetUsd / inBand.length : 0,
    });
  }
  // Monotonicity / trend over POPULATED bands only (empty bands carry no signal).
  const populated = buckets.filter((x) => x.trades > 0);
  let monotonic = true;
  let ups = 0;
  let downs = 0;
  for (let i = 1; i < populated.length; i++) {
    if (populated[i].avgNetUsd < populated[i - 1].avgNetUsd - 1e-9) monotonic = false;
    if (populated[i].avgNetUsd > populated[i - 1].avgNetUsd + 1e-9) ups++;
    else if (populated[i].avgNetUsd < populated[i - 1].avgNetUsd - 1e-9) downs++;
  }
  const trend: 1 | 0 | -1 = ups > downs ? 1 : downs > ups ? -1 : 0;
  return { buckets, monotonic, trend };
}

/** Bucket by entry CONFIDENCE (the confidence-calibration check). */
export function bucketByConfidence(trades: BacktestTrade[], edges: number[]): CalibrationReport {
  return bucketTrades(trades, edges, (t) => t.entryConfidence);
}

/** Bucket by entry ATR% (the entry-VOL calibration check — do low-vol/tight-stop
 *  entries perform better, i.e. should risk-parity size them up?). */
export function bucketByEntryVol(trades: BacktestTrade[], edges: number[]): CalibrationReport {
  return bucketTrades(trades, edges, (t) => t.entryAtrPct);
}

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
  const queueClear = (cfg.makerQueueClearBps ?? 0) / 10_000; // price must trade this far through to fill
  const adverseSel = (cfg.makerAdverseSelBps ?? 0) / 10_000; // filled-then-reversed entry penalty
  const exitMode = cfg.exitMode ?? 'fixed';
  const trailAtrMult = cfg.trailAtrMult ?? 1.5;

  let open:
    | { side: Side; entryPx: number; entryTime: number; entryIdx: number; stop: number; target: number; fundingHourly: number; entryRebateUsd: number; entryConfidence: number; entryAtrPct: number }
    | null = null;
  // Maker-only: a posted passive entry awaiting fill (fills when price trades to it).
  let pending: { side: Side; limit: number; stop: number; target: number; fundingHourly: number; postedIdx: number; postedTime: number; entryConfidence: number; entryAtrPct: number } | null = null;

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
    trades.push({ side: open.side, entryTime: open.entryTime, exitTime, entryPx: open.entryPx, exitPx, barsHeld, grossPnlUsd, fundingUsd, netPnlUsd, reason, entryConfidence: open.entryConfidence, entryAtrPct: open.entryAtrPct });
    open = null;
  };

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // Manage an open position FIRST. STOP always crosses (taker — you can't post a
    // protective stop); TARGET is a resting limit (maker when in maker mode); a
    // signal FLIP crosses out (taker).
    if (open) {
      const targetLeg = model === 'maker' ? 'maker' : 'taker';
      const trailing = exitMode === 'trail' && (bar.atr ?? 0) > 0;
      if (open.side === 'long') {
        // Stop (incl. the ratcheted trailing stop) is checked FIRST against this
        // bar's low using the level set from PRIOR bars (no look-ahead).
        if (bar.low <= open.stop) closeTrade(open.stop, bar.time, i, trailing ? 'trail' : 'stop', 'taker');
        else if (!trailing && bar.high >= open.target) closeTrade(open.target, bar.time, i, 'target', targetLeg);
        // Then ratchet the stop UP for subsequent bars (never down). No fixed target in trail mode.
        else if (trailing) open.stop = Math.max(open.stop, bar.high - trailAtrMult * (bar.atr ?? 0));
      } else {
        if (bar.high >= open.stop) closeTrade(open.stop, bar.time, i, trailing ? 'trail' : 'stop', 'taker');
        else if (!trailing && bar.low <= open.target) closeTrade(open.target, bar.time, i, 'target', targetLeg);
        else if (trailing) open.stop = Math.min(open.stop, bar.low + trailAtrMult * (bar.atr ?? 0));
      }
      if (open && bar.go && bar.side !== 'none' && bar.side !== open.side) {
        closeTrade(bar.close, bar.time, i, 'flip', 'taker');
      }
    }

    if (model === 'taker') {
      // Cross immediately at this bar's close (adverse).
      if (!open && bar.go && bar.side !== 'none') {
        const entryPx = bps(bar.close, cfg.slippageBps, bar.side === 'long' ? 1 : -1);
        open = { side: bar.side, entryPx, entryTime: bar.time, entryIdx: i, stop: bar.invalidation, target: bar.target, fundingHourly: bar.fundingHourly, entryRebateUsd: 0, entryConfidence: bar.confidence ?? 0, entryAtrPct: entryPx > 0 ? (bar.atr ?? 0) / entryPx : 0 };
      }
    } else {
      // MAKER: fill a resting entry only if price trades to it; else it ages out
      // (a MISSED entry — the adverse selection that skips runaway winners).
      if (pending && !open) {
        // Fill only if price trades THROUGH the limit by the queue-clearance margin
        // (a touch alone leaves you behind the queue). On fill, the entry is nudged
        // adverse (filled-then-reversed) — countering the rebate.
        const fillThru = pending.side === 'long' ? pending.limit * (1 - queueClear) : pending.limit * (1 + queueClear);
        const filled = pending.side === 'long' ? bar.low <= fillThru : bar.high >= fillThru;
        if (filled) {
          const adverseSign = pending.side === 'long' ? 1 : -1;
          const entryPx = pending.limit * (1 + adverseSign * adverseSel);
          open = { side: pending.side, entryPx, entryTime: bar.time, entryIdx: i, stop: pending.stop, target: pending.target, fundingHourly: pending.fundingHourly, entryRebateUsd: rebateUsd, entryConfidence: pending.entryConfidence, entryAtrPct: entryPx > 0 ? (bar.atr ?? 0) / entryPx : 0 };
          pending = null;
        } else if (i - pending.postedIdx >= maxBarsToFill) {
          pending = null; // expired unfilled — missed
        }
      }
      // Post a fresh passive entry at the signal close when flat + nothing pending.
      if (!open && !pending && bar.go && bar.side !== 'none') {
        pending = { side: bar.side, limit: bar.close, stop: bar.invalidation, target: bar.target, fundingHourly: bar.fundingHourly, postedIdx: i, postedTime: bar.time, entryConfidence: bar.confidence ?? 0, entryAtrPct: bar.close > 0 ? (bar.atr ?? 0) / bar.close : 0 };
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
