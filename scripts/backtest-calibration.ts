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
import { bucketByConfidence, bucketByEntryVol, type BacktestTrade, type CalibrationReport } from '@/lib/backtest/backtest-business-logic';
import type { CandleInterval } from '@/lib/hyperliquid/candle-service';

const COINS = ['BTC', 'ETH', 'SOL'];
const DAY_MS = 24 * 60 * 60 * 1000;
const EDGES = [0.5, 0.6, 0.7, 0.8, 1.0]; // confirmed trades have confidence ≥ 0.5
const VOL_EDGES = [0, 0.01, 0.02, 0.03, 1]; // entry ATR% bands (low-vol → high-vol)

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

  const pooledAvgAbs = Math.abs(allTrades.reduce((s, t) => s + t.netPnlUsd, 0) / allTrades.length) || 1;

  // Print one calibration table + a sizing verdict. `metric` is the column header;
  // `sizeUp`/`sizeDown` name the actionable tilt if a MATERIAL monotonic gradient exists.
  function report(metric: string, rep: CalibrationReport, sizeUp: string, sizeDown: string): void {
    header(`${metric.toUpperCase()} CALIBRATION — ${allTrades.length} trades across ${coinWindowsWithData} coin-windows`);
    line(`${metric.padEnd(12)}  trades   win%     total net    avg/trade`);
    for (const b of rep.buckets) {
      line(
        `  ${b.label.padEnd(12)} ${String(b.trades).padStart(4)}    ${(b.winRate * 100).toFixed(0).padStart(3)}%   ` +
          `${(b.totalNetUsd >= 0 ? '+' : '') + '$' + b.totalNetUsd.toFixed(0)}`.padStart(10) +
          `   ${(b.avgNetUsd >= 0 ? '+' : '') + '$' + b.avgNetUsd.toFixed(2)}`.padStart(11),
      );
    }
    const populated = rep.buckets.filter((b) => b.trades > 0);
    const topVsBottom = populated.length >= 2 ? populated[populated.length - 1].avgNetUsd - populated[0].avgNetUsd : 0;
    const materialGap = Math.abs(topVsBottom) >= pooledAvgAbs; // gap ≥ ~1× the pooled per-trade expectancy
    if (populated.length < 2) {
      line(`→ INCONCLUSIVE — ${metric} barely varies (trades cluster in one band).`);
    } else if (rep.monotonic && rep.trend === 1 && materialGap) {
      line(`→ CALIBRATED: avg net rises monotonically AND materially with ${metric}. ${sizeUp}`);
    } else if (rep.trend === -1 && materialGap) {
      line(`→ INVERTED: higher ${metric} performs MATERIALLY WORSE. ${sizeDown}`);
    } else {
      line(`→ FLAT / NON-CALIBRATED: ${metric} does not predict per-trade outcome.`);
      line(`  Bands cluster (top−bottom avg = ${(topVsBottom >= 0 ? '+' : '') + '$' + topVsBottom.toFixed(2)} vs pooled |avg| $${pooledAvgAbs.toFixed(2)}). Keep sizing FIXED — tilting would overfit noise.`);
    }
    line('');
  }

  // 1) Confidence — does conviction predict outcome? (drives confidence-scaled sizing)
  report('confidence', bucketByConfidence(allTrades, EDGES), 'Size UP high-confidence entries.', 'Size DOWN high-confidence entries.');
  // 2) Entry vol (ATR%) — do tight-stop/low-vol entries perform better? (drives risk-parity tilt)
  report('entry ATR%', bucketByEntryVol(allTrades, VOL_EDGES), 'Size UP high-vol entries.', 'Low-vol entries win → risk-parity (size up tight-stop setups) ADDS edge.');

  line('SCOPE: single-TF, leaders/carry/micro excluded, taker fills, fixed $1k notional. Diagnosis only.');
});
