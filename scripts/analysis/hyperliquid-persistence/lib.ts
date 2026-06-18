/**
 * Shared library for the Hyperliquid persistence study (Gate 1).
 *
 * PRE-REGISTERED STUDY PARAMETERS — do not tune after seeing results.
 * See docs/trading/COPY_TRADING_RESEARCH_2026-06-10.md for the research context.
 */
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Pre-registered constants
// ---------------------------------------------------------------------------
// Repo-root-relative (this file is <repo>/scripts/analysis/hyperliquid-persistence/lib.ts).
export const DATA_DIR = path.resolve(__dirname, '../../../data/backups/hyperliquid-study');
export const RNG_SEED = 20260612; // recorded seed for universe sampling
export const ANCHOR_MS = Date.UTC(2026, 5, 12); // 2026-06-12T00:00:00Z, fixed study anchor
export const DAY_MS = 86_400_000;
export const WINDOW_DAYS = 60;
export const N_WINDOWS = 6; // six consecutive 60d windows covering last ~12 months
export const MIN_AVG_ACCOUNT_VALUE = 10_000; // exclude noise windows
export const MIN_USABLE_WINDOWS = 4; // below this => 'died/inactive' bucket
export const MIN_ALLTIME_VLM = 5_000_000; // universe filter
export const RANDOM_SAMPLE_SIZE = 2_000;
export const LEADERBOARD_TOP_N = 500; // top by month PnL, flagged subset
export const COVERAGE_TOLERANCE_MS = 3 * DAY_MS; // history must span window +/- this
export const BOOTSTRAP_ITERS = 1_000;

/** Window k (0..5) = [start, end) in ms. Window 5 ends at ANCHOR. */
export function windowBounds(k: number): { start: number; end: number } {
  const end = ANCHOR_MS - (N_WINDOWS - 1 - k) * WINDOW_DAYS * DAY_MS;
  return { start: end - WINDOW_DAYS * DAY_MS, end };
}

// ---------------------------------------------------------------------------
// HTTP with rate limiting + backoff + disk cache
// ---------------------------------------------------------------------------
const INFO_URL = 'https://api.hyperliquid.xyz/info';
const REQUEST_DELAY_MS = 80;

let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const wait = lastRequestAt + REQUEST_DELAY_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

export async function postInfo<T>(body: unknown, maxRetries = 6): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await throttle();
    try {
      const res = await fetch(INFO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= maxRetries) throw new Error(`HTTP ${res.status} after ${attempt} retries`);
        const backoff = Math.min(60_000, 500 * 2 ** attempt) + Math.random() * 250;
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return (await res.json()) as T;
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      const backoff = Math.min(60_000, 500 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

export async function fetchUrl(url: string): Promise<unknown> {
  await throttle();
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

export function cachePath(name: string): string {
  return path.join(DATA_DIR, name);
}

export function readCache<T>(name: string): T | null {
  const p = cachePath(name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

export function writeCache(name: string, data: unknown): void {
  fs.mkdirSync(path.dirname(cachePath(name)), { recursive: true });
  fs.writeFileSync(cachePath(name), JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — deterministic universe sampling
// ---------------------------------------------------------------------------
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates partial shuffle returning first n elements, deterministic. */
export function seededSample<T>(items: T[], n: number, rng: () => number): T[] {
  const arr = items.slice();
  const take = Math.min(n, arr.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rng() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, take);
}

// ---------------------------------------------------------------------------
// Time-series helpers (portfolio histories are [[ms, "value"], ...])
// ---------------------------------------------------------------------------
export type HistPoint = [number, string];

/** Linear interpolation of a [ms, value] series at time t. Clamps outside range. */
export function interpAt(series: Array<[number, number]>, t: number): number {
  if (series.length === 0) return NaN;
  if (t <= series[0][0]) return series[0][1];
  if (t >= series[series.length - 1][0]) return series[series.length - 1][1];
  // binary search for the bracketing pair
  let lo = 0;
  let hi = series.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid][0] <= t) lo = mid;
    else hi = mid;
  }
  const [t0, v0] = series[lo];
  const [t1, v1] = series[hi];
  if (t1 === t0) return v0;
  return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
}

export function toNumSeries(h: HistPoint[]): Array<[number, number]> {
  return h.map(([t, v]) => [t, parseFloat(v)] as [number, number]);
}

/** Time-weighted average of a series over [start, end] using trapezoid rule. */
export function timeWeightedAvg(series: Array<[number, number]>, start: number, end: number): number {
  if (series.length === 0 || end <= start) return NaN;
  const pts: Array<[number, number]> = [[start, interpAt(series, start)]];
  for (const [t, v] of series) if (t > start && t < end) pts.push([t, v]);
  pts.push([end, interpAt(series, end)]);
  let area = 0;
  for (let i = 1; i < pts.length; i++) {
    area += ((pts[i][1] + pts[i - 1][1]) / 2) * (pts[i][0] - pts[i - 1][0]);
  }
  return area / (end - start);
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------
/** Average ranks (1-based) with ties averaged. */
export function rankWithTies(values: number[]): number[] {
  const idx = values.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = avgRank;
    i = j + 1;
  }
  return ranks;
}

export function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return NaN;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
  const mx = sx / n, my = sy / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return NaN;
  return cov / Math.sqrt(vx * vy);
}

export function spearman(x: number[], y: number[]): number {
  return pearson(rankWithTies(x), rankWithTies(y));
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(values: number[]): number {
  return quantile(values.slice().sort((a, b) => a - b), 0.5);
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
}

export function std(values: number[]): number {
  if (values.length < 2) return NaN;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1));
}

/**
 * Bootstrap 95% CI of an arbitrary statistic over paired observations.
 * Resamples observation indices with replacement.
 */
export function bootstrapCI(
  nObs: number,
  stat: (indices: number[]) => number,
  iters: number,
  rng: () => number,
): { lo: number; hi: number } {
  const samples: number[] = [];
  const indices = new Array<number>(nObs);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < nObs; i++) indices[i] = Math.floor(rng() * nObs);
    const s = stat(indices);
    if (Number.isFinite(s)) samples.push(s);
  }
  samples.sort((a, b) => a - b);
  return { lo: quantile(samples, 0.025), hi: quantile(samples, 0.975) };
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------
export interface UniverseAccount {
  address: string;
  accountValue: number;
  displayName: string | null;
  monthPnl: number;
  monthVlm: number;
  allTimePnl: number;
  allTimeVlm: number;
  /** in random 2000 sample */
  randomSample: boolean;
  /** in top-500-by-month-PnL subset */
  leaderboardTop: boolean;
}

export interface PortfolioWindow {
  accountValueHistory: HistPoint[];
  pnlHistory: HistPoint[];
  vlm: string;
}

export type PortfolioResponse = Array<[string, PortfolioWindow]>;

export interface AccountWindows {
  address: string;
  leaderboardTop: boolean;
  randomSample: boolean;
  displayName: string | null;
  historyStart: number;
  historyEnd: number;
  historyPoints: number;
  /** per window: return = dCumPnL / avgAccountValue, or null if unusable */
  returns: Array<number | null>;
  avgAccountValue: Array<number | null>;
  /** daily PnL volatility (quadratic-variation estimator), normalized by avgAV */
  dailyVol: Array<number | null>;
  usableWindows: number;
  status: 'usable' | 'died_inactive' | 'too_young' | 'no_history';
}

export function loadJsonl<T>(file: string): T[] {
  const p = cachePath(file);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

export function appendJsonl(file: string, obj: unknown): void {
  fs.appendFileSync(cachePath(file), JSON.stringify(obj) + '\n');
}

export function fmtPct(x: number, digits = 2): string {
  return Number.isFinite(x) ? (x * 100).toFixed(digits) + '%' : 'n/a';
}

export function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
