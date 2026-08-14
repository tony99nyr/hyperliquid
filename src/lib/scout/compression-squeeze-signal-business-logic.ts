/**
 * Compression-squeeze breakout signal — PURE. The `compression-straddle` lane,
 * pre-registered 2026-08-13 (docs/scout/PREREGISTRATION_compression-straddle.md):
 * volatility mean-reverts, so a breakout that resolves a genuine Bollinger-Band-Width
 * squeeze has positive expectancy and positive skew (tight stop inside the compressed
 * range; no fixed target — let the expansion run). The compression PRECONDITION is the
 * whole point: unconditional 4h breakouts were tested and KILLED (trend-follow,
 * −0.10R over n=46); the claim under test is that conditioning on a squeeze changes
 * the sign. NOT a proven edge — this module exists to prove or KILL it honestly.
 *
 * The frozen rule (evaluated on COMPLETED 4h candles only):
 *  - SQUEEZE: BBW = (upper − lower) / mid of the 20-period ±2σ Bollinger Bands is at
 *    or below the 20th percentile of its own trailing 100 values.
 *  - BREAKOUT: in a squeeze (or ≤ 3 bars after one ended), the close prints beyond
 *    the prior 20-bar extreme (above the high = LONG, below the low = SHORT).
 *  - STOP: the opposite edge of the pre-breakout range — realized as the prior 20-bar
 *    low (LONG) / high (SHORT), which IS the squeeze range while compressed — capped 4%.
 *  - EXIT (no fixed target): the 4h close back through the BB middle band (the 20-SMA
 *    basis) — the expansion is over once price re-enters the mean. Or the hard stop.
 *  - ONE ENTRY PER SQUEEZE EPISODE (whipsaw guard): a stopped-out break is NOT
 *    re-entered the other way; wait for a NEW squeeze (the caller enforces via the
 *    open-position check + episode judgment; surfaced in the cycle directive).
 *
 * All windows are computed from PRIOR bars where breaking through is the event, so
 * the breaking close is never part of its own channel.
 */

export interface SqueezeBar {
  highPx: number;
  lowPx: number;
  closePx: number;
}

export interface CompressionConfig {
  bbPeriod: number; // Bollinger period on 4h closes (e.g. 20)
  bbStdMult: number; // band width in stdevs (e.g. 2)
  bbwLookback: number; // trailing BBW values for the percentile (e.g. 100)
  squeezePctile: number; // BBW at/below this percentile = squeeze (e.g. 0.20)
  breakoutChannel: number; // prior-bar extreme channel for the break (e.g. 20)
  postSqueezeGraceBars: number; // a break within this many bars after a squeeze still counts (e.g. 3)
  maxStopFrac: number; // hard cap on the stop distance (e.g. 0.04)
}

export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  bbPeriod: 20,
  bbStdMult: 2,
  bbwLookback: 100,
  squeezePctile: 0.2,
  breakoutChannel: 20,
  postSqueezeGraceBars: 3,
  maxStopFrac: 0.04,
};

export interface CompressionBreakout {
  side: 'long' | 'short'; // WITH the break
  entryPx: number; // the completed 4h close that broke out
  stopPx: number; // opposite edge of the compressed range (capped)
  stopFrac: number; // |entry−stop|/entry
  /** The BB middle band (20-SMA) — a future 4h close back through this = the
   *  mechanical exit (long exits below it, short above it). NO fixed target. */
  exitBasisPx: number;
}

/** One coin's completed-4h read: squeeze state + channels (always) and a breakout
 *  when the latest completed close resolved a squeeze through the 20-bar extreme. */
export interface CompressionRead {
  latestClose: number;
  bbMid: number;
  bbw: number;
  /** Fraction of the trailing lookback BBW values at/below the current BBW (0..1). */
  bbwPctile: number;
  inSqueeze: boolean;
  /** 0 = the latest bar is squeezed; N = bars since the last squeezed bar; null = no
   *  squeeze within the grace window (breakouts don't qualify). */
  barsSinceSqueeze: number | null;
  don20High: number; // prior-20-bar highest high (excludes the current bar)
  don20Low: number; // prior-20-bar lowest low
  breakout: CompressionBreakout | null;
}

function sma(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = sma(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
}

/** BBW of the `bbPeriod` closes ENDING at index `endIdx` (inclusive). */
function bbwAt(closes: number[], endIdx: number, cfg: CompressionConfig): number | null {
  if (endIdx + 1 < cfg.bbPeriod) return null;
  const win = closes.slice(endIdx + 1 - cfg.bbPeriod, endIdx + 1);
  const mid = sma(win);
  if (!(mid > 0)) return null;
  const sd = stdev(win);
  return (2 * cfg.bbStdMult * sd) / mid;
}

/**
 * Evaluate the compression read on a completed-4h series (last element = most recent
 * COMPLETED bar; caller drops the in-progress bar). Returns null when the series is too
 * thin to form the BBW percentile history — a fresh listing never fires.
 */
export function compressionRead(
  bars: SqueezeBar[],
  cfg: CompressionConfig = DEFAULT_COMPRESSION_CONFIG,
): CompressionRead | null {
  // Need: bbPeriod to seed the first BBW + bbwLookback trailing values + the current bar,
  // and the breakout channel + current. Below this, percentiles/channels would silently
  // truncate (a fake squeeze on a short history); return null instead.
  const need = Math.max(cfg.bbPeriod + cfg.bbwLookback, cfg.breakoutChannel + 1);
  if (bars.length < need) return null;

  const n = bars.length;
  const closes = bars.map((b) => b.closePx);
  const latestClose = closes[n - 1];

  // Current BB + BBW, and the trailing BBW history for the percentile.
  const curWin = closes.slice(n - cfg.bbPeriod);
  const bbMid = sma(curWin);
  const bbw = bbwAt(closes, n - 1, cfg);
  if (bbw == null || !(bbMid > 0)) return null;
  const history: number[] = [];
  for (let i = n - 1 - cfg.bbwLookback; i < n - 1; i++) {
    const v = bbwAt(closes, i, cfg);
    if (v != null) history.push(v);
  }
  if (history.length < Math.floor(cfg.bbwLookback / 2)) return null; // too thin to trust the percentile
  const bbwPctile = history.filter((v) => v <= bbw).length / history.length;
  const inSqueeze = bbwPctile <= cfg.squeezePctile;

  // Bars since the last squeezed bar (for the post-squeeze grace window). The break bar
  // itself often EXPANDS BBW out of the squeeze — grace keeps the resolving break valid.
  let barsSinceSqueeze: number | null = inSqueeze ? 0 : null;
  if (!inSqueeze) {
    for (let back = 1; back <= cfg.postSqueezeGraceBars; back++) {
      const idx = n - 1 - back;
      const v = bbwAt(closes, idx, cfg);
      if (v == null) break;
      const hist = history.slice(0, history.length - back + 1);
      if (hist.length === 0) break;
      const p = hist.filter((x) => x <= v).length / hist.length;
      if (p <= cfg.squeezePctile) {
        barsSinceSqueeze = back;
        break;
      }
    }
  }

  // Prior-20-bar extremes (exclude the current bar so its close can break through).
  const prior = bars.slice(n - 1 - cfg.breakoutChannel, n - 1);
  const don20High = Math.max(...prior.map((b) => b.highPx));
  const don20Low = Math.min(...prior.map((b) => b.lowPx));

  let breakout: CompressionBreakout | null = null;
  const qualifies = barsSinceSqueeze != null && barsSinceSqueeze <= cfg.postSqueezeGraceBars;
  const side: 'long' | 'short' | null =
    latestClose > don20High ? 'long' : latestClose < don20Low ? 'short' : null;
  if (qualifies && side) {
    const entryPx = latestClose;
    // Stop = the opposite edge of the compressed range, capped. Naturally tight — the
    // positive-skew half of the bet (small loss on a false break).
    const rawStop = side === 'long' ? don20Low : don20High;
    const rawFrac = Math.abs(entryPx - rawStop) / entryPx;
    const stopFrac = Math.min(rawFrac, cfg.maxStopFrac);
    const stopPx = side === 'long' ? entryPx * (1 - stopFrac) : entryPx * (1 + stopFrac);
    breakout = { side, entryPx, stopPx, stopFrac, exitBasisPx: bbMid };
  }

  return { latestClose, bbMid, bbw, bbwPctile, inSqueeze, barsSinceSqueeze, don20High, don20Low, breakout };
}

/**
 * Has an OPEN compression-straddle position hit its mechanical exit? True when the
 * latest completed 4h close crossed back through the BB middle band — the expansion
 * is over once price re-enters the mean. The hard stop is separate (caller-enforced).
 */
export function compressionExitHit(read: CompressionRead, side: 'long' | 'short'): boolean {
  return side === 'long' ? read.latestClose < read.bbMid : read.latestClose > read.bbMid;
}
