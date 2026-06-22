/**
 * pnpm backtest:significance — is the trend-core edge distinguishable from ZERO?
 *
 * Runs the validated core (4h, taker, funding-aware to match the honest headline)
 * across K windows × BTC/ETH/SOL and tests the net against H0: edge = 0, two ways:
 *
 *  1) PER-TRADE t-stat (NAIVE/OPTIMISTIC) — treats every trade as independent. It
 *     is NOT (trend trades cluster within a window), so this OVERSTATES significance.
 *     Reported as an upper bound only.
 *  2) BLOCK BOOTSTRAP (HONEST) — resamples whole time-disjoint WINDOWS (≈ independent)
 *     with replacement → distribution of the 2-year total, no distributional
 *     assumption. P(total ≤ 0) is the one-sided p-value; 2.5/97.5 pctiles = 95% CI.
 *     Also reported at coin-window granularity (more blocks, but coins co-move).
 *
 *   pnpm backtest:significance [--windows 8] [--days 90] [--interval 4h] [--iters 20000]
 */

import { parseArgs, optionalNumber, header, line, run } from './_skill-runtime';
import { runBacktest } from '@/lib/backtest/backtest-replay-service';
import { tStat, blockBootstrapTotal, mulberry32, sharpe, mean } from '@/lib/backtest/significance-business-logic';
import type { CandleInterval } from '@/lib/hyperliquid/candle-service';

const COINS = ['BTC', 'ETH', 'SOL'];
const DAY_MS = 24 * 60 * 60 * 1000;
const NOTIONAL = 1000;

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const windows = optionalNumber(args, 'windows', 8);
  const days = optionalNumber(args, 'days', 90);
  const interval = (typeof args['interval'] === 'string' ? args['interval'] : '4h') as CandleInterval;
  const iters = optionalNumber(args, 'iters', 20000);
  const now = Date.now();

  header(`backtest:significance — trend core (funding-aware) | ${interval}, ${windows}×${days}d, BTC/ETH/SOL`);
  line('H0: the edge is zero. Per-trade t-stat (optimistic) + block bootstrap (honest).');
  line('');

  const perTrade: number[] = [];
  const windowTotals: number[] = [];
  const coinWindowTotals: number[] = [];

  for (let w = 0; w < windows; w++) {
    const endMs = now - w * days * DAY_MS;
    let wTotal = 0;
    let wHadData = false;
    for (const coin of COINS) {
      try {
        const r = await runBacktest({ coin, days, endMs, interval, applyFunding: true });
        const net = r.result.netUsd;
        perTrade.push(...r.result.trades.map((t) => t.netPnlUsd));
        coinWindowTotals.push(net);
        wTotal += net;
        wHadData = true;
      } catch {
        /* HL lacks history that far back — skip */
      }
    }
    if (wHadData) windowTotals.push(wTotal);
  }

  if (perTrade.length === 0 || windowTotals.length < 2) {
    line('Not enough data (need ≥2 windows). Try fewer --windows or a higher --interval.');
    return;
  }

  const observedTotal = coinWindowTotals.reduce((a, b) => a + b, 0);
  const rng = mulberry32(1337); // fixed seed → reproducible

  // 1) Per-trade t-stat (optimistic).
  const tt = tStat(perTrade);
  header(`OBSERVED — ${perTrade.length} trades, ${windowTotals.length} windows`);
  line(`total net: ${(observedTotal >= 0 ? '+' : '') + '$' + observedTotal.toFixed(0)} on $${NOTIONAL} notional`);
  line(`per-trade: mean ${(tt.mean >= 0 ? '+' : '') + '$' + tt.mean.toFixed(2)}, sd $${tt.sd.toFixed(2)}, n ${tt.n}`);
  line('');
  header('1) PER-TRADE t-stat (OPTIMISTIC — assumes independent trades, they are not)');
  line(`t = ${tt.t.toFixed(2)}  (|t|>1.96 ≈ "significant" IF trades were independent)`);
  line(tt.t > 1.96 ? '  → would look significant — but trend trades cluster, so this overstates it. See the honest test ↓' : '  → not even significant under the optimistic assumption.');
  line('');

  // 2) Block bootstrap — windows (honest) + coin-windows (secondary).
  const bw = blockBootstrapTotal(windowTotals, iters, rng);
  const bcw = blockBootstrapTotal(coinWindowTotals, iters, rng);
  header('2) BLOCK BOOTSTRAP (HONEST — resamples whole time-disjoint windows)');
  line(`by WINDOW (${windowTotals.length} blocks): total ${(bw.meanTotal >= 0 ? '+' : '') + '$' + bw.meanTotal.toFixed(0)}  95% CI [${'$' + bw.ciLow.toFixed(0)}, ${'$' + bw.ciHigh.toFixed(0)}]  P(≤0) = ${(bw.pLessEqualZero * 100).toFixed(1)}%`);
  line(`by COIN-WINDOW (${coinWindowTotals.length} blocks): total ${(bcw.meanTotal >= 0 ? '+' : '') + '$' + bcw.meanTotal.toFixed(0)}  95% CI [${'$' + bcw.ciLow.toFixed(0)}, ${'$' + bcw.ciHigh.toFixed(0)}]  P(≤0) = ${(bcw.pLessEqualZero * 100).toFixed(1)}%`);
  line('  (coin-windows give more blocks but coins co-move, so window-level is the more honest unit.)');
  line('');

  // Window-level Sharpe (per-90d-window return on notional; rough annualization ×√(365/days)).
  const winReturns = windowTotals.map((x) => x / NOTIONAL);
  const winSharpe = sharpe(winReturns);
  const annFactor = Math.sqrt(365 / days);
  header('RISK-ADJUSTED (window-level, lumpy — few points)');
  line(`per-window return: mean ${(mean(winReturns) * 100).toFixed(1)}%, Sharpe ${winSharpe.toFixed(2)} (~${(winSharpe * annFactor).toFixed(2)} annualized, ${windowTotals.length} points — wide error)`);
  line('');

  header('VERDICT');
  const p = bw.pLessEqualZero;
  const perTradeSig = Math.abs(tt.t) > 1.96;
  const smallN = windowTotals.length < 12; // window bootstrap p is partly mechanical at small n
  if (bw.ciLow > 0 && p < 0.05 && perTradeSig) {
    line(`→ DISTINGUISHABLE FROM ZERO at BOTH levels (per-trade t=${tt.t.toFixed(2)}, window 95% CI excludes 0, p=${(p * 100).toFixed(1)}%). Statistically real within the backtest's scope.`);
  } else if (bw.ciLow > 0 && p < 0.05 && !perTradeSig) {
    line(`→ POSITIVE WITHIN-SAMPLE, BUT WEAK + UNPROVEN. The window total is unlikely to be luck GIVEN this sample (CI [${'$' + bw.ciLow.toFixed(0)}, ${'$' + bw.ciHigh.toFixed(0)}]), yet per-trade it is NOT significant (t=${tt.t.toFixed(2)}, |t|<1.96) — the edge only emerges aggregated.`);
    if (smallN) line(`  CAVEAT: only ${windowTotals.length} windows — when most are positive, bootstrap P(≤0)≈0 is partly MECHANICAL (a positive-block resample can't go negative). Trust the WIDE CI, not the tiny p.`);
  } else if (p < 0.20) {
    line(`→ SUGGESTIVE, NOT CONCLUSIVE (p=${(p * 100).toFixed(1)}%, CI [${'$' + bw.ciLow.toFixed(0)}, ${'$' + bw.ciHigh.toFixed(0)}] grazes 0). Lean positive; sample too small to call it proven.`);
  } else {
    line(`→ NOT DISTINGUISHABLE FROM ZERO (p=${(p * 100).toFixed(1)}%). The +$ total is inside the noise — treat the edge as unproven.`);
  }
  line('');
  line('HARD LIMIT (applies regardless of p): the bootstrap resamples WITHIN the observed');
  line(`~2 years (${windowTotals.length} windows) — ONE macro regime (the 2024–25 crypto bull, which flatters`);
  line('trend-following). It cannot speak to regimes not in the sample. Within-sample');
  line('significance ≠ robust-across-regimes. This is a backtest, not a live track record.');
  line('SCOPE: single-TF, leaders/carry/micro ablated, taker, funding-aware, fixed $1k notional.');
});
