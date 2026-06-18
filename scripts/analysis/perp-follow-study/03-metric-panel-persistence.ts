/**
 * Part A central comparison: rank the active off-leaderboard universe by EACH
 * metric, build the composite, and test forward persistence per metric:
 *   (a) Spearman IC metricX(N) -> metricX(N+1)  (pooled + per-pair)
 *   (b) top-quintile transition matrix + barbell
 *   (c) blow-up rate among top-quintile
 *   (d) forward POSITIVE-PnL of top-quintile selected on N, judged on N+1
 * Plus the win-rate-TRAP diagnostics and the multiple-testing (deflated-Sharpe) hurdle.
 *
 * Output: data/backups/perp-follow-study/partA-results.json
 */
import * as fs from 'fs';
import { PATHS, METRICS, COMPOSITE, PERSISTENCE, MULTIPLE_TESTING, RNG_SEED_PARTA, BOOTSTRAP_ITERS } from './study-config';
import { spearman, mean, median, std, quantile, mulberry32, bootstrapCI } from '../hyperliquid-persistence/lib';

const OUT = `${PATHS.OUT_DIR}/partA-results.json`;

interface Profile {
  address: string;
  blockCount: number;
  nFillsTotal: number;
  active: boolean;
  trailing60: {
    nTrips: number; winRate: number; rawPnl: number; avgWin: number; avgLoss: number;
    profitFactor: number; perTradeSharpe: number; perTradeSortino: number;
    maxDrawdownFrac: number; calmar: number; worstLoss: number; blowUp: boolean;
    medianEntryNotional: number;
  };
  perWindow: Array<{ nTrips: number; winRate: number; pnl: number; pnlRet: number } | null>;
  ethBtcEntryFills: number;
}

function loadProfiles(file: string): Profile[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Profile);
}

function winsorize(vals: number[], lo: number, hi: number): number[] {
  const s = vals.slice().sort((a, b) => a - b);
  const ql = quantile(s, lo), qh = quantile(s, hi);
  return vals.map((v) => Math.min(qh, Math.max(ql, v)));
}
function zscore(vals: number[]): number[] {
  const m = mean(vals), sd = std(vals) || 1;
  return vals.map((v) => (v - m) / sd);
}

// ---- forward persistence for an arbitrary per-window metric extractor ----
function persistenceForMetric(
  profiles: Profile[],
  extract: (w: NonNullable<Profile['perWindow'][number]>) => number,
  rng: () => number,
) {
  // pooled pairs across windows 0..4 -> 1..5
  const pooledX: number[] = [], pooledY: number[] = [], pooledPnlNext: number[] = [];
  const perPair: Array<{ pair: string; ic: number; n: number }> = [];
  for (let k = 0; k < 5; k++) {
    const xs: number[] = [], ys: number[] = [], pnls: number[] = [];
    for (const p of profiles) {
      const a = p.perWindow[k], b = p.perWindow[k + 1];
      if (a && b) { xs.push(extract(a)); ys.push(extract(b)); pnls.push(b.pnlRet); }
    }
    if (xs.length >= 5) {
      perPair.push({ pair: `w${k}->w${k + 1}`, ic: spearman(xs, ys), n: xs.length });
      pooledX.push(...xs); pooledY.push(...ys); pooledPnlNext.push(...pnls);
    }
  }
  const pooledIC = pooledX.length >= 5 ? spearman(pooledX, pooledY) : NaN;
  // bootstrap CI on pooled IC
  let ci = { lo: NaN, hi: NaN };
  if (pooledX.length >= 10) {
    ci = bootstrapCI(pooledX.length, (idx) => spearman(idx.map((i) => pooledX[i]), idx.map((i) => pooledY[i])), BOOTSTRAP_ITERS, rng);
  }
  // top-quintile transition + barbell + forward positive pnl
  const q = PERSISTENCE.TOP_QUANTILE;
  let topTop = 0, topBot = 0, topN = 0;
  const fwdPnlTop: number[] = [];
  for (let k = 0; k < 5; k++) {
    const rows = profiles
      .map((p) => ({ a: p.perWindow[k], b: p.perWindow[k + 1] }))
      .filter((r) => r.a && r.b) as Array<{ a: NonNullable<Profile['perWindow'][number]>; b: NonNullable<Profile['perWindow'][number]> }>;
    if (rows.length < 10) continue;
    const xv = rows.map((r) => extract(r.a));
    const sorted = xv.slice().sort((a, b) => a - b);
    const topCut = quantile(sorted, 1 - q), botCut = quantile(sorted, q);
    for (let i = 0; i < rows.length; i++) {
      if (xv[i] >= topCut) {
        topN++;
        const yb = extract(rows[i].b);
        const yAll = rows.map((r) => extract(r.b)).sort((a, b) => a - b);
        if (yb >= quantile(yAll, 1 - q)) topTop++;
        if (yb <= quantile(yAll, q)) topBot++;
        fwdPnlTop.push(rows[i].b.pnlRet);
      }
    }
  }
  return {
    pooledIC, ci, perPair, nPairs: pooledX.length,
    topQuintile: { pTopTop: topN ? topTop / topN : NaN, pTopBot: topN ? topBot / topN : NaN, n: topN },
    fwdPnlTopMean: mean(fwdPnlTop), fwdPnlTopMedian: median(fwdPnlTop), fwdPnlTopPositive: fwdPnlTop.filter((x) => x > 0).length / (fwdPnlTop.length || 1),
  };
}

// deflated-Sharpe expected-max hurdle
function expectedMaxSharpe(N: number, T: number): number {
  const g = MULTIPLE_TESTING.EULER_MASCHERONI;
  // inverse normal CDF (Acklam approximation)
  const invnorm = (p: number): number => {
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
    const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
    const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
    const pl = 0.02425;
    let q, r;
    if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p <= 1 - pl) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
    q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  };
  const sdSR = Math.sqrt(1 / Math.max(T, 2)); // Var(SR_hat)~1/T under H0
  return sdSR * ((1 - g) * invnorm(1 - 1 / N) + g * invnorm(1 - 1 / (N * Math.E)));
}

function main() {
  const rng = mulberry32(RNG_SEED_PARTA);
  const all = loadProfiles(`${PATHS.OUT_DIR}/profiles.jsonl`);
  const active = all.filter((p) => p.active);
  console.log(`[partA] total profiles ${all.length}, active ${active.length}`);

  // ---- descriptive panel on trailing 60d (active set) ----
  const T = active.map((p) => p.trailing60);
  const blowUpRate = T.filter((m) => m.blowUp).length / (T.length || 1);

  // ---- composite score (z blend, winsorized) ----
  const wr = winsorize(active.map((p) => p.trailing60.winRate), COMPOSITE.WINSOR_LO, COMPOSITE.WINSOR_HI);
  const so = winsorize(active.map((p) => Math.min(5, p.trailing60.perTradeSortino)), COMPOSITE.WINSOR_LO, COMPOSITE.WINSOR_HI);
  const ca = winsorize(active.map((p) => Math.min(20, p.trailing60.calmar)), COMPOSITE.WINSOR_LO, COMPOSITE.WINSOR_HI);
  const zwr = zscore(wr), zso = zscore(so), zca = zscore(ca);
  const composite = active.map((p, i) =>
    COMPOSITE.WEIGHTS.winRate * zwr[i] + COMPOSITE.WEIGHTS.sortino * zso[i] + COMPOSITE.WEIGHTS.calmar * zca[i]
    - COMPOSITE.BLOWUP_PENALTY * (p.trailing60.blowUp ? 1 : 0)
    - COMPOSITE.LEVERAGE_PENALTY * 0, // leverage proxy needs account value; omitted (no acct-value for off-lb addrs)
  );

  // ---- persistence per metric ----
  // For per-window persistence we only have winRate & pnlRet stored per window.
  // (Sharpe/Calmar per-window require per-trip series we didn't store per window;
  //  we test the two we can: winRate and pnlRet. Composite persistence proxied by winRate+pnlRet.)
  const persWinRate = persistenceForMetric(active, (w) => w.winRate, mulberry32(RNG_SEED_PARTA + 1));
  const persPnlRet = persistenceForMetric(active, (w) => w.pnlRet, mulberry32(RNG_SEED_PARTA + 2));

  // ---- deflated Sharpe hurdle ----
  const N = active.length;
  const Tmed = median(active.map((p) => p.trailing60.nTrips));
  const hurdle = expectedMaxSharpe(Math.max(N, 2), Math.max(Tmed, 2));
  const observedMaxSharpe = Math.max(...active.map((p) => p.trailing60.perTradeSharpe));
  const nAboveHurdle = active.filter((p) => p.trailing60.perTradeSharpe > hurdle).length;

  // ---- top candidates by composite ----
  const ranked = active.map((p, i) => ({ address: p.address, composite: composite[i], ...p.trailing60 }))
    .sort((a, b) => b.composite - a.composite);

  const result = {
    meta: { totalProfiles: all.length, activeCount: active.length, anchorWindow: 'w5 trailing 60d' },
    descriptive: {
      winRate: { mean: mean(T.map((m) => m.winRate)), median: median(T.map((m) => m.winRate)), p90: quantile(T.map((m) => m.winRate).sort((a, b) => a - b), 0.9) },
      profitFactor: { median: median(T.map((m) => Math.min(20, m.profitFactor))) },
      perTradeSharpe: { median: median(T.map((m) => m.perTradeSharpe)) },
      calmar: { median: median(T.map((m) => Math.min(50, m.calmar))) },
      maxDrawdownFrac: { median: median(T.map((m) => m.maxDrawdownFrac)) },
      blowUpRate,
      nTrips: { median: median(T.map((m) => m.nTrips)) },
    },
    winRateTrap: {
      // among top-decile by trailing win rate: blow-up rate, avgWin/avgLoss, profitFactor
      topDecileWinRate: (() => {
        const cut = quantile(T.map((m) => m.winRate).sort((a, b) => a - b), 0.9);
        const top = active.filter((p) => p.trailing60.winRate >= cut);
        return {
          n: top.length,
          blowUpRate: top.filter((p) => p.trailing60.blowUp).length / (top.length || 1),
          medianProfitFactor: median(top.map((p) => Math.min(20, p.trailing60.profitFactor))),
          medianWinLossRatio: median(top.map((p) => (p.trailing60.avgLoss > 0 ? p.trailing60.avgWin / p.trailing60.avgLoss : 999))),
          medianMaxDD: median(top.map((p) => p.trailing60.maxDrawdownFrac)),
          medianRawPnl: median(top.map((p) => p.trailing60.rawPnl)),
        };
      })(),
    },
    persistence: { winRate: persWinRate, pnlRet: persPnlRet },
    multipleTesting: { N, medianTripsT: Tmed, deflatedSharpeHurdle: hurdle, observedMaxPerTradeSharpe: observedMaxSharpe, nAboveHurdle },
    topByComposite: ranked.slice(0, 25),
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  console.log('[partA] written', OUT);
  console.log('  blowUpRate', blowUpRate.toFixed(3), 'winRate persistence pooledIC', persWinRate.pooledIC?.toFixed(3), 'pnlRet pooledIC', persPnlRet.pooledIC?.toFixed(3));
  console.log('  deflated-SR hurdle', hurdle.toFixed(3), 'nAboveHurdle', nAboveHurdle, '/', N);
}

main();
