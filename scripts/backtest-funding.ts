/**
 * pnpm backtest:funding — how much does REAL carry (funding) change the net?
 *
 * The headline trend-core net (+$1,915) was funding-BLIND. On HL, longs pay funding
 * and shorts earn it. This runs the SAME trend core (taker) across K windows ×
 * BTC/ETH/SOL with funding OFF vs ON (real historical hourly rates) and reports the
 * drag/tailwind. Two questions: (1) is the headline still positive after carry?
 * (2) does the short side get a meaningful carry tailwind (a reason to favor it)?
 *
 *   pnpm backtest:funding [--windows 8] [--days 90] [--interval 4h]
 */

import { parseArgs, optionalNumber, header, line, run } from './_skill-runtime';
import { runBacktest, type BacktestRunResult } from '@/lib/backtest/backtest-replay-service';
import type { CandleInterval } from '@/lib/hyperliquid/candle-service';

const COINS = ['BTC', 'ETH', 'SOL'];
const DAY_MS = 24 * 60 * 60 * 1000;

const sumNet = (rs: BacktestRunResult[]) => rs.reduce((s, r) => s + r.result.netUsd, 0);
// Signed funding $ across closed trades (− = earned, + = paid) for one side.
const sideFunding = (rs: BacktestRunResult[], side: 'long' | 'short') =>
  rs.flatMap((r) => r.result.trades).filter((t) => t.side === side).reduce((s, t) => s + t.fundingUsd, 0);

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const windows = optionalNumber(args, 'windows', 8);
  const days = optionalNumber(args, 'days', 90);
  const interval = (typeof args['interval'] === 'string' ? args['interval'] : '4h') as CandleInterval;
  const now = Date.now();

  header(`backtest:funding — carry honesty | ${interval}, ${windows}×${days}d, BTC/ETH/SOL`);
  line('Same trend core, funding OFF vs ON (real HL hourly rates). Does carry erode or help the edge?');
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
        off.push(await runBacktest({ coin, days, endMs, interval, applyFunding: false }));
        on.push(await runBacktest({ coin, days, endMs, interval, applyFunding: true }));
      } catch {
        /* skip */
      }
    }
    offAll.push(...off);
    onAll.push(...on);
    const o = sumNet(off);
    const n = sumNet(on);
    header(`window ${w} — ending ${ending}`);
    line(`  funding OFF ${(o >= 0 ? '+' : '') + '$' + o.toFixed(0)}  |  ON ${(n >= 0 ? '+' : '') + '$' + n.toFixed(0)}  (carry Δ ${(n - o >= 0 ? '+' : '') + '$' + (n - o).toFixed(0)})`);
  }

  const oTot = sumNet(offAll);
  const nTot = sumNet(onAll);
  const longCarry = sideFunding(onAll, 'long');
  const shortCarry = sideFunding(onAll, 'short');
  header('VERDICT');
  line(`TOTAL net:  funding OFF ${(oTot >= 0 ? '+' : '') + '$' + oTot.toFixed(0)}  vs  ON ${(nTot >= 0 ? '+' : '') + '$' + nTot.toFixed(0)}  (carry Δ ${(nTot - oTot >= 0 ? '+' : '') + '$' + (nTot - oTot).toFixed(0)})`);
  line(`carry by side (signed $, − = earned):  LONG ${longCarry >= 0 ? '+' : ''}$${longCarry.toFixed(0)} paid  |  SHORT ${shortCarry >= 0 ? '+' : ''}$${shortCarry.toFixed(0)}`);
  line(`  → shorts ${shortCarry < 0 ? `EARNED $${(-shortCarry).toFixed(0)} carry` : `PAID $${shortCarry.toFixed(0)} (inverted funding)`}; longs ${longCarry > 0 ? `PAID $${longCarry.toFixed(0)}` : `EARNED $${(-longCarry).toFixed(0)}`}.`);
  const drag = nTot - oTot;
  if (Math.abs(drag) < Math.abs(oTot) * 0.1) {
    line('→ CARRY IS MINOR: funding does not materially change the net. Holds are short enough that carry is noise.');
  } else if (drag < 0) {
    line('→ CARRY IS A DRAG: real funding erodes the edge (net-long bias pays funding in bull windows). Headline was optimistic.');
  } else {
    line('→ CARRY HELPS: the short-side tailwind in funding outweighs the long-side cost. A carry tilt could add edge.');
  }
  line('NOTE: funding modeled at the ENTRY-bar rate held flat over the hold (approx; rates drift). Single-TF, ablated, taker.');
});
