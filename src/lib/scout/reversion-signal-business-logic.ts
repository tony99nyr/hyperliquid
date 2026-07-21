/**
 * Extreme-reversion signal — PURE. The one candidate edge that survived a day of
 * honest backtesting (Jul-20): in a RANGE regime, fading a STATISTICALLY EXTREME
 * price stretch has positive expectancy; momentum/breakout does not. Handed to
 * the scout as a pre-registered PAPER lane so its forward track record is the
 * out-of-sample validation (post-discovery data — immune to the look-ahead bias
 * that plagues in-sample LLM backtests). See docs/scout/PREREGISTRATION_reversion-extreme.md.
 *
 * NOT yet a proven edge: the best in-sample t was ~2.4, which does NOT clear the
 * multiple-testing bar after a day of trials. This module exists to LET THE SCOUT
 * PROVE OR KILL IT honestly, not to assert it.
 *
 * Two gates, both required:
 *  - STRETCH: |z-score of the K-bar move| ≥ minZ, where z = move / (σ·√K) and σ is
 *    the trailing 1-bar return stdev. An extreme statistical outlier, not a normal wiggle.
 *  - RANGE regime: Kaufman efficiency ratio (|net move| / path length) ≤ maxEfficiency.
 *    Low ER = choppy/mean-reverting; high ER = trending (where fading LOSES). This
 *    is the regime filter the backtest's regime-dependence demands.
 * Fires a FADE: side opposite the stretch, stop beyond the extreme, target a
 * partial reversion. Risk-defined; never chases.
 */

export interface RevBar {
  highPx: number;
  lowPx: number;
  closePx: number;
}

export interface ReversionConfig {
  volLookback: number; // bars for the 1-bar-return stdev baseline (e.g. 96)
  moveBars: number; // K: the move whose z-score we test (e.g. 16 = 4h @15m)
  minZ: number; // stretch threshold (e.g. 2.0)
  regimeBars: number; // bars for the efficiency-ratio regime read (>> moveBars, e.g. 96)
  maxEfficiency: number; // ER at/below this = range regime (e.g. 0.35)
  maxTrendConfidence: number; // higher-TF regime gate: reject a directional trend at/above this confidence (e.g. 0.55)
  stopBufferFrac: number; // stop sits this far beyond the K-bar extreme (e.g. 0.004)
  reversionTargetFrac: number; // target = this fraction of the stretch retraced (e.g. 0.5)
}

export const DEFAULT_REVERSION_CONFIG: ReversionConfig = {
  volLookback: 96,
  moveBars: 16,
  minZ: 2.5,
  regimeBars: 96,
  maxEfficiency: 0.35,
  maxTrendConfidence: 0.55,
  stopBufferFrac: 0.004,
  reversionTargetFrac: 0.5,
};

/**
 * The higher-TF background regime gate (Phase 1, Jul-21). Structurally satisfied
 * by the vendored `MarketRegimeSignal` (iamrossi's detector) — typed locally so
 * this pure scout module never imports the strategy subsystem. Fading a CONFIDENT
 * directional trend loses (today's backtest); this is the authoritative regime
 * filter, complementing the local efficiency-ratio range check.
 */
export interface RegimeGate {
  regime: 'bullish' | 'bearish' | 'neutral';
  confidence: number; // 0–1
}

export interface ReversionSignal {
  side: 'long' | 'short'; // the FADE direction (long = fade a down-stretch)
  zScore: number; // signed z of the K-bar move (negative for a down-stretch)
  efficiency: number; // the LOCAL 15m efficiency ratio (lower = more range-like)
  regimeLabel: 'bullish' | 'bearish' | 'neutral' | 'unknown'; // higher-TF background regime
  regimeConfidence: number; // 0–1 (0 when no regime was supplied)
  markPx: number;
  stopPx: number;
  targetPx: number;
  stopFrac: number; // |mark−stop|/mark — for risk-based sizing
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
}

/**
 * Evaluate the reversion signal on a completed-bar series (last element = most
 * recent COMPLETED bar; caller drops the in-progress bar). Returns null when
 * either gate fails or data is insufficient — a thin/quiet tape never fires.
 */
export function reversionSignal(
  bars: RevBar[],
  cfg: ReversionConfig = DEFAULT_REVERSION_CONFIG,
  /** Higher-TF background regime (the vendored detector, Phase 1). When supplied,
   *  a CONFIDENT directional trend rejects the fade — the authoritative regime gate
   *  complementing the local efficiency ratio. Omit to fall back to efficiency-only. */
  regime?: RegimeGate,
): ReversionSignal | null {
  // Bound EVERY window that indexes back (regimeBars can exceed volLookback+moveBars),
  // else a slice would clamp to 0 and silently compute over a truncated window.
  const need = Math.max(cfg.volLookback + cfg.moveBars, cfg.regimeBars) + 1;
  if (bars.length < need) return null;
  // Higher-TF regime gate FIRST (cheap, authoritative): never fade a confident
  // trend, whatever the local structure looks like.
  if (regime && regime.regime !== 'neutral' && regime.confidence >= cfg.maxTrendConfidence) return null;
  const closes = bars.map((b) => b.closePx);
  const n = closes.length;

  // Trailing 1-bar log returns for σ (exclude the move window so vol isn't
  // inflated by the very stretch we're measuring).
  const volSlice = closes.slice(n - cfg.moveBars - cfg.volLookback - 1, n - cfg.moveBars);
  const rets: number[] = [];
  for (let i = 1; i < volSlice.length; i++) rets.push(Math.log(volSlice[i] / volSlice[i - 1]));
  const sigma = stdev(rets);
  if (!(sigma > 0)) return null;

  const mark = closes[n - 1];
  const moveStart = closes[n - 1 - cfg.moveBars];
  const move = Math.log(mark / moveStart);
  const zScore = move / (sigma * Math.sqrt(cfg.moveBars));
  if (Math.abs(zScore) < cfg.minZ) return null;

  // Kaufman efficiency ratio over the regime window: |net| / Σ|per-bar|.
  const regSlice = closes.slice(n - cfg.regimeBars - 1);
  const net = Math.abs(regSlice[regSlice.length - 1] - regSlice[0]);
  let path = 0;
  for (let i = 1; i < regSlice.length; i++) path += Math.abs(regSlice[i] - regSlice[i - 1]);
  const efficiency = path > 0 ? net / path : 1;
  if (efficiency > cfg.maxEfficiency) return null; // trending → fading loses; skip

  // FADE: opposite the stretch. Stop beyond the move's extreme; target a partial retrace.
  const side: 'long' | 'short' = zScore > 0 ? 'short' : 'long';
  const windowSlice = bars.slice(n - cfg.moveBars - 1);
  const extremeHi = Math.max(...windowSlice.map((b) => b.highPx));
  const extremeLo = Math.min(...windowSlice.map((b) => b.lowPx));
  const stopPx = side === 'short' ? extremeHi * (1 + cfg.stopBufferFrac) : extremeLo * (1 - cfg.stopBufferFrac);
  // Target retraces reversionTargetFrac of the move back toward moveStart.
  const targetPx = side === 'short' ? mark - cfg.reversionTargetFrac * (mark - moveStart) : mark + cfg.reversionTargetFrac * (moveStart - mark);
  const stopFrac = Math.abs(mark - stopPx) / mark;

  return {
    side,
    zScore,
    efficiency,
    regimeLabel: regime?.regime ?? 'unknown',
    regimeConfidence: regime?.confidence ?? 0,
    markPx: mark,
    stopPx,
    targetPx,
    stopFrac,
  };
}
