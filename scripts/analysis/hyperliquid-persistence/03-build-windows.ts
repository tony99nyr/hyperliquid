/**
 * Step 3 — Build six consecutive 60-day window returns per account.
 *
 * Pre-registered rules:
 * - Window return = delta(cumulative PnL) / avg account value in window.
 *   pnlHistory is flow-free (deposits/withdrawals don't move it); account value is the scale.
 * - Cumulative PnL at window boundaries via linear interpolation of allTime pnlHistory.
 * - Exclude windows where avg account value < $10k.
 * - Exclude windows not covered by history (first point <= start+3d, last point >= end-3d).
 * - Accounts with <4 usable windows => 'died/inactive' bucket (reported as attrition).
 * - Daily PnL vol = quadratic-variation estimator over steps inside the window:
 *   sqrt(sum(dPnl_i^2) / sum(dt_i in days)) / avgAV. Requires >=3 steps in window.
 */
import {
  AccountWindows,
  COVERAGE_TOLERANCE_MS,
  DAY_MS,
  MIN_AVG_ACCOUNT_VALUE,
  MIN_USABLE_WINDOWS,
  N_WINDOWS,
  PortfolioResponse,
  UniverseAccount,
  fmtDate,
  interpAt,
  readCache,
  timeWeightedAvg,
  toNumSeries,
  loadJsonl,
  windowBounds,
  writeCache,
} from './lib';

function main(): void {
  const universe = readCache<{ accounts: UniverseAccount[] }>('universe.json');
  if (!universe) throw new Error('Run 01 first');
  const byAddr = new Map(universe.accounts.map((a) => [a.address, a]));
  const portfolios = loadJsonl<{ address: string; data: PortfolioResponse | null }>('portfolios.jsonl');

  const results: AccountWindows[] = [];
  let noHistory = 0;

  for (const { address, data } of portfolios) {
    const acct = byAddr.get(address);
    if (!acct) continue;
    const allTime = data?.find(([name]) => name === 'allTime')?.[1];
    const base: Omit<AccountWindows, 'returns' | 'avgAccountValue' | 'dailyVol' | 'usableWindows' | 'status' | 'historyStart' | 'historyEnd' | 'historyPoints'> = {
      address,
      leaderboardTop: acct.leaderboardTop,
      randomSample: acct.randomSample,
      displayName: acct.displayName,
    };

    if (!allTime || allTime.pnlHistory.length < 2 || allTime.accountValueHistory.length < 2) {
      noHistory++;
      results.push({
        ...base,
        historyStart: 0,
        historyEnd: 0,
        historyPoints: 0,
        returns: Array(N_WINDOWS).fill(null),
        avgAccountValue: Array(N_WINDOWS).fill(null),
        dailyVol: Array(N_WINDOWS).fill(null),
        usableWindows: 0,
        status: 'no_history',
      });
      continue;
    }

    const pnl = toNumSeries(allTime.pnlHistory);
    const av = toNumSeries(allTime.accountValueHistory);
    const histStart = Math.min(pnl[0][0], av[0][0]);
    const histEnd = Math.max(pnl[pnl.length - 1][0], av[av.length - 1][0]);

    const returns: Array<number | null> = [];
    const avgAVs: Array<number | null> = [];
    const vols: Array<number | null> = [];

    for (let k = 0; k < N_WINDOWS; k++) {
      const { start, end } = windowBounds(k);
      const covered = pnl[0][0] <= start + COVERAGE_TOLERANCE_MS && pnl[pnl.length - 1][0] >= end - COVERAGE_TOLERANCE_MS;
      if (!covered) {
        returns.push(null);
        avgAVs.push(null);
        vols.push(null);
        continue;
      }
      const avgAV = timeWeightedAvg(av, start, end);
      if (!Number.isFinite(avgAV) || avgAV < MIN_AVG_ACCOUNT_VALUE) {
        returns.push(null);
        avgAVs.push(Number.isFinite(avgAV) ? avgAV : null);
        vols.push(null);
        continue;
      }
      const dPnl = interpAt(pnl, end) - interpAt(pnl, start);
      returns.push(dPnl / avgAV);
      avgAVs.push(avgAV);

      // quadratic-variation daily vol from steps inside the window
      const inner: Array<[number, number]> = [[start, interpAt(pnl, start)]];
      for (const [t, v] of pnl) if (t > start && t < end) inner.push([t, v]);
      inner.push([end, interpAt(pnl, end)]);
      if (inner.length >= 4) {
        let sumSq = 0;
        let sumDt = 0;
        for (let i = 1; i < inner.length; i++) {
          sumSq += (inner[i][1] - inner[i - 1][1]) ** 2;
          sumDt += (inner[i][0] - inner[i - 1][0]) / DAY_MS;
        }
        const volDaily = Math.sqrt(sumSq / sumDt) / avgAV;
        vols.push(volDaily > 0 ? volDaily : null);
      } else {
        vols.push(null);
      }
    }

    const usable = returns.filter((r) => r !== null).length;
    const windowsStart = windowBounds(0).start;
    const tooYoung = pnl[0][0] > windowsStart + COVERAGE_TOLERANCE_MS;
    const status: AccountWindows['status'] =
      usable >= MIN_USABLE_WINDOWS ? 'usable' : tooYoung ? 'too_young' : 'died_inactive';

    results.push({
      ...base,
      historyStart: histStart,
      historyEnd: histEnd,
      historyPoints: pnl.length,
      returns,
      avgAccountValue: avgAVs,
      dailyVol: vols,
      usableWindows: usable,
      status,
    });
  }

  // Attrition table
  const counts = { usable: 0, died_inactive: 0, too_young: 0, no_history: 0 };
  for (const r of results) counts[r.status]++;
  const topCounts = { usable: 0, died_inactive: 0, too_young: 0, no_history: 0 };
  for (const r of results) if (r.leaderboardTop) topCounts[r.status]++;

  // per-window usable counts
  const perWindow = Array.from({ length: N_WINDOWS }, (_, k) => ({
    window: k,
    start: fmtDate(windowBounds(k).start),
    end: fmtDate(windowBounds(k).end),
    usable: results.filter((r) => r.returns[k] !== null).length,
  }));

  writeCache('windows.json', {
    meta: {
      anchor: fmtDate(windowBounds(N_WINDOWS - 1).end),
      totalAccounts: results.length,
      attrition: counts,
      attritionLeaderboardTop: topCounts,
      perWindowUsable: perWindow,
      builtAt: new Date().toISOString(),
    },
    accounts: results,
  });

  console.log('Attrition (all):', counts);
  console.log('Attrition (leaderboard-top):', topCounts);
  console.table(perWindow);
}

main();
