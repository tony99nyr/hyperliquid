/**
 * pnpm backtest:study — a focused MECHANISM study (not a parameter sweep): run a
 * SMALL set of hypothesis variants of the regime-core entry/exit across all coins
 * and compare, to answer "is the trend core's lateness fixable, or is the core
 * just weak?". DIAGNOSIS ONLY — single-TF, leaders-ablated; do NOT change live
 * configs off this. NEVER trades.
 *
 *   pnpm backtest:study [--days 90]
 */

import { parseArgs, optionalNumber, header, line, run } from './_skill-runtime';
import { runBacktest, type BacktestRunResult } from '@/lib/backtest/backtest-replay-service';

const COINS = ['ETH', 'BTC', 'SOL', 'HYPE'];

// Mechanism hypotheses (kept deliberately small to avoid overfitting):
//  baseline   — current config (conf 0.5, stop 1.5×, target 3.0×)
//  earlier    — lower confidence → enter sooner (tests "entries are late")
//  wider-stop — 2.5× stop (tests "stops too tight → premature stop-outs")
//  quick-tgt  — 2.0× target (tests "targets too far → fewer hit; better R:R hit-rate")
const VARIANTS: Array<{ name: string; confThreshold?: number; stopAtrMult?: number; targetAtrMult?: number; fade?: boolean }> = [
  { name: 'baseline' },
  { name: 'earlier(conf.35)', confThreshold: 0.35 },
  { name: 'wider-stop(2.5x)', stopAtrMult: 2.5 },
  { name: 'quick-tgt(2.0x)', targetAtrMult: 2.0 },
  // Mean-reversion hypothesis: fade the regime (a 35%-win, stop-dominated trend
  // profile suggests the opposite side has edge). quick-tgt suits mean-reversion.
  { name: 'FADE(mean-rev)', fade: true },
  { name: 'FADE+quick-tgt', fade: true, targetAtrMult: 2.0 },
];

function summarize(rs: BacktestRunResult[]): { net: number; trades: number; wins: number; losses: number; stops: number; targets: number } {
  const agg = { net: 0, trades: 0, wins: 0, losses: 0, stops: 0, targets: 0 };
  for (const r of rs) {
    agg.net += r.result.netUsd;
    agg.trades += r.result.trades.length;
    agg.wins += r.result.wins;
    agg.losses += r.result.losses;
    for (const t of r.result.trades) {
      if (t.reason === 'stop') agg.stops++;
      else if (t.reason === 'target') agg.targets++;
    }
  }
  return agg;
}

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const days = optionalNumber(args, 'days', 90);
  header(`backtest:study — regime-core mechanism variants, ${COINS.join('/')}, last ${days}d (DIAGNOSIS; NEVER trades)`);
  line('Variant            net($)   trades  win%   stops/targets   per-coin net');

  for (const v of VARIANTS) {
    const rs: BacktestRunResult[] = [];
    for (const coin of COINS) {
      try {
        rs.push(await runBacktest({ coin, days, confThreshold: v.confThreshold, stopAtrMult: v.stopAtrMult, targetAtrMult: v.targetAtrMult, fade: v.fade }));
      } catch (e) {
        line(`  ${coin} ${v.name}: skipped (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    const a = summarize(rs);
    const decided = a.wins + a.losses;
    const winPct = decided > 0 ? Math.round((a.wins / decided) * 100) : 0;
    const perCoin = rs.map((r) => `${r.coin}:${r.result.netUsd >= 0 ? '+' : ''}${r.result.netUsd.toFixed(0)}`).join(' ');
    line(
      `${v.name.padEnd(18)} ${(a.net >= 0 ? '+' : '') + a.net.toFixed(0).padStart(6)}   ${String(a.trades).padStart(5)}   ${String(winPct).padStart(3)}%   ${a.stops}/${a.targets}`.padEnd(58) +
        `   ${perCoin}`,
    );
  }

  line('');
  line('Read: a variant that flips stops/targets toward TARGETS + lifts net across');
  line('coins = the lateness/stop hypothesis has merit. If NONE clears materially,');
  line('the trend core is weak on its own → pivot effort to a different lane.');
  line('SCOPE: single-TF, leaders/carry/micro excluded, no historical funding. Diagnosis only.');
});
