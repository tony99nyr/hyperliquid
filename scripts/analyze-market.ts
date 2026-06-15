/**
 * skill:analyze-market-timeframes entrypoint (thin I/O). ADVISORY ONLY.
 *
 * Multi-timeframe (1d/8h/1h/15m) regime + indicator + divergence read for a coin
 * via the candle-service + vendored pure strategy fns. Writes an analysis_log row
 * and prints the structured assessment. Never trades.
 *
 * Usage:
 *   pnpm skill:analyze-market --session <id> --coin ETH
 */

import { parseArgs, requireString, header, line, run } from './_skill-runtime';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import {
  composeMarketAssessment,
  MARKET_TIMEFRAMES,
  type MarketTimeframe,
  type TimeframeCandles,
} from '@/lib/skills/analyze-market-business-logic';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';

/** Lookback per timeframe — enough candles for regime + indicators (>200). */
const LOOKBACK_MS: Record<MarketTimeframe, number> = {
  '1d': 400 * 24 * 60 * 60 * 1000,
  '8h': 400 * 8 * 60 * 60 * 1000,
  '1h': 400 * 60 * 60 * 1000,
  '15m': 400 * 15 * 60 * 1000,
};

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const sessionId = requireString(args, 'session');
  const coin = requireString(args, 'coin').toUpperCase();
  const now = Date.now();

  header(`analyze-market-timeframes — ${coin}`);
  line('Fetching candles for 1d / 8h / 1h / 15m (read-only)…');

  const candles: TimeframeCandles = {};
  await Promise.all(
    MARKET_TIMEFRAMES.map(async (tf) => {
      const res = await fetchCandles(coin, tf, now - LOOKBACK_MS[tf], now);
      candles[tf] = res.candles;
    }),
  );

  const assessment = composeMarketAssessment(coin, candles);

  header('Multi-timeframe read');
  for (const r of assessment.reads) {
    if (!r.hasData) {
      line(`${r.timeframe}: (insufficient candles)`);
      continue;
    }
    const div = r.divergence ? ` div:${r.divergence.type}(${r.divergence.strength.toFixed(2)})` : '';
    const rsi = r.rsi !== null ? ` RSI:${r.rsi.toFixed(0)}` : '';
    line(`${r.timeframe}: ${r.regime} ${Math.round(r.confidence * 100)}%${rsi}${div}`);
  }

  header('Assessment');
  line(assessment.summary);

  await writeAnalysisLog({
    sessionId,
    source: 'analyze-market-timeframes',
    message: assessment.summary,
    severity: assessment.biasLabel === 'bearish' ? 'warn' : 'info',
  });
  header('Wrote analysis_log row');
  line('\nIf the setup looks good, run open-position (you will confirm before anything executes).');
});
