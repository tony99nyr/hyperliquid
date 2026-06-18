/**
 * Step 6 — Anticipation vs reaction analysis for the top ~20 persistent accounts.
 *
 * For each entry fill (dir = "Open Long"/"Open Short"):
 *   signed forward return at +1h/+4h/+24h = sideSign * (close(t+h)/fillPx - 1)
 * vs a random-timing baseline: for each entry, 5 random timestamps in the same
 * coin's observed fill span, same direction. Edge = mean(entry fwd - baseline fwd),
 * bootstrap 95% CI over entries.
 *
 * Also: daily-return regression r_t ~ btc_t + eth_t + btc_{t-1} + eth_{t-1} using
 * the 'month' portfolio window (~15h granularity resampled to daily, ~30 obs).
 *
 * EMPIRICAL CONSTRAINT (probed 2026-06-12): userFillsByTime only retains roughly
 * the most recent ~10k fills per account; for hyperactive accounts that span can
 * be hours. Coverage span per account is reported alongside results.
 */
import {
  DAY_MS,
  PortfolioResponse,
  cachePath,
  fmtDate,
  fmtPct,
  interpAt,
  loadJsonl,
  mean,
  mulberry32,
  postInfo,
  quantile,
  readCache,
  toNumSeries,
  writeCache,
} from './lib';
import * as fs from 'fs';

const TOP_N = 20;
const HORIZONS_H = [1, 4, 24];
const BASELINES_PER_ENTRY = 5;
const MAX_FILL_PAGES = 6; // 6 x 2000 = 12k > 10k retention cap
const MIN_ENTRIES_PER_COIN = 10;
const RNG = mulberry32(13371337);

interface Fill {
  coin: string;
  px: string;
  sz: string;
  side: string;
  time: number;
  dir: string;
  closedPnl: string;
  fee: string;
}

interface Candle { t: number; T: number; c: string; o: string }

async function fetchFills(address: string): Promise<Fill[]> {
  const cacheFile = `fills/${address}.json`;
  const cached = readCache<Fill[]>(cacheFile);
  if (cached) return cached;
  const all: Fill[] = [];
  let startTime = Date.UTC(2025, 0, 1);
  for (let page = 0; page < MAX_FILL_PAGES; page++) {
    const batch = await postInfo<Fill[]>({ type: 'userFillsByTime', user: address, startTime });
    all.push(...batch);
    if (batch.length < 2000) break;
    startTime = batch[batch.length - 1].time + 1;
  }
  writeCache(cacheFile, all);
  return all;
}

const candleCache = new Map<string, Array<[number, number]>>();

/**
 * Fetch the FULL available 1h candle history for a coin. Hyperliquid retains
 * only the most recent ~5000 1h candles (~208 days) — empirically verified
 * (BTC 1h request for 14 months returned 4953 candles starting 2025-11-16).
 * Cached once per coin; fills outside the retained range yield NaN and are
 * excluded (coverage is reported per account).
 */
async function getCandleSeries(coin: string): Promise<Array<[number, number]> | null> {
  if (candleCache.has(coin)) return candleCache.get(coin)!;
  const cacheFile = `candles/${coin.replace(/[:/]/g, '_')}_1h_full.json`;
  let candles = readCache<Candle[]>(cacheFile);
  if (!candles) {
    const now = Date.now();
    try {
      candles = await postInfo<Candle[]>({
        type: 'candleSnapshot',
        req: { coin, interval: '1h', startTime: now - 5200 * 3600_000, endTime: now },
      });
    } catch {
      return null;
    }
    if (!candles || candles.length === 0) return null;
    writeCache(cacheFile, candles);
  }
  const series: Array<[number, number]> = candles.map((c) => [c.T, parseFloat(c.c)]);
  series.sort((a, b) => a[0] - b[0]);
  candleCache.set(coin, series);
  return series;
}

/** close price at-or-after time t (next candle close <= t+1h). Returns NaN if out of range. */
function priceAt(series: Array<[number, number]>, t: number): number {
  if (t < series[0][0] - 3600_000 || t > series[series.length - 1][0]) return NaN;
  // first candle close time >= t
  let lo = 0, hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid][0] >= t) hi = mid;
    else lo = mid + 1;
  }
  return series[lo][1];
}

interface EntryObs { coin: string; time: number; sign: number; px: number; fwd: number[]; base: number[][] }

async function analyzeAccount(address: string) {
  const fills = await fetchFills(address);
  if (fills.length === 0) return { address, error: 'no fills' };
  const entries = fills.filter((f) => f.dir === 'Open Long' || f.dir === 'Open Short');
  const spanStart = fills[0].time;
  const spanEnd = fills[fills.length - 1].time;

  // coins with enough entries
  const byCoin = new Map<string, Fill[]>();
  for (const f of entries) {
    if (!byCoin.has(f.coin)) byCoin.set(f.coin, []);
    byCoin.get(f.coin)!.push(f);
  }
  const coins = [...byCoin.entries()].filter(([, fs2]) => fs2.length >= MIN_ENTRIES_PER_COIN);

  const obs: EntryObs[] = [];
  for (const [coin, coinFills] of coins) {
    const series = await getCandleSeries(coin);
    if (!series) continue;
    // baseline sampling range: overlap of fill span and candle coverage (minus 25h tail)
    const cStart = Math.max(coinFills[0].time, series[0][0]);
    const cEnd = Math.min(coinFills[coinFills.length - 1].time, series[series.length - 1][0] - 25 * 3600_000);
    if (cEnd <= cStart) continue;
    for (const f of coinFills) {
      const sign = f.dir === 'Open Long' ? 1 : -1;
      const px = parseFloat(f.px);
      const fwd = HORIZONS_H.map((h) => {
        const p = priceAt(series, f.time + h * 3600_000);
        return Number.isFinite(p) ? sign * (p / px - 1) : NaN;
      });
      // baselines: random times in this coin's fill span, same direction
      const base: number[][] = [];
      for (let b = 0; b < BASELINES_PER_ENTRY; b++) {
        const rt = cStart + RNG() * Math.max(1, cEnd - cStart);
        const p0 = priceAt(series, rt);
        base.push(
          HORIZONS_H.map((h) => {
            const p1 = priceAt(series, rt + h * 3600_000);
            return Number.isFinite(p0) && Number.isFinite(p1) && p0 > 0 ? sign * (p1 / p0 - 1) : NaN;
          }),
        );
      }
      obs.push({ coin, time: f.time, sign, px, fwd, base });
    }
  }

  // edge per horizon with bootstrap CI over entries
  const edges = HORIZONS_H.map((h, hi2) => {
    const diffs: number[] = [];
    for (const o of obs) {
      const baseVals = o.base.map((b) => b[hi2]).filter(Number.isFinite);
      if (Number.isFinite(o.fwd[hi2]) && baseVals.length) diffs.push(o.fwd[hi2] - mean(baseVals));
    }
    if (diffs.length < 20) return { horizonH: h, n: diffs.length, edge: NaN, lo: NaN, hi: NaN };
    const samples: number[] = [];
    for (let it = 0; it < 1000; it++) {
      let s = 0;
      for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(RNG() * diffs.length)];
      samples.push(s / diffs.length);
    }
    samples.sort((a, b) => a - b);
    return { horizonH: h, n: diffs.length, edge: mean(diffs), lo: quantile(samples, 0.025), hi: quantile(samples, 0.975) };
  });

  return {
    address,
    fillCount: fills.length,
    entryCount: entries.length,
    analyzedEntries: obs.length,
    coinsAnalyzed: coins.map(([c, f]) => `${c}(${f.length})`),
    fillSpanDays: (spanEnd - spanStart) / DAY_MS,
    fillSpan: `${fmtDate(spanStart)}..${fmtDate(spanEnd)}`,
    edges,
  };
}

// --- daily regression on month-window portfolio ---
interface DailyCandle { t: number; T: number; c: string }

async function getDailyReturns(coin: string, fromMs: number, toMs: number): Promise<Map<number, number>> {
  const cacheFile = `candles/${coin}_1d.json`;
  let candles = readCache<DailyCandle[]>(cacheFile);
  if (!candles) {
    candles = await postInfo<DailyCandle[]>({
      type: 'candleSnapshot',
      req: { coin, interval: '1d', startTime: fromMs, endTime: toMs },
    });
    writeCache(cacheFile, candles);
  }
  const m = new Map<number, number>();
  for (let i = 1; i < candles.length; i++) {
    const prev = parseFloat(candles[i - 1].c);
    const cur = parseFloat(candles[i].c);
    m.set(candles[i].t, cur / prev - 1); // keyed by day start ms
  }
  return m;
}

/** OLS via normal equations, returns coefficients [intercept, ...betas] and R^2 */
function ols(y: number[], X: number[][]): { beta: number[]; r2: number } {
  const n = y.length;
  const p = X[0].length + 1;
  const A: number[][] = Array.from({ length: p }, () => Array(p).fill(0));
  const b: number[] = Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const row = [1, ...X[i]];
    for (let j = 0; j < p; j++) {
      b[j] += row[j] * y[i];
      for (let k = 0; k < p; k++) A[j][k] += row[j] * row[k];
    }
  }
  // gaussian elimination
  for (let col = 0; col < p; col++) {
    let piv = col;
    for (let r = col + 1; r < p; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    if (Math.abs(A[col][col]) < 1e-12) return { beta: Array(p).fill(NaN), r2: NaN };
    for (let r = 0; r < p; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let k = col; k < p; k++) A[r][k] -= f * A[col][k];
      b[r] -= f * b[col];
    }
  }
  const beta = b.map((v, i) => v / A[i][i]);
  const my = mean(y);
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = beta[0] + X[i].reduce((s, x, j) => s + x * beta[j + 1], 0);
    ssRes += (y[i] - pred) ** 2;
    ssTot += (y[i] - my) ** 2;
  }
  return { beta, r2: ssTot > 0 ? 1 - ssRes / ssTot : NaN };
}

function regressMonthWindow(
  portfolio: PortfolioResponse | null | undefined,
  btcDaily: Map<number, number>,
  ethDaily: Map<number, number>,
) {
  const month = portfolio?.find(([n]) => n === 'month')?.[1];
  if (!month || month.pnlHistory.length < 10) return null;
  const pnl = toNumSeries(month.pnlHistory);
  const av = toNumSeries(month.accountValueHistory);
  const startDay = Math.ceil(pnl[0][0] / DAY_MS) * DAY_MS;
  const endDay = Math.floor(pnl[pnl.length - 1][0] / DAY_MS) * DAY_MS;
  const y: number[] = [];
  const X: number[][] = [];
  for (let d = startDay + DAY_MS; d <= endDay; d += DAY_MS) {
    const dayStart = d - DAY_MS;
    const avStart = interpAt(av, dayStart);
    if (!Number.isFinite(avStart) || avStart < 1000) continue;
    const r = (interpAt(pnl, d) - interpAt(pnl, dayStart)) / avStart;
    const bt = btcDaily.get(dayStart);
    const et = ethDaily.get(dayStart);
    const btPrev = btcDaily.get(dayStart - DAY_MS);
    const etPrev = ethDaily.get(dayStart - DAY_MS);
    if (bt === undefined || et === undefined || btPrev === undefined || etPrev === undefined) continue;
    y.push(r);
    X.push([bt, et, btPrev, etPrev]);
  }
  if (y.length < 15) return null;
  const { beta, r2 } = ols(y, X);
  return {
    nDays: y.length,
    sameDayBetaBtc: beta[1],
    sameDayBetaEth: beta[2],
    prevDayBetaBtc: beta[3],
    prevDayBetaEth: beta[4],
    sameDayBetaSum: beta[1] + beta[2],
    prevDayBetaSum: beta[3] + beta[4],
    r2,
  };
}

async function main(): Promise<void> {
  const persistent = readCache<{ diagnostics: Array<{ address: string; topDecileCount: number; studyPeriodReturn: number }> }>('persistent-set.json');
  if (!persistent) throw new Error('Run 05 first');
  const top = persistent.diagnostics.slice(0, TOP_N);
  console.log(`Analyzing ${top.length} persistent accounts (fills + regression)...`);

  fs.mkdirSync(cachePath('fills'), { recursive: true });
  fs.mkdirSync(cachePath('candles'), { recursive: true });

  const now = Date.now();
  const from = now - 430 * DAY_MS;
  const btcDaily = await getDailyReturns('BTC', from, now);
  const ethDaily = await getDailyReturns('ETH', from, now);

  const portfolios = new Map(
    loadJsonl<{ address: string; data: PortfolioResponse | null }>('portfolios.jsonl').map((r) => [r.address, r.data]),
  );

  const results = [];
  for (const t of top) {
    process.stdout.write(`  ${t.address.slice(0, 8)}... `);
    const fillResult = await analyzeAccount(t.address);
    const reg = regressMonthWindow(portfolios.get(t.address), btcDaily, ethDaily);

    // label (rule fixed before full run: anticipating if 4h or 24h edge CI > 0;
    // reacting/riding if no edge + high same-day beta; insufficient-data qualifier
    // when fill coverage < 14 days or < 100 analyzed entries)
    let label = 'unclear';
    if (!('error' in fillResult)) {
      const e24 = fillResult.edges.find((e) => e.horizonH === 24);
      const e4 = fillResult.edges.find((e) => e.horizonH === 4);
      const anticipating = (e24 && e24.lo > 0) || (e4 && e4.lo > 0);
      const noEdge = e24 && Number.isFinite(e24.edge) && e24.lo <= 0;
      const highSameDayBeta = reg !== null && Math.abs(reg.sameDayBetaSum) > 0.5;
      if (anticipating) label = 'anticipating';
      else if (noEdge && highSameDayBeta) label = 'reacting/riding';
      else if (noEdge) label = 'no-edge-detected';
      const maxN = Math.max(...fillResult.edges.map((e) => e.n));
      if (fillResult.fillSpanDays < 14 || maxN < 100) label = `insufficient-data (${label})`;
    }
    const rec = { ...t, fills: fillResult, regression: reg, label };
    results.push(rec);
    console.log(
      'error' in fillResult
        ? fillResult.error
        : `entries=${fillResult.analyzedEntries} span=${fillResult.fillSpanDays.toFixed(0)}d e24=${fmtPct(fillResult.edges[2]?.edge ?? NaN)} [${fmtPct(fillResult.edges[2]?.lo ?? NaN)},${fmtPct(fillResult.edges[2]?.hi ?? NaN)}] beta=${reg ? reg.sameDayBetaSum.toFixed(2) : 'n/a'} -> ${label}`,
    );
  }

  writeCache('anticipation.json', results);
  console.log('\nSaved anticipation.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
