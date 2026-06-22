/**
 * pnpm backtest:calibration — is the regime/rubric CONFIDENCE calibrated?
 *
 * Runs the trend core (taker) across K windows × BTC/ETH/SOL, pools every closed
 * trade, and buckets them by ENTRY CONFIDENCE. The question: do higher-confidence
 * entries actually perform better (win-rate AND expectancy)? This must be answered
 * BEFORE building confidence-scaled sizing — sizing by a non-signal is overfitting.
 *
 *   - If avg-net rises monotonically across bands → calibrated → scale size by it.
 *   - If flat/mixed → confidence is a GO GATE ONLY → keep sizing fixed.
 *
 *   pnpm backtest:calibration [--windows 8] [--days 90] [--interval 4h]
 */

import { parseArgs, optionalNumber, header, line, run } from './_skill-runtime';
import { runBacktest } from '@/lib/backtest/backtest-replay-service';
import { bucketByConfidence, type BacktestTrade } from '@/lib/backtest/backtest-business-logic';
import type { CandleInterval } from '@/lib/hyperliquid/candle-service';

const COINS = ['BTC', 'ETH', 'SOL'];
const DAY_MS = 24 * 60 * 60 * 1000;
const EDGES = [0.5, 0.6, 0.7, 0.8, 1.0]; // confirmed trades have confidence ≥ 0.5

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const windows = optionalNumber(args, 'windows', 8);
  const days = optionalNumber(args, 'days', 90);
  const interval = (typeof args['interval'] === 'string' ? args['interval'] : '4h') as CandleInterval;
  const now = Date.now();

  header(`backtest:calibration — confidence vs realized P&L | ${interval}, ${windows}×${days}d, BTC/ETH/SOL`);
  line('Pools every closed trade, buckets by ENTRY CONFIDENCE. Do higher-confidence entries perform better?');
  line('');

  const allTrades: BacktestTrade[] = [];
  let coinWindowsWithData = 0;
  for (let w = 0; w < windows; w++) {
    const endMs = now - w * days * DAY_MS;
    for (const coin of COINS) {
      try {
        const r = await runBacktest({ coin, days, endMs, interval });
        allTrades.push(...r.result.trades);
        coinWindowsWithData++;
      } catch {
        /* HL lacks history that far back for this coin-window — skip */
      }
    }
  }

  if (allTrades.length === 0) {
    line('No trades collected (no data?). Try a smaller --windows or a higher --interval.');
    return;
  }

  const { buckets, monotonic, trend } = bucketByConfidence(allTrades, EDGES);

  header(`CALIBRATION — ${allTrades.length} trades across ${coinWindowsWithData} coin-windows`);
  line('confidence    trades   win%     total net    avg/trade');
  for (const b of buckets) {
    line(
      `  ${b.label}      ${String(b.trades).padStart(4)}    ${(b.winRate * 100).toFixed(0).padStart(3)}%   ` +
        `${(b.totalNetUsd >= 0 ? '+' : '') + '$' + b.totalNetUsd.toFixed(0)}`.padStart(10) +
        `   ${(b.avgNetUsd >= 0 ? '+' : '') + '$' + b.avgNetUsd.toFixed(2)}`.padStart(11),
    );
  }

  header('VERDICT');
  const populated = buckets.filter((b) => b.trades > 0);
  // Top-vs-bottom expectancy gap as a fraction of the pooled per-trade |avg| — the
  // gradient must be both DIRECTIONAL (monotonic) and MATERIAL to justify sizing.
  const pooledAvgAbs = Math.abs(allTrades.reduce((s, t) => s + t.netPnlUsd, 0) / allTrades.length) || 1;
  const topVsBottom = populated.length >= 2 ? populated[populated.length - 1].avgNetUsd - populated[0].avgNetUsd : 0;
  const materialGap = Math.abs(topVsBottom) >= pooledAvgAbs; // gap ≥ ~1× the pooled per-trade expectancy
  if (populated.length < 2) {
    line('→ INCONCLUSIVE — confidence barely varies (signals cluster in one band). Cannot judge calibration.');
  } else if (monotonic && trend === 1 && materialGap) {
    line('→ CALIBRATED: avg net per trade rises monotonically AND materially with confidence.');
    line('  Confidence-scaled sizing is JUSTIFIED — size up the high-confidence band, down the low.');
  } else if (trend === -1 && materialGap) {
    line('→ INVERTED: higher confidence performs MATERIALLY WORSE — do NOT size by it (would amplify the worst trades).');
  } else {
    // Non-monotonic, or a gap smaller than one per-trade expectancy = NOISE, not signal.
    line('→ FLAT / NON-CALIBRATED: confidence does not predict per-trade outcome.');
    line(`  Bands cluster (top−bottom avg = ${(topVsBottom >= 0 ? '+' : '') + '$' + topVsBottom.toFixed(2)} vs pooled |avg| $${pooledAvgAbs.toFixed(2)}); no monotonic gradient.`);
    line('  Confidence is a GO GATE ONLY. Keep sizing FIXED — scaling by it would overfit noise.');
  }
  line('SCOPE: single-TF, leaders/carry/micro excluded, taker fills, fixed $1k notional. Diagnosis only.');
});
