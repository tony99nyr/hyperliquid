/**
 * Leaderboard-comparison cohort (the user's core hypothesis): is the off-leaderboard
 * high-quality population actually different/better than the leaderboard one?
 *
 * The leaderboard universe (windows.json from Gate 1) gives per-window PnL-returns
 * but NOT round-trip win rate (fills exist for only 20 leaderboard accounts). So we
 * compare on the metric both populations share: per-window RETURN persistence, and
 * we contrast the off-leaderboard win-rate-selected cohort's forward profile against
 * the leaderboard PnL-selected cohort's forward profile (the Gate-1 baseline).
 *
 * Output: data/backups/perp-follow-study/comparison-results.json
 */
import * as fs from 'fs';
import { PATHS } from './study-config';
import { spearman, mean, median, quantile } from '../hyperliquid-persistence/lib';

const OUT = `${PATHS.OUT_DIR}/comparison-results.json`;

interface LbAccount {
  address: string;
  leaderboardTop: boolean;
  returns: Array<number | null>;
  status: string;
}

function main() {
  const wj = JSON.parse(fs.readFileSync(`${PATHS.HL_DIR}/windows.json`, 'utf8')) as {
    accounts: LbAccount[];
  };
  const accts = wj.accounts.filter((a) => a.status === 'usable');

  // Leaderboard cohort: PnL-return persistence (Gate-1 metric) — recompute pooled IC
  // and top-quintile transition for the FULL leaderboard universe and the top-500 subset.
  function persistence(rows: LbAccount[]) {
    const px: number[] = [], py: number[] = [];
    let topTop = 0, topBot = 0, topN = 0;
    const fwdTop: number[] = [];
    for (let k = 0; k < 5; k++) {
      const pairs = rows
        .map((a) => ({ x: a.returns[k], y: a.returns[k + 1] }))
        .filter((p) => p.x != null && p.y != null && Number.isFinite(p.x) && Number.isFinite(p.y)) as Array<{ x: number; y: number }>;
      if (pairs.length < 10) continue;
      const xs = pairs.map((p) => p.x), ys = pairs.map((p) => p.y);
      px.push(...xs); py.push(...ys);
      const topCut = quantile(xs.slice().sort((a, b) => a - b), 0.8);
      const yTopCut = quantile(ys.slice().sort((a, b) => a - b), 0.8);
      const yBotCut = quantile(ys.slice().sort((a, b) => a - b), 0.2);
      for (let i = 0; i < pairs.length; i++) {
        if (xs[i] >= topCut) {
          topN++;
          if (ys[i] >= yTopCut) topTop++;
          if (ys[i] <= yBotCut) topBot++;
          fwdTop.push(ys[i]);
        }
      }
    }
    return {
      pooledIC: px.length >= 5 ? spearman(px, py) : NaN,
      nPairs: px.length,
      pTopTop: topN ? topTop / topN : NaN,
      pTopBot: topN ? topBot / topN : NaN,
      fwdTopMean: mean(fwdTop),
      fwdTopMedian: median(fwdTop),
      fwdTopPositiveFrac: fwdTop.filter((x) => x > 0).length / (fwdTop.length || 1),
    };
  }

  const result = {
    meta: {
      leaderboardUsable: accts.length,
      note: 'Leaderboard cohort: per-window PnL-return persistence (Gate-1 metric). Win-rate persistence is computed for the OFF-leaderboard cohort in partA (fills); leaderboard fills exist for only 20 accounts, so a like-for-like win-rate persistence on the leaderboard is not computable at scale — this is the honest asymmetry.',
    },
    leaderboardFull: persistence(accts),
    leaderboardTop500: persistence(accts.filter((a) => a.leaderboardTop)),
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  console.log('[comparison]', JSON.stringify(result.leaderboardFull));
}

main();
