/**
 * pnpm backtest:oos — out-of-sample / walk-forward regime test. Runs the SAME
 * trend core (taker) across K consecutive historical windows for BTC/ETH/SOL and
 * pairs each window's REGIME (buy-and-hold price move %) with the strategy's net.
 *
 * The question this answers: is "the trend core has no edge" ROBUST across
 * regimes, or a chop-only artifact? If the strategy nets POSITIVE in the strongly
 * trending windows (big |move%|) and negative only in chop, the edge is
 * regime-conditional — and we've been testing the regime least favorable to it.
 * If it loses in EVERY regime, the no-edge verdict is robust. NEVER trades.
 *
 *   pnpm backtest:oos [--windows 5] [--days 90]
 */

import { parseArgs, optionalNumber, header, line, run } from './_skill-runtime';
import { runBacktest, type BacktestRunResult } from '@/lib/backtest/backtest-replay-service';
import type { CandleInterval } from '@/lib/hyperliquid/candle-service';

const COINS = ['BTC', 'ETH', 'SOL'];
const DAY_MS = 24 * 60 * 60 * 1000;

function regimeLabel(movePct: number): string {
  if (movePct >= 15) return 'STRONG UP';
  if (movePct >= 5) return 'up';
  if (movePct <= -15) return 'STRONG DN';
  if (movePct <= -5) return 'down';
  return 'chop';
}

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const windows = optionalNumber(args, 'windows', 5);
  const days = optionalNumber(args, 'days', 90);
  const interval = (typeof args['interval'] === 'string' ? args['interval'] : '4h') as CandleInterval; // 4h reaches ~2y back
  const now = Date.now();
  let coinWindowsWithData = 0;

  header(`backtest:oos — trend core (taker) ${interval}, ${windows}×${days}d windows, BTC/ETH/SOL (NEVER trades)`);
  line('Pairs each window REGIME (buy&hold move%) with the strategy NET. Does it win when it trends?');
  line('');

  // Track whether the strategy ever nets positive in a strongly-trending window.
  let trendingWindows = 0;
  let trendingPositive = 0;

  for (let w = 0; w < windows; w++) {
    const endMs = now - w * days * DAY_MS;
    const ending = new Date(endMs).toISOString().slice(0, 10);
    const results: BacktestRunResult[] = [];
    for (const coin of COINS) {
      try {
        results.push(await runBacktest({ coin, days, endMs, interval }));
        coinWindowsWithData++;
      } catch (e) {
        line(`  ${coin}: skipped (${e instanceof Error ? e.message.slice(0, 60) : String(e)})`);
      }
    }
    const total = results.reduce((s, r) => s + r.result.netUsd, 0);
    header(`window ${w} — ending ${ending} (${days}d)`);
    for (const r of results) {
      const strongTrend = Math.abs(r.priceMovePct) >= 15;
      if (strongTrend) {
        trendingWindows++;
        if (r.result.netUsd > 0) trendingPositive++;
      }
      line(
        `  ${r.coin.padEnd(4)} regime ${(r.priceMovePct >= 0 ? '+' : '') + r.priceMovePct.toFixed(1) + '%'} ${regimeLabel(r.priceMovePct).padEnd(9)}` +
          `  trades ${String(r.result.trades.length).padStart(3)}  net ${(r.result.netUsd >= 0 ? '+' : '') + '$' + r.result.netUsd.toFixed(0)}`,
      );
    }
    line(`  → window total: ${total >= 0 ? '+' : ''}$${total.toFixed(0)}`);
  }

  header('VERDICT');
  line(`coin-windows WITH DATA: ${coinWindowsWithData} of ${windows * COINS.length} (empty = HL lacks history that far back)`);
  line(`strongly-trending coin-windows (|move|≥15%): ${trendingWindows}; of those, strategy net-positive: ${trendingPositive}`);
  const frac = trendingWindows > 0 ? trendingPositive / trendingWindows : 0;
  if (trendingWindows < 5) {
    line('→ INCONCLUSIVE — too few trending windows with data to judge. Use a higher --interval (4h/1d) to reach deeper history.');
  } else if (frac >= 0.6) {
    line('→ EDGE LOOKS REGIME-CONDITIONAL: the trend core tends to WIN when it actually trends.');
    line('  "No edge" was likely a chop-regime artifact. Worth pursuing trend-only gating.');
  } else if (frac <= 0.35) {
    line('→ NO-EDGE IS ROBUST: the trend core loses even in strongly-trending windows.');
  } else {
    line(`→ MIXED (${(frac * 100).toFixed(0)}% of trending windows positive) — weak/inconsistent edge; not a clear money-maker.`);
  }
  line('SCOPE: single-TF, leaders/carry/micro excluded, taker fills. Diagnosis only.');
});
