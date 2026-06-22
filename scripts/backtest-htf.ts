/**
 * pnpm backtest:htf — does a HIGHER-TIMEFRAME TREND FILTER improve the trend core?
 *
 * Classic trend-following discipline: only take a 4h entry when the 1d regime AGREES
 * (don't fight the dominant trend). Runs the SAME core (taker) across K windows ×
 * BTC/ETH/SOL with the filter OFF vs ON and compares net + trade count. If the filter
 * cuts counter-trend losers more than it cuts winners, total net rises on FEWER trades
 * (better $/trade) — a genuine quality lever. If it just thins trades proportionally,
 * it's not a lever.
 *
 *   pnpm backtest:htf [--windows 8] [--days 90] [--interval 4h] [--htf 1d]
 */

import { parseArgs, optionalNumber, header, line, run } from './_skill-runtime';
import { runBacktest, type BacktestRunResult } from '@/lib/backtest/backtest-replay-service';
import type { CandleInterval } from '@/lib/hyperliquid/candle-service';

const COINS = ['BTC', 'ETH', 'SOL'];
const DAY_MS = 24 * 60 * 60 * 1000;

const sumNet = (rs: BacktestRunResult[]) => rs.reduce((s, r) => s + r.result.netUsd, 0);
const tradeCount = (rs: BacktestRunResult[]) => rs.reduce((s, r) => s + r.result.trades.length, 0);
const perTrade = (rs: BacktestRunResult[]) => (tradeCount(rs) > 0 ? sumNet(rs) / tradeCount(rs) : 0);

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const windows = optionalNumber(args, 'windows', 8);
  const days = optionalNumber(args, 'days', 90);
  const interval = (typeof args['interval'] === 'string' ? args['interval'] : '4h') as CandleInterval;
  const htf = (typeof args['htf'] === 'string' ? args['htf'] : '1d') as CandleInterval;
  const htfMode = (args['mode'] === 'non-opposing' ? 'non-opposing' : 'agree') as 'agree' | 'non-opposing';
  const now = Date.now();

  header(`backtest:htf — ${htf} trend filter (${htfMode}) on a ${interval} core | ${windows}×${days}d, BTC/ETH/SOL`);
  line(`Filter mode '${htfMode}': ${htfMode === 'agree' ? 'htf regime must MATCH (neutral blocks)' : 'block only when htf OPPOSES (neutral allowed)'}. Does it cut losers more than winners?`);
  line('');

  const offAll: BacktestRunResult[] = [];
  const onAll: BacktestRunResult[] = [];

  for (let w = 0; w < windows; w++) {
    const endMs = now - w * days * DAY_MS;
    const ending = new Date(endMs).toISOString().slice(0, 10);
    const off: BacktestRunResult[] = [];
    const on: BacktestRunResult[] = [];
    for (const coin of COINS) {
      try {
        off.push(await runBacktest({ coin, days, endMs, interval, htfFilter: false }));
        on.push(await runBacktest({ coin, days, endMs, interval, htfFilter: true, htfInterval: htf, htfMode }));
      } catch {
        /* skip */
      }
    }
    offAll.push(...off);
    onAll.push(...on);
    const o = sumNet(off);
    const n = sumNet(on);
    header(`window ${w} — ending ${ending}`);
    line(`  filter OFF ${(o >= 0 ? '+' : '') + '$' + o.toFixed(0)} (${tradeCount(off)}t)  |  ON ${(n >= 0 ? '+' : '') + '$' + n.toFixed(0)} (${tradeCount(on)}t)  (Δ ${(n - o >= 0 ? '+' : '') + '$' + (n - o).toFixed(0)})`);
  }

  const oTot = sumNet(offAll);
  const nTot = sumNet(onAll);
  header('VERDICT');
  line(`TOTAL net:  filter OFF ${(oTot >= 0 ? '+' : '') + '$' + oTot.toFixed(0)}  vs  ON ${(nTot >= 0 ? '+' : '') + '$' + nTot.toFixed(0)}  (Δ ${(nTot - oTot >= 0 ? '+' : '') + '$' + (nTot - oTot).toFixed(0)})`);
  line(`trades:  OFF ${tradeCount(offAll)} ($${perTrade(offAll).toFixed(2)}/trade)  vs  ON ${tradeCount(onAll)} ($${perTrade(onAll).toFixed(2)}/trade)`);
  const gain = nTot - oTot;
  const qualityUp = perTrade(onAll) > perTrade(offAll) * 1.15; // ≥15% better expectancy/trade
  if (gain > Math.abs(oTot) * 0.1 || (gain > 0 && qualityUp)) {
    line('→ HTF FILTER HELPS: it cuts counter-trend losers more than winners (higher $/trade). A quality lever.');
  } else if (gain < -Math.abs(oTot) * 0.1) {
    line('→ HTF FILTER HURTS: it filters out too many winners (the 4h regime leads the 1d). Skip it.');
  } else {
    line('→ ~WASH: the filter thins trades without improving expectancy. Not a lever.');
  }
  line('SCOPE: single-entry-TF + htf regime gate, leaders/carry/micro excluded, taker, fixed $1k. Diagnosis only.');
});
