/**
 * Compression-gated breakout OCO — PURE backtest logic.
 *
 * Hypothesis under test (operator Q, Jul-20): "we keep being flat on the big
 * directional day — could an OCO breakout trap catch it repeatably?" The naive
 * version (arm every range) is ~55% follow-through = fakeout tax. This tests the
 * NARROWER claim: does gating the OCO on RANGE COMPRESSION (a coil about to
 * release) beat the tax, vs firing on every breakout?
 *
 * Method, per bar t (all on COMPLETED bars — no lookahead):
 *  - Range over the trailing `lookback` bars BEFORE t: [rangeLo, rangeHi].
 *  - Compression = width(t) / median trailing width. < gate ⇒ coiled.
 *  - A CONFIRMED breakout = close[t] > rangeHi (long) or < rangeLo (short).
 *  - Entry = close[t] + slippage (a breakout fills WORSE than the level).
 *  - Stop = the broken boundary (rangeHi for a long): the tight, honest breakout
 *    invalidation (close back inside the range = failed break). Risk = |entry−stop|.
 *  - Exit: first of (a) stop touched intrabar, (b) target at `rMultTarget`×risk,
 *    (c) time exit after `holdBars`. Fees charged both legs.
 *  - One position at a time per coin; re-arm after flat.
 *
 * Reports the SAME trade set split by compressed-vs-not so the gate's marginal
 * value is the comparison, not an absolute the reader must trust blindly.
 */

export interface Bar {
  openPx: number;
  highPx: number;
  lowPx: number;
  closePx: number;
}

export interface CompressionConfig {
  lookback: number; // bars defining the range (e.g. 96 = 24h on 15m)
  compressionGate: number; // width/medianWidth below this ⇒ coiled (e.g. 0.7)
  slippageFrac: number; // added to entry, subtracted at exit (e.g. 0.0005)
  feeFrac: number; // per leg (HL taker ≈ 0.00045)
  rMultTarget: number; // take-profit at this × initial risk (e.g. 2)
  holdBars: number; // time exit if neither stop nor target hit
  minRiskFrac: number; // ignore breakouts whose stop is < this of price (noise)
}

export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  lookback: 96,
  compressionGate: 0.7,
  slippageFrac: 0.0005,
  feeFrac: 0.00045,
  rMultTarget: 2,
  holdBars: 48,
  minRiskFrac: 0.002,
};

export interface BreakoutTrade {
  side: 'long' | 'short';
  compressed: boolean;
  compressionRatio: number;
  entryPx: number;
  exitPx: number;
  riskFrac: number; // |entry−stop|/entry
  rMultiple: number; // net-of-fee P&L in units of initial risk
  exitReason: 'stop' | 'target' | 'time';
  barIndex: number;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Run the strategy over one coin's bar series. PURE. */
export function runCompressionBreakout(bars: Bar[], cfg: CompressionConfig = DEFAULT_COMPRESSION_CONFIG): BreakoutTrade[] {
  const trades: BreakoutTrade[] = [];
  const widthOf = (lo: number, hi: number) => hi - lo;
  // Precompute trailing width series for the compression ratio's denominator.
  let cursor = cfg.lookback * 2; // need lookback for range + lookback for median-of-widths
  while (cursor < bars.length - 1) {
    const rangeSlice = bars.slice(cursor - cfg.lookback, cursor);
    const rangeHi = Math.max(...rangeSlice.map((b) => b.highPx));
    const rangeLo = Math.min(...rangeSlice.map((b) => b.lowPx));
    const width = widthOf(rangeLo, rangeHi);

    // Denominator: median width of the `lookback` rolling windows before now.
    const priorWidths: number[] = [];
    for (let k = cursor - cfg.lookback; k < cursor; k++) {
      const w = bars.slice(k - cfg.lookback, k);
      if (w.length === cfg.lookback) priorWidths.push(widthOf(Math.min(...w.map((b) => b.lowPx)), Math.max(...w.map((b) => b.highPx))));
    }
    const medWidth = median(priorWidths);
    const compressionRatio = medWidth > 0 ? width / medWidth : Infinity;
    const compressed = compressionRatio <= cfg.compressionGate;

    const bar = bars[cursor];
    const brokeUp = bar.closePx > rangeHi;
    const brokeDn = bar.closePx < rangeLo;
    if (!brokeUp && !brokeDn) {
      cursor++;
      continue;
    }
    const side: 'long' | 'short' = brokeUp ? 'long' : 'short';
    const brokenBoundary = brokeUp ? rangeHi : rangeLo;
    const entryPx = brokeUp ? bar.closePx * (1 + cfg.slippageFrac) : bar.closePx * (1 - cfg.slippageFrac);
    const stopPx = brokenBoundary;
    const riskFrac = Math.abs(entryPx - stopPx) / entryPx;
    if (riskFrac < cfg.minRiskFrac) {
      cursor++;
      continue;
    }
    const risk = Math.abs(entryPx - stopPx);
    const targetPx = brokeUp ? entryPx + cfg.rMultTarget * risk : entryPx - cfg.rMultTarget * risk;

    // Walk forward for the exit.
    let exitPx = entryPx;
    let exitReason: BreakoutTrade['exitReason'] = 'time';
    let exitIdx = cursor;
    for (let f = cursor + 1; f <= Math.min(cursor + cfg.holdBars, bars.length - 1); f++) {
      const fb = bars[f];
      const stopHit = brokeUp ? fb.lowPx <= stopPx : fb.highPx >= stopPx;
      const targetHit = brokeUp ? fb.highPx >= targetPx : fb.lowPx <= targetPx;
      exitIdx = f;
      if (stopHit && targetHit) {
        // Ambiguous same-bar: assume the STOP first (conservative).
        exitPx = stopPx;
        exitReason = 'stop';
        break;
      }
      if (stopHit) {
        exitPx = stopPx;
        exitReason = 'stop';
        break;
      }
      if (targetHit) {
        exitPx = targetPx;
        exitReason = 'target';
        break;
      }
      if (f === cursor + cfg.holdBars) {
        exitPx = fb.closePx;
        exitReason = 'time';
      }
    }

    // Net P&L in R units, fees both legs (on notional ≈ entry).
    const dir = brokeUp ? 1 : -1;
    const grossPerUnit = dir * (exitPx - entryPx);
    const feePerUnit = cfg.feeFrac * (entryPx + exitPx);
    const netPerUnit = grossPerUnit - feePerUnit;
    const rMultiple = netPerUnit / risk;

    trades.push({ side, compressed, compressionRatio, entryPx, exitPx, riskFrac, rMultiple, exitReason, barIndex: cursor });
    cursor = exitIdx + 1; // one position at a time; re-arm after flat
  }
  return trades;
}

export interface BreakoutStats {
  n: number;
  winRate: number;
  expectancyR: number; // mean R
  totalR: number;
  avgWinR: number;
  avgLossR: number;
  stopRate: number;
  targetRate: number;
}

export function summarize(trades: BreakoutTrade[]): BreakoutStats {
  const n = trades.length;
  if (n === 0) return { n: 0, winRate: 0, expectancyR: 0, totalR: 0, avgWinR: 0, avgLossR: 0, stopRate: 0, targetRate: 0 };
  const wins = trades.filter((t) => t.rMultiple > 0);
  const losses = trades.filter((t) => t.rMultiple <= 0);
  const totalR = trades.reduce((s, t) => s + t.rMultiple, 0);
  return {
    n,
    winRate: wins.length / n,
    expectancyR: totalR / n,
    totalR,
    avgWinR: wins.length ? wins.reduce((s, t) => s + t.rMultiple, 0) / wins.length : 0,
    avgLossR: losses.length ? losses.reduce((s, t) => s + t.rMultiple, 0) / losses.length : 0,
    stopRate: trades.filter((t) => t.exitReason === 'stop').length / n,
    targetRate: trades.filter((t) => t.exitReason === 'target').length / n,
  };
}
