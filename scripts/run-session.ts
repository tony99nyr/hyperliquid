/**
 * skill:run-session entrypoint (thin I/O). The active-loop CAPSTONE.
 *
 * From a PICKED setup it runs the deterministic ENTRY CHAIN (the only manual
 * touch in it is the APPROVE popup): openSession → analyze-market →
 * build-entry-proposal → requireApproval → executeIntent → start the watch
 * daemon → arm the first Safe-Exit plan. It then prints "session live, monitoring
 * started" and HANDS OFF to the Claude session, which runs the ongoing
 * assess/refresh/advise loop on a scheduled cadence (see the run-session
 * SKILL.md — a script cannot run wake-ups, so that half lives in the playbook).
 *
 * HARD PRINCIPLE: NEVER auto-fires. executeIntent runs ONLY after requireApproval
 * returns true; a reject/timeout aborts WITHOUT executing or starting the monitor.
 * The orchestration logic is the dependency-injected `runSessionEntryChain`; this
 * script only wires the real I/O.
 *
 * Usage:
 *   pnpm skill:run-session --coin ETH [--side buy] [--leader 0x..] \
 *     --risk 100 --stop-frac 0.05 --thesis "…" [--limit 1995]
 */

import { randomUUID } from 'node:crypto';
import { parseArgs, requireString, optionalNumber, requireApproval, header, line, run } from './_skill-runtime';
import { getTradingMode } from '@/lib/env/mode';
import { openSession } from '@/lib/cockpit/session-service';
import { writeHypothesis } from '@/lib/cockpit/hypothesis-service';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { loadPosition } from '@/lib/cockpit/fill-persistence-service';
import { ensureWatchDaemon } from '@/lib/cockpit/watch-spawn';
import { upsertSafeExitPlan } from '@/lib/cockpit/safe-exit-plan-service';
import { runSessionEntryChain, type RunSessionDeps } from '@/lib/cockpit/run-session-service';
import { buildOpenProposal } from '@/lib/skills/open-position-business-logic';
import { buildBestExitPlan } from '@/lib/trading/safe-exit-plan-business-logic';
import { executeIntent } from '@/lib/trading/fill-source';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { fetchL2Book } from '@/lib/hyperliquid/hyperliquid-info-service';
import { assessAndPersistHealth } from '@/lib/health/health-engine';
import {
  composeMarketAssessment,
  MARKET_TIMEFRAMES,
  type MarketTimeframe,
  type TimeframeCandles,
} from '@/lib/skills/analyze-market-business-logic';
import type { OrderSide } from '@/types/fill';

/** Lookback per timeframe — mirrors analyze-market.ts (>200 candles each). */
const LOOKBACK_MS: Record<MarketTimeframe, number> = {
  '1d': 400 * 24 * 60 * 60 * 1000,
  '8h': 400 * 8 * 60 * 60 * 1000,
  '1h': 400 * 60 * 60 * 1000,
  '15m': 400 * 15 * 60 * 1000,
};

/** Fetch the freshest mark (latest 15m candle close). Throws if unavailable. */
async function fetchMark(coin: string): Promise<number> {
  const now = Date.now();
  const res = await fetchCandles(coin, '15m', now - LOOKBACK_MS['15m'], now);
  const last = res.candles[res.candles.length - 1];
  if (res.stale || !last || !(last.close > 0)) {
    throw new Error(`no fresh mark for ${coin}${res.error ? ` (${res.error})` : ''}`);
  }
  return last.close;
}

/** Run analyze-market over all four timeframes + log it to the session. */
async function analyzeMarket(coin: string, sessionId: string) {
  const now = Date.now();
  const candles: TimeframeCandles = {};
  await Promise.all(
    MARKET_TIMEFRAMES.map(async (tf) => {
      const res = await fetchCandles(coin, tf, now - LOOKBACK_MS[tf], now);
      candles[tf] = res.candles;
    }),
  );
  const assessment = composeMarketAssessment(coin, candles);
  await writeAnalysisLog({
    sessionId,
    source: 'run-session:analyze-market',
    message: assessment.summary,
    severity: assessment.biasLabel === 'bearish' ? 'warn' : 'info',
  });
  return assessment;
}

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const mode = getTradingMode();

  const coin = requireString(args, 'coin').toUpperCase();
  const thesis = requireString(args, 'thesis');
  const riskUsd = optionalNumber(args, 'risk', NaN);
  const stopDistanceFrac = optionalNumber(args, 'stop-frac', NaN);
  const sideRaw = typeof args['side'] === 'string' ? args['side'].toLowerCase() : undefined;
  if (sideRaw !== undefined && sideRaw !== 'buy' && sideRaw !== 'sell') {
    throw new Error('--side must be buy or sell (or omit it to follow the market read)');
  }
  const side = sideRaw as OrderSide | undefined;
  const leaderAddress = typeof args['leader'] === 'string' ? args['leader'] : null;
  const limitPx = typeof args['limit'] === 'string' && Number.isFinite(Number(args['limit'])) ? Number(args['limit']) : undefined;

  if (!Number.isFinite(riskUsd) || riskUsd <= 0) throw new Error('--risk <usd> is required and must be > 0');
  if (!Number.isFinite(stopDistanceFrac) || stopDistanceFrac <= 0) {
    throw new Error('--stop-frac <fraction> is required and must be > 0 (e.g. 0.05)');
  }

  header(`run-session — ${coin}${side ? ` ${side}` : ' (side from market read)'} (mode=${mode})`);
  line('Deterministic entry chain: open → analyze → propose → APPROVE → execute → monitor → arm Safe-Exit.');

  const deps: RunSessionDeps = {
    mode,
    now: () => Date.now(),
    newId: () => randomUUID(),
    openSession,
    fetchMark,
    analyzeMarket,
    buildEntryProposal: buildOpenProposal,
    requireApproval: ({ sessionId, kind, proposal }) =>
      requireApproval({ sessionId, kind, mode, args, proposal }),
    executeIntent,
    writeHypothesis,
    ensureWatchDaemon,
    loadPosition,
    fetchL2Book,
    assessHealth: (sessionId, c, position) => assessAndPersistHealth(sessionId, c, position),
    buildBestExitPlan,
    upsertSafeExitPlan,
    log: line,
  };

  const result = await runSessionEntryChain(
    { coin, side, leaderAddress, riskUsd, stopDistanceFrac, thesis, limitPx },
    deps,
  );

  if (result.outcome === 'aborted') {
    header('Aborted — no position opened');
    line(`Session ${result.sessionId} stays open with no position. Nothing executed.`);
    return;
  }

  if (result.outcome === 'no-fill') {
    header('No fill — nothing was opened');
    line('The entry was approved and submitted, but nothing filled (book empty or the limit price never crossed).');
    line(`Session ${result.sessionId} stays open with no position. No monitor was started and no Safe-Exit was armed.`);
    line('Re-run when the book has liquidity, or use a market entry (omit --limit) / a limit that crosses.');
    return;
  }

  header('Session LIVE — monitoring started');
  line(`session: ${result.sessionId}`);
  line('The non-agent watch daemon is now tracking this position (survives Claude dying).');
  line('The Safe-Exit button is armed with a fresh, smart reduce-only plan and is always available.');
  line('');
  line('HANDOFF TO CLAUDE: Claude will now assess this position on a scheduled cadence');
  line('(assess-health + refresh-exit each cycle) and, when an exit is warranted, propose');
  line('it for YOUR approval. Your only remaining manual touch is APPROVE (or the Safe-Exit button).');
});
