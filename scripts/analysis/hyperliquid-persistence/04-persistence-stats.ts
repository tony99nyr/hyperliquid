/**
 * Step 4 — Pre-registered persistence statistics.
 *
 * (a) Spearman rank IC between consecutive window returns, per pair + pooled, bootstrap 95% CI.
 * (b) Quintile transition matrix, P(top->top) vs 20% null.
 * (c) Forward mean/median return of trailing-top-decile vs universe median, per pair.
 * (d) Same stats for the 'leaderboard-top' subset.
 * (e) Repeat (a)-(c) with risk-adjusted rank (window return / within-window daily PnL vol).
 */
import {
  AccountWindows,
  BOOTSTRAP_ITERS,
  N_WINDOWS,
  bootstrapCI,
  fmtPct,
  mean,
  median,
  mulberry32,
  quantile,
  rankWithTies,
  readCache,
  spearman,
  writeCache,
} from './lib';

type Scorer = (a: AccountWindows, k: number) => number | null;

const rawScore: Scorer = (a, k) => a.returns[k];
const riskAdjScore: Scorer = (a, k) => {
  const r = a.returns[k];
  const v = a.dailyVol[k];
  return r !== null && v !== null && v > 0 ? r / v : null;
};

interface PairObs {
  address: string;
  prev: number; // score in window k (ranking variable)
  next: number; // score in window k+1 (ranking variable)
  nextRawReturn: number; // raw return in window k+1 (outcome variable)
}

function buildPairs(accounts: AccountWindows[], scorer: Scorer): PairObs[][] {
  const pairs: PairObs[][] = [];
  for (let k = 0; k < N_WINDOWS - 1; k++) {
    const obs: PairObs[] = [];
    for (const a of accounts) {
      const prev = scorer(a, k);
      const next = scorer(a, k + 1);
      const nextRaw = a.returns[k + 1];
      if (prev !== null && next !== null && nextRaw !== null) {
        obs.push({ address: a.address, prev, next, nextRawReturn: nextRaw });
      }
    }
    pairs.push(obs);
  }
  return pairs;
}

function pooledIC(pairs: PairObs[][], subsetIdx?: number[][]): number {
  // weighted average of per-pair spearman, weights = pair n
  let num = 0;
  let den = 0;
  pairs.forEach((obs, k) => {
    const sel = subsetIdx ? subsetIdx[k].map((i) => obs[i]) : obs;
    if (sel.length < 10) return;
    const ic = spearman(sel.map((o) => o.prev), sel.map((o) => o.next));
    if (Number.isFinite(ic)) {
      num += ic * sel.length;
      den += sel.length;
    }
  });
  return den > 0 ? num / den : NaN;
}

function analyze(label: string, accounts: AccountWindows[], scorer: Scorer, rng: () => number) {
  const pairs = buildPairs(accounts, scorer);

  // (a) per-pair IC with bootstrap CI
  const perPair = pairs.map((obs, k) => {
    if (obs.length < 10) return { pair: `w${k}->w${k + 1}`, n: obs.length, ic: NaN, lo: NaN, hi: NaN };
    const ic = spearman(obs.map((o) => o.prev), obs.map((o) => o.next));
    const ci = bootstrapCI(
      obs.length,
      (idx) => spearman(idx.map((i) => obs[i].prev), idx.map((i) => obs[i].next)),
      BOOTSTRAP_ITERS,
      rng,
    );
    return { pair: `w${k}->w${k + 1}`, n: obs.length, ic, lo: ci.lo, hi: ci.hi };
  });

  // pooled IC bootstrap: resample within each pair independently
  const pooled = pooledIC(pairs);
  const pooledSamples: number[] = [];
  for (let it = 0; it < BOOTSTRAP_ITERS; it++) {
    const subset = pairs.map((obs) => {
      const idx = new Array<number>(obs.length);
      for (let i = 0; i < obs.length; i++) idx[i] = Math.floor(rng() * obs.length);
      return idx;
    });
    const s = pooledIC(pairs, subset);
    if (Number.isFinite(s)) pooledSamples.push(s);
  }
  pooledSamples.sort((a, b) => a - b);
  const pooledCI = { lo: quantile(pooledSamples, 0.025), hi: quantile(pooledSamples, 0.975) };

  // (b) quintile transition matrix (pooled across pairs); rank by scorer, transition of scorer rank
  const matrix = Array.from({ length: 5 }, () => Array(5).fill(0) as number[]);
  for (const obs of pairs) {
    if (obs.length < 25) continue;
    const prevRanks = rankWithTies(obs.map((o) => o.prev));
    const nextRanks = rankWithTies(obs.map((o) => o.next));
    const n = obs.length;
    for (let i = 0; i < n; i++) {
      const qPrev = Math.min(4, Math.floor(((prevRanks[i] - 0.5) / n) * 5));
      const qNext = Math.min(4, Math.floor(((nextRanks[i] - 0.5) / n) * 5));
      matrix[qPrev][qNext]++;
    }
  }
  const rowProbs = matrix.map((row) => {
    const s = row.reduce((a, b) => a + b, 0);
    return row.map((c) => (s > 0 ? c / s : NaN));
  });

  // (c) forward raw return of trailing-top-decile vs universe median, per pair
  const topDecile = pairs.map((obs, k) => {
    if (obs.length < 30) return { pair: `w${k}->w${k + 1}`, n: obs.length, nTop: 0, topMean: NaN, topMedian: NaN, univMedian: NaN, univMean: NaN };
    const prevRanks = rankWithTies(obs.map((o) => o.prev));
    const n = obs.length;
    const top = obs.filter((_, i) => prevRanks[i] > 0.9 * n);
    const fwd = top.map((o) => o.nextRawReturn);
    const univ = obs.map((o) => o.nextRawReturn);
    return {
      pair: `w${k}->w${k + 1}`,
      n,
      nTop: top.length,
      topMean: mean(fwd),
      topMedian: median(fwd),
      univMean: mean(univ),
      univMedian: median(univ),
    };
  });

  return { label, perPair, pooled, pooledCI, transitionMatrix: rowProbs, transitionCounts: matrix, topDecile };
}

function main(): void {
  const windows = readCache<{ meta: unknown; accounts: AccountWindows[] }>('windows.json');
  if (!windows) throw new Error('Run 03 first');
  const usable = windows.accounts.filter((a) => a.status === 'usable');
  const usableTop = usable.filter((a) => a.leaderboardTop);
  const usableRandom = usable.filter((a) => a.randomSample);
  console.log(`Usable accounts: ${usable.length} (random-sample ${usableRandom.length}, leaderboard-top ${usableTop.length})`);

  const rng = mulberry32(987654321);
  const results = {
    full_raw: analyze('Full universe, raw-return rank', usable, rawScore, rng),
    full_riskadj: analyze('Full universe, risk-adjusted rank', usable, riskAdjScore, rng),
    random_raw: analyze('Random sample only, raw-return rank', usableRandom, rawScore, rng),
    top_raw: analyze('Leaderboard-top subset, raw-return rank', usableTop, rawScore, rng),
    top_riskadj: analyze('Leaderboard-top subset, risk-adjusted rank', usableTop, riskAdjScore, rng),
  };

  writeCache('persistence-stats.json', results);

  for (const r of Object.values(results)) {
    console.log(`\n=== ${r.label} ===`);
    console.log(`Pooled IC: ${r.pooled.toFixed(4)} [${r.pooledCI.lo.toFixed(4)}, ${r.pooledCI.hi.toFixed(4)}]`);
    for (const p of r.perPair) {
      console.log(`  ${p.pair}: IC=${p.ic.toFixed(4)} [${p.lo.toFixed(4)}, ${p.hi.toFixed(4)}] n=${p.n}`);
    }
    console.log('Quintile transition (rows=prev Q1(bottom)..Q5(top), cols=next):');
    r.transitionMatrix.forEach((row, i) =>
      console.log(`  Q${i + 1}: ${row.map((p) => fmtPct(p, 1)).join('  ')}`),
    );
    console.log(`P(top-quintile -> top-quintile): ${fmtPct(r.transitionMatrix[4][4], 1)} (null 20%)`);
    console.log('Trailing top-decile forward raw returns vs universe:');
    for (const t of r.topDecile) {
      console.log(
        `  ${t.pair}: top mean=${fmtPct(t.topMean)} median=${fmtPct(t.topMedian)} | universe mean=${fmtPct(t.univMean)} median=${fmtPct(t.univMedian)} (nTop=${t.nTop}/${t.n})`,
      );
    }
  }
}

main();
