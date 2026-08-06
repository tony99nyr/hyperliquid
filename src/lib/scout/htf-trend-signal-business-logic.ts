/**
 * HTF-trend signal — PURE. The daily Donchian-channel breakout lane, pre-registered
 * 2026-08-01 (docs/scout/PREREGISTRATION_htf-trend.md) as the honest response to the
 * confirmed "no mechanical edge at the 15m-entry / 4h-regime timescale" finding: fade
 * AND follow both lost there, so the next test is a DIFFERENT timescale (daily) with a
 * DIFFERENT mechanism (price breakout, not a regime-detector read) — the turtle /
 * managed-futures trend edge, the most-documented real trend anomaly.
 *
 * NOT a proven edge — this module exists to let the scout PROVE OR KILL it honestly on
 * post-registration paper data, never to assert it. Trend-following is DESIGNED low-win,
 * fat-right-tail; the edge is the tails, judged on R, never win rate.
 *
 * The frozen rule (evaluated on COMPLETED DAILY bars only):
 *  - ENTRY: the daily close prints beyond the prior N-day (entryChannel=20) close
 *    channel — above the 20-day high = LONG, below the 20-day low = SHORT. Enter WITH
 *    the breakout.
 *  - STOP (hard invalidation): min(atrStopMult × ATR(atrPeriod) / entry, maxStopFrac) —
 *    2× the 20-day ATR, capped at 12%. Daily trends need room; the cap bounds the loss.
 *  - EXIT (mechanical, NO fixed target): the daily close through the OPPOSITE shorter
 *    channel (exitChannel=10) — a long exits below the 10-day low, a short above the
 *    10-day high (the turtle trailing exit). Let the trend run; the tails ARE the edge.
 *
 * All channels are computed from the PRIOR bars (excluding the current close), so the
 * current close genuinely "breaks through" — never part of its own channel.
 */

export interface HtfBar {
  highPx: number;
  lowPx: number;
  closePx: number;
}

export interface HtfTrendConfig {
  entryChannel: number; // Donchian breakout lookback in daily bars (e.g. 20)
  exitChannel: number; // opposite-channel exit lookback (e.g. 10)
  atrPeriod: number; // ATR lookback for the stop (e.g. 20)
  atrStopMult: number; // stop = this × ATR from entry (e.g. 2)
  maxStopFrac: number; // hard cap on the stop distance (e.g. 0.12)
}

export const DEFAULT_HTF_TREND_CONFIG: HtfTrendConfig = {
  entryChannel: 20,
  exitChannel: 10,
  atrPeriod: 20,
  atrStopMult: 2,
  maxStopFrac: 0.12,
};

export interface HtfTrendBreakout {
  side: 'long' | 'short'; // WITH the breakout (long = up-breakout)
  entryPx: number; // the completed daily close that broke out
  stopPx: number; // hard invalidation (ATR-based, capped)
  stopFrac: number; // |entry−stop|/entry — for risk-based sizing
  /** The opposite 10-day channel level a future daily close must break to EXIT
   *  (long → the 10-day low; short → the 10-day high). NO fixed target by design. */
  exitPx: number;
}

/** One coin's completed-daily read: the channel context (always) + a breakout (when the
 *  latest completed close broke the 20-day channel). `null` breakout = no entry this bar,
 *  but the channels still let an OPEN position's 10-day-close-through exit be checked. */
export interface HtfTrendRead {
  latestClose: number;
  don20High: number;
  don20Low: number;
  don10High: number;
  don10Low: number;
  atr: number;
  breakout: HtfTrendBreakout | null;
}

/** Simple ATR over the last `period` bars (needs period+1 bars for the prior close).
 *  Mean of true ranges — TR = max(H−L, |H−prevClose|, |L−prevClose|). 0 if too thin. */
function atr(bars: HtfBar[], period: number): number {
  const n = bars.length;
  if (n < period + 1) return 0;
  let sum = 0;
  for (let i = n - period; i < n; i++) {
    const h = bars[i].highPx;
    const l = bars[i].lowPx;
    const pc = bars[i - 1].closePx;
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return sum / period;
}

/**
 * Evaluate the HTF-trend read on a completed-daily series (last element = most recent
 * COMPLETED daily bar; the caller drops the in-progress bar). Returns null only when the
 * series is too thin to form every window — a fresh listing never fires.
 */
export function htfTrendRead(
  bars: HtfBar[],
  cfg: HtfTrendConfig = DEFAULT_HTF_TREND_CONFIG,
): HtfTrendRead | null {
  // Every channel excludes the current bar, and ATR needs one extra prior close — so
  // bound on the largest window + the current bar. Below this, slices would clamp and
  // silently compute over a truncated channel (a false breakout); return null instead.
  const need = Math.max(cfg.entryChannel, cfg.exitChannel, cfg.atrPeriod + 1) + 1;
  if (bars.length < need) return null;

  const n = bars.length;
  const closes = bars.map((b) => b.closePx);
  const latestClose = closes[n - 1];

  // Channels from the PRIOR bars only (exclude the current close so it can break through).
  const priorEntry = closes.slice(n - 1 - cfg.entryChannel, n - 1);
  const don20High = Math.max(...priorEntry);
  const don20Low = Math.min(...priorEntry);
  const priorExit = closes.slice(n - 1 - cfg.exitChannel, n - 1);
  const don10High = Math.max(...priorExit);
  const don10Low = Math.min(...priorExit);
  const atr20 = atr(bars, cfg.atrPeriod);

  let breakout: HtfTrendBreakout | null = null;
  const side: 'long' | 'short' | null =
    latestClose > don20High ? 'long' : latestClose < don20Low ? 'short' : null;
  if (side && atr20 > 0) {
    const entryPx = latestClose;
    const stopFrac = Math.min((cfg.atrStopMult * atr20) / entryPx, cfg.maxStopFrac);
    const stopPx = side === 'long' ? entryPx * (1 - stopFrac) : entryPx * (1 + stopFrac);
    const exitPx = side === 'long' ? don10Low : don10High;
    breakout = { side, entryPx, stopPx, stopFrac, exitPx };
  }

  return { latestClose, don20High, don20Low, don10High, don10Low, atr: atr20, breakout };
}

/**
 * Has an OPEN htf-trend position hit its mechanical exit? True when the latest completed
 * daily close broke the OPPOSITE 10-day channel — a long exits below the 10-day low, a
 * short above the 10-day high (the turtle trailing exit). The hard stop is a separate,
 * price-level invalidation the caller enforces; this is the trend-gone signal.
 */
export function htfTrendExitHit(read: HtfTrendRead, side: 'long' | 'short'): boolean {
  return side === 'long' ? read.latestClose < read.don10Low : read.latestClose > read.don10High;
}
