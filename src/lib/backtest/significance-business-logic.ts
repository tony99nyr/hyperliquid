/**
 * PURE statistics for the backtest significance test — is the trend-core edge
 * distinguishable from zero, or inside the noise?
 *
 * Two units of analysis, deliberately:
 *  - PER-TRADE (naive/optimistic): a t-stat over all trades. OVERSTATES significance
 *    because trend-following trades are autocorrelated (clustered within a window),
 *    so they are NOT independent samples. Reported only as an upper bound.
 *  - BLOCK BOOTSTRAP (honest): resample whole WINDOWS (time-disjoint ≈ independent)
 *    with replacement, sum each resample → a distribution of the total net with no
 *    distributional assumption. The fraction of resamples ≤ 0 is the one-sided
 *    bootstrap p-value; the 2.5/97.5 percentiles are the 95% CI.
 *
 * No I/O. Deterministic given a seeded RNG (mulberry32) so results reproduce.
 */

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Standard deviation. sample=true → Bessel's n−1 correction (default). */
export function stdDev(xs: number[], sample = true): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  const ss = xs.reduce((a, b) => a + (b - m) * (b - m), 0);
  return Math.sqrt(ss / (sample ? n - 1 : n));
}

export interface TStat {
  n: number;
  mean: number;
  sd: number;
  se: number; // standard error of the mean
  t: number; // mean / se (vs H0: mean = 0)
}

/** One-sample t-statistic of `xs` against H0: mean = 0. */
export function tStat(xs: number[]): TStat {
  const n = xs.length;
  const m = mean(xs);
  const sd = stdDev(xs, true);
  const se = n > 0 ? sd / Math.sqrt(n) : 0;
  return { n, mean: m, sd, se, t: se > 0 ? m / se : 0 };
}

/** Deterministic PRNG (mulberry32) — seed in, [0,1) generator out. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile (p in [0,1]) of an ASCENDING-sorted array, linear interpolation. */
export function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedAsc[0];
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (idx - lo) * (sortedAsc[hi] - sortedAsc[lo]);
}

export interface BootstrapResult {
  iterations: number;
  /** Mean of the resampled totals (≈ the observed total). */
  meanTotal: number;
  /** 95% CI on the total (2.5 / 97.5 percentiles of the resampled totals). */
  ciLow: number;
  ciHigh: number;
  /** One-sided bootstrap p-value: fraction of resampled totals ≤ 0. */
  pLessEqualZero: number;
}

/**
 * Block bootstrap of the TOTAL. Each iteration draws `blocks.length` blocks WITH
 * replacement and sums them — i.e. "what totals would we have seen across this many
 * independent periods?" The spread answers: is the observed total real or luck?
 * Pass per-WINDOW (or per-coin-window) net totals as `blocks`.
 */
export function blockBootstrapTotal(blocks: number[], iterations: number, rng: () => number): BootstrapResult {
  const k = blocks.length;
  const totals: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let s = 0;
    for (let j = 0; j < k; j++) {
      s += blocks[Math.floor(rng() * k)];
    }
    totals.push(s);
  }
  totals.sort((a, b) => a - b);
  const leZero = totals.filter((x) => x <= 0).length;
  return {
    iterations,
    meanTotal: mean(totals),
    ciLow: percentile(totals, 0.025),
    ciHigh: percentile(totals, 0.975),
    pLessEqualZero: leZero / iterations,
  };
}

/** Sharpe-like ratio mean/sd of a return series (unitless). 0 when sd is zero or
 *  FP-negligible (a "flat" series can carry ~1e-17 variance → guard against a
 *  spuriously huge ratio). */
export function sharpe(returns: number[]): number {
  const sd = stdDev(returns, true);
  return sd > 1e-9 ? mean(returns) / sd : 0;
}
