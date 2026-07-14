/**
 * Momentum-stall composite — PURE. "Is the move that's paying this position
 * running out of participants?" measured three deterministic ways:
 *
 *   1. VOLUME FADE (candles): with-trend 15m volume dries up relative to
 *      counter-trend volume over the recent window.
 *   2. CVD NON-CONFIRMATION (recorded tape): price prints a fresh extreme but
 *      the taker-flow series (market_snapshots) is falling or against the
 *      position — buyers/sellers are not driving the new price.
 *   3. BOOK AGAINST (recorded depth): the book-imbalance series has leaned
 *      against the position across the last few snapshots (persistence, not a
 *      single flashing wall).
 *
 * STALLED = at least 2 of 3 flip. ADVISORY ONLY — the consumer pages the
 * operator; nothing here (or downstream of here) auto-closes anything. Missing
 * data makes a signal FALSE (never a stall vote): a thin series must not page.
 * Exit policy is not a proven edge (see BACKTEST_FINDINGS §exit) — this exists
 * to inform the human, and to accumulate the series a future backtest judges.
 */

export type PositionSide = 'long' | 'short';

/** One COMPLETED 15m candle (ascending order; the in-progress bar must be excluded). */
export interface MomentumCandle {
  openPx: number;
  closePx: number;
  highPx: number;
  lowPx: number;
  volume: number;
}

/** One market_snapshots point (ascending). null = not measured, NEVER 0. */
export interface MomentumSeriesPoint {
  takerFlow: number | null;
  bookImbalance: number | null;
}

export interface MomentumStallInput {
  side: PositionSide;
  /** Completed 15m candles, ascending. Need ≥ CANDLES_REQUIRED or signal 1+2 stay false. */
  candles: MomentumCandle[];
  /** Recent snapshot series, ascending (~last 90 min at the ~5 min cadence). */
  series: MomentumSeriesPoint[];
}

export interface MomentumStallVerdict {
  stalled: boolean;
  /** Which signals flipped (for the operator message + telemetry). */
  flipped: string[];
  detail: string;
}

/** Bars in the volume-fade / extreme-check window. */
export const CANDLES_REQUIRED = 12;
const VOLUME_WINDOW = 8;
const EXTREME_RECENT_BARS = 3;
/** Book imbalance leaning this far against the position counts (sign is side-relative). */
export const BOOK_AGAINST_THRESHOLD = 0.15;
/** Non-null series points required for the tape/book signals. */
const SERIES_MIN_POINTS = 3;

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Signal 1 — with-trend volume fading vs counter-trend volume (last VOLUME_WINDOW bars). */
export function volumeFade(side: PositionSide, candles: MomentumCandle[]): boolean {
  if (candles.length < CANDLES_REQUIRED) return false;
  const win = candles.slice(-VOLUME_WINDOW);
  let withTrend = 0;
  let counter = 0;
  for (const c of win) {
    const up = c.closePx >= c.openPx;
    const isWith = side === 'long' ? up : !up;
    if (isWith) withTrend += c.volume;
    else counter += c.volume;
  }
  // Both sides must have participated; an all-one-way window is trend, not fade.
  if (!(withTrend > 0) || !(counter > 0)) return false;
  return withTrend < counter;
}

/** Signal 2 — fresh price extreme NOT confirmed by the taker-flow series. */
export function cvdNonConfirmation(
  side: PositionSide,
  candles: MomentumCandle[],
  series: MomentumSeriesPoint[],
): boolean {
  if (candles.length < CANDLES_REQUIRED) return false;
  const win = candles.slice(-CANDLES_REQUIRED);
  const recent = win.slice(-EXTREME_RECENT_BARS);
  const freshExtreme =
    side === 'long'
      ? Math.max(...recent.map((c) => c.highPx)) >= Math.max(...win.map((c) => c.highPx))
      : Math.min(...recent.map((c) => c.lowPx)) <= Math.min(...win.map((c) => c.lowPx));
  if (!freshExtreme) return false;

  const flows = series.map((p) => p.takerFlow).filter((v): v is number => v != null && Number.isFinite(v));
  if (flows.length < SERIES_MIN_POINTS * 2) return false; // thin series must not page
  const laterMean = mean(flows.slice(-SERIES_MIN_POINTS));
  const earlierMean = mean(flows.slice(0, flows.length - SERIES_MIN_POINTS));
  // Side-relative flow: positive flow confirms a long, negative confirms a short.
  const rel = (v: number): number => (side === 'long' ? v : -v);
  // Non-confirmation requires MATERIAL fade: with-position flow non-positive, or fallen
  // to ≤ half its earlier level. A mere tick down (+0.7 → +0.6 on a long) is still
  // strong confirmation and must not vote for a stall (review F3).
  const laterRel = rel(laterMean);
  const earlierRel = rel(earlierMean);
  return laterRel <= 0 || (earlierRel > 0 && laterRel <= earlierRel * 0.5);
}

/** Signal 3 — book imbalance persistently against the position (last SERIES_MIN_POINTS non-null). */
export function bookAgainst(side: PositionSide, series: MomentumSeriesPoint[]): boolean {
  const imbs = series.map((p) => p.bookImbalance).filter((v): v is number => v != null && Number.isFinite(v));
  if (imbs.length < SERIES_MIN_POINTS) return false;
  const last = imbs.slice(-SERIES_MIN_POINTS);
  // + = bid-heavy. Against a long: ask-heavy (≤ -T). Against a short: bid-heavy (≥ +T).
  return last.every((v) => (side === 'long' ? v <= -BOOK_AGAINST_THRESHOLD : v >= BOOK_AGAINST_THRESHOLD));
}

/** The 2-of-3 composite. Deterministic; missing data can only make signals false. */
export function momentumStallVerdict(input: MomentumStallInput): MomentumStallVerdict {
  const flipped: string[] = [];
  if (volumeFade(input.side, input.candles)) flipped.push('volume-fade');
  if (cvdNonConfirmation(input.side, input.candles, input.series)) flipped.push('cvd-non-confirmation');
  if (bookAgainst(input.side, input.series)) flipped.push('book-against');
  const stalled = flipped.length >= 2;
  const label: Record<string, string> = {
    'volume-fade': 'with-trend volume fading',
    'cvd-non-confirmation': 'fresh extreme not confirmed by taker flow',
    'book-against': 'book persistently leaning against the position',
  };
  return {
    stalled,
    flipped,
    detail: flipped.length > 0 ? flipped.map((f) => label[f]).join('; ') : 'momentum intact',
  };
}
