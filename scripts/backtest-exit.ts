/**
 * pnpm backtest:exit — does a TRAILING STOP beat the FIXED ATR target?
 *
 * A fixed target caps trend winners (anti-trend-following). This runs the SAME
 * trend core (taker) across K windows × BTC/ETH/SOL under two exit policies and
 * compares total net + the winner-size distribution. If trailing wins, the fixed
 * target was leaving the fat tail of the trend on the table.
 *
 *   pnpm backtest:exit [--windows 8] [--days 90] [--interval 4h] [--trail 1.5]
 */

import { parseArgs, optionalNumber, header, line, run } from './_skill-runtime';
import { runBacktest, type BacktestRunResult } from '@/lib/backtest/backtest-replay-service';
import type { CandleInterval } from '@/lib/hyperliquid/candle-service';

const COINS = ['BTC', 'ETH', 'SOL'];
const DAY_MS = 24 * 60 * 60 * 1000;

function sumNet(rs: BacktestRunResult[]): number {
  return rs.reduce((s, r) => s + r.result.netUsd, 0);
}
function maxWin(rs: BacktestRunResult[]): number {
  return Math.max(0, ...rs.flatMap((r) => r.result.trades.map((t) => t.netPnlUsd)));
}

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const windows = optionalNumber(args, 'windows', 8);
  const days = optionalNumber(args, 'days', 90);
  const interval = (typeof args['interval'] === 'string' ? args['interval'] : '4h') as CandleInterval;
  const trailAtrMult = optionalNumber(args, 'trail', 1.5);
  const now = Date.now();

  header(`backtest:exit — fixed target vs trailing stop (${trailAtrMult}×ATR) | ${interval}, ${windows}×${days}d, BTC/ETH/SOL`);
  line('Fixed target CAPS trend winners. Does letting them run (trailing stop) beat it?');
  line('');

  const fixedAll: BacktestRunResult[] = [];
  const trailAll: BacktestRunResult[] = [];
  const perCoinFixed: Record<string, number> = {};
  const perCoinTrail: Record<string, number> = {};

  for (let w = 0; w < windows; w++) {
    const endMs = now - w * days * DAY_MS;
    const ending = new Date(endMs).toISOString().slice(0, 10);
    const fixed: BacktestRunResult[] = [];
    const trail: BacktestRunResult[] = [];
    for (const coin of COINS) {
      try {
        const f = await runBacktest({ coin, days, endMs, interval, exitMode: 'fixed' });
        const t = await runBacktest({ coin, days, endMs, interval, exitMode: 'trail', trailAtrMult });
        fixed.push(f);
        trail.push(t);
        perCoinFixed[coin] = (perCoinFixed[coin] ?? 0) + f.result.netUsd;
        perCoinTrail[coin] = (perCoinTrail[coin] ?? 0) + t.result.netUsd;
      } catch {
        /* HL lacks history that far back — skip */
      }
    }
    fixedAll.push(...fixed);
    trailAll.push(...trail);
    const fNet = sumNet(fixed);
    const tNet = sumNet(trail);
    header(`window ${w} — ending ${ending}`);
    line(`  fixed ${(fNet >= 0 ? '+' : '') + '$' + fNet.toFixed(0)}  |  trail ${(tNet >= 0 ? '+' : '') + '$' + tNet.toFixed(0)}  (Δ ${(tNet - fNet >= 0 ? '+' : '') + '$' + (tNet - fNet).toFixed(0)})`);
  }

  const fTot = sumNet(fixedAll);
  const tTot = sumNet(trailAll);
  header('VERDICT');
  line(`TOTAL net:  fixed ${(fTot >= 0 ? '+' : '') + '$' + fTot.toFixed(0)}  vs  trail ${(tTot >= 0 ? '+' : '') + '$' + tTot.toFixed(0)}  (Δ ${(tTot - fTot >= 0 ? '+' : '') + '$' + (tTot - fTot).toFixed(0)})`);
  line(`biggest single win:  fixed +$${maxWin(fixedAll).toFixed(0)}  vs  trail +$${maxWin(trailAll).toFixed(0)}  (trail should ride the fat tail)`);
  line('per-coin total:');
  for (const c of COINS) {
    line(`  ${c.padEnd(4)} fixed ${(perCoinFixed[c] >= 0 ? '+' : '') + '$' + (perCoinFixed[c] ?? 0).toFixed(0)}  |  trail ${(perCoinTrail[c] >= 0 ? '+' : '') + '$' + (perCoinTrail[c] ?? 0).toFixed(0)}`);
  }
  const gain = tTot - fTot;
  if (gain > Math.abs(fTot) * 0.1) {
    line('→ TRAILING WINS: letting winners run materially beats the fixed target. The cap was costing the fat tail.');
  } else if (gain < -Math.abs(fTot) * 0.1) {
    line('→ FIXED WINS: the trailing stop gives back too much — these trends are choppy enough that locking targets is better.');
  } else {
    line('→ ~WASH: exit policy is not a material lever here. The edge is in entry/regime, not exit.');
  }
  line('SCOPE: single-TF, leaders/carry/micro excluded, taker fills, fixed $1k notional. Diagnosis only.');
});
