/**
 * Step 5 — Skill diagnostics on the persistent set.
 *
 * Persistent set (pre-registered): accounts in the top decile of raw window return
 * in >=3 of the 5 forward windows (w1..w5), among accounts usable in that window.
 *
 * Diagnostics: daily Sharpe from pnlHistory (QV vol estimator — note history steps
 * are ~6-12d, not daily), max drawdown of cumulative PnL vs avg account value,
 * PnL concentration (share of total PnL from best 5 history steps — proxy for
 * best-5-days given granularity), account age.
 */
import {
  AccountWindows,
  DAY_MS,
  N_WINDOWS,
  PortfolioResponse,
  fmtDate,
  fmtPct,
  loadJsonl,
  rankWithTies,
  readCache,
  toNumSeries,
  windowBounds,
  writeCache,
} from './lib';

export function computePersistentSet(accounts: AccountWindows[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (let k = 1; k < N_WINDOWS; k++) {
    const usable = accounts.filter((a) => a.returns[k] !== null);
    if (usable.length < 30) continue;
    const ranks = rankWithTies(usable.map((a) => a.returns[k] as number));
    const n = usable.length;
    usable.forEach((a, i) => {
      if (ranks[i] > 0.9 * n) counts.set(a.address, (counts.get(a.address) ?? 0) + 1);
    });
  }
  return counts;
}

function main(): void {
  const windows = readCache<{ accounts: AccountWindows[] }>('windows.json');
  if (!windows) throw new Error('Run 03 first');
  const usable = windows.accounts.filter((a) => a.status === 'usable');

  const counts = computePersistentSet(usable);
  const persistent = usable
    .filter((a) => (counts.get(a.address) ?? 0) >= 3)
    .sort((a, b) => {
      const d = (counts.get(b.address) ?? 0) - (counts.get(a.address) ?? 0);
      if (d !== 0) return d;
      const sum = (x: AccountWindows) => x.returns.reduce<number>((acc, r) => acc + (r ?? 0), 0);
      return sum(b) - sum(a);
    });

  console.log(`Persistent set (top decile >=3 of 5 forward windows): ${persistent.length} accounts`);

  const portfolios = new Map(
    loadJsonl<{ address: string; data: PortfolioResponse | null }>('portfolios.jsonl').map((r) => [r.address, r.data]),
  );

  const studyStart = windowBounds(0).start;
  const diagnostics = persistent.map((a) => {
    const allTime = portfolios.get(a.address)?.find(([n]) => n === 'allTime')?.[1];
    const pnl = allTime ? toNumSeries(allTime.pnlHistory) : [];
    const av = allTime ? toNumSeries(allTime.accountValueHistory) : [];

    // restrict to study period (last 12 months)
    const inStudy = pnl.filter(([t]) => t >= studyStart);
    const series = inStudy.length >= 5 ? inStudy : pnl;
    const avInStudy = av.filter(([t]) => t >= studyStart);
    const avSeries = avInStudy.length >= 2 ? avInStudy : av;
    const avgAV = avSeries.reduce((s, [, v]) => s + v, 0) / Math.max(1, avSeries.length);

    // QV daily vol + mean daily pnl => daily Sharpe (annualized sqrt(365))
    let sumSq = 0;
    let sumDt = 0;
    const stepPnls: number[] = [];
    for (let i = 1; i < series.length; i++) {
      const dP = series[i][1] - series[i - 1][1];
      sumSq += dP * dP;
      sumDt += (series[i][0] - series[i - 1][0]) / DAY_MS;
      stepPnls.push(dP);
    }
    const totalPnl = series.length ? series[series.length - 1][1] - series[0][1] : NaN;
    const dailyVolUsd = sumDt > 0 ? Math.sqrt(sumSq / sumDt) : NaN;
    const dailyMeanUsd = sumDt > 0 ? totalPnl / sumDt : NaN;
    const sharpeAnnual = dailyVolUsd > 0 ? (dailyMeanUsd / dailyVolUsd) * Math.sqrt(365) : NaN;

    // max drawdown of cumulative pnl, normalized by avg account value
    let peak = -Infinity;
    let maxDD = 0;
    for (const [, v] of series) {
      peak = Math.max(peak, v);
      maxDD = Math.max(maxDD, peak - v);
    }
    const maxDDFrac = avgAV > 0 ? maxDD / avgAV : NaN;

    // concentration: share of total positive PnL from best 5 steps
    const sortedSteps = stepPnls.slice().sort((x, y) => y - x);
    const best5 = sortedSteps.slice(0, 5).reduce((s, v) => s + v, 0);
    const concentration = totalPnl > 0 ? best5 / totalPnl : NaN;

    const ageDays = pnl.length ? (Date.now() - pnl[0][0]) / DAY_MS : NaN;
    const studyReturn = avgAV > 0 ? totalPnl / avgAV : NaN;

    return {
      address: a.address,
      addressShort: a.address.slice(0, 8),
      displayName: a.displayName,
      leaderboardTop: a.leaderboardTop,
      topDecileCount: counts.get(a.address) ?? 0,
      usableWindows: a.usableWindows,
      windowReturns: a.returns,
      avgAccountValue: avgAV,
      studyPeriodPnlUsd: totalPnl,
      studyPeriodReturn: studyReturn,
      sharpeAnnual,
      maxDrawdownFrac: maxDDFrac,
      best5StepsShare: concentration,
      accountAgeDays: ageDays,
      historySteps: series.length,
      historyStepDays: series.length > 1 ? (series[series.length - 1][0] - series[0][0]) / DAY_MS / (series.length - 1) : NaN,
    };
  });

  writeCache('persistent-set.json', {
    meta: { definition: 'top decile raw return in >=3 of 5 forward windows', count: persistent.length, studyStart: fmtDate(studyStart) },
    diagnostics,
  });

  console.log('\naddr      | top10x | ret(12m) | Sharpe | maxDD  | best5share | age(d) | stepD | vault?');
  for (const d of diagnostics) {
    console.log(
      `${d.addressShort} |   ${d.topDecileCount}    | ${fmtPct(d.studyPeriodReturn).padStart(8)} | ${d.sharpeAnnual.toFixed(2).padStart(6)} | ${fmtPct(d.maxDrawdownFrac).padStart(6)} | ${fmtPct(d.best5StepsShare).padStart(8)} | ${d.accountAgeDays.toFixed(0).padStart(5)} | ${d.historyStepDays.toFixed(1).padStart(5)} | ${d.displayName ?? ''}`,
    );
  }
}

main();
