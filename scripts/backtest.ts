/**
 * pnpm backtest — replay the REGIME/TREND core over historical HL candles with
 * realistic frictions, and print the scorecard. This is the leaders-ablation test:
 * leaders/carry/micro are NOT involved, so it isolates whether the regime core
 * alone pays after slippage. NEVER trades.
 *
 *   pnpm backtest --coin ETH --days 60
 *   pnpm backtest --coin BTC --days 90 --interval 4h --conf 0.55 --notional 1000
 *
 * Scope/limits (printed): single timeframe; no historical L2 (slippage-modeled
 * fills) or funding (carry excluded). For the full multi-pillar rubric you need
 * historical book/leader/funding — which market_snapshots is now accumulating.
 */

import { parseArgs, requireString, optionalNumber, header, line, run } from './_skill-runtime';
import { runBacktest } from '@/lib/backtest/backtest-replay-service';
import type { CandleInterval } from '@/lib/hyperliquid/candle-service';

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const coin = requireString(args, 'coin').toUpperCase();
  const days = optionalNumber(args, 'days', 60);
  const interval = (typeof args['interval'] === 'string' ? args['interval'] : '1h') as CandleInterval;
  const confThreshold = optionalNumber(args, 'conf', 0.5);
  const notionalUsd = optionalNumber(args, 'notional', 1000);

  header(`backtest — ${coin} ${interval}, last ${days}d (regime-core / leaders-ablation; NEVER trades)`);
  const r = await runBacktest({ coin, days, interval, confThreshold, notionalUsd });

  line(`bars: ${r.bars}   confirmed-regime signals: ${r.signals}   trades: ${r.result.trades.length}`);
  const c = r.scorecard;
  const winRate = c.tradeCount > 0 ? (c.winRate * 100).toFixed(0) : '—';
  line(`win-rate: ${winRate}%   net: $${c.netUsd.toFixed(2)}   maxDD: ${c.maxDrawdownPct == null ? '—' : (c.maxDrawdownPct * 100).toFixed(1) + '%'}`);
  line(`monthly run-rate: $${c.monthlyRunRateUsd.toFixed(0)}/mo   (bar $1000/mo; vs bar ${c.vsBarUsd >= 0 ? '+' : ''}$${c.vsBarUsd.toFixed(0)})`);

  // Exit-reason breakdown — tells you WHY the core wins/loses (late entries die at stops).
  const byReason: Record<string, number> = {};
  for (const t of r.result.trades) byReason[t.reason] = (byReason[t.reason] ?? 0) + 1;
  line(`exits: ${Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`);

  header(`VERDICT (against the pre-registered bar): ${c.verdict.toUpperCase()}`);
  line(c.reason);
  line('');
  line('SCOPE: single-TF regime core, leaders/carry/micro EXCLUDED, no historical funding,');
  line('fills modeled by per-coin adverse slippage (no historical L2). Treat as a directional');
  line('edge check of the trend core, not a verdict on the full multi-pillar rubric.');
});
