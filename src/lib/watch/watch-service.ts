/**
 * Watch daemon — thin I/O service (the non-agent monitor's orchestration).
 *
 * This is the I/O shell around the PURE `watch-business-logic`. It:
 *   - discovers the coins to monitor (active sessions × their open positions),
 *   - fetches a fresh mark price + runs the EXISTING health engine,
 *   - calls the pure `decideTick`,
 *   - persists the health snapshot (existing health-snapshot service), a pnl
 *     snapshot carrying the live mark + unrealized P&L (existing pnl writer), and
 *     any NEWLY-fired high-severity alerts to the analysis stream (deduped).
 *
 * WATCH-ONLY — the HARD invariant of the non-agent daemon. This module (and the
 * whole `src/lib/watch/` directory) MUST NOT import the fill/execution path
 * (`fill-source.ts::executeIntent`, `fill-source-paper`, `fill-source-live`,
 * `position-tracker`'s write path). It observes and reports; it never trades.
 * `tests/lib/watch/no-trade-guarantee.test.ts` pins this down.
 *
 * Resilience is the CALLER's job per session (one failing tick must not abort
 * the others / kill the loop). `runWatchTickForSession` throws on a hard error;
 * `runWatchCycle` isolates each session so one failure is logged and the rest
 * proceed.
 */

import { listActiveSessions } from '@/lib/cockpit/session-service';
import {
  loadOpenPositions,
  writePnlSnapshot,
} from '@/lib/cockpit/fill-persistence-service';
import { writeHealthSnapshot } from '@/lib/cockpit/health-snapshot-service';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { assessHealth } from '@/lib/health/health-engine';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';
import {
  decideTick,
  formatAlertMessage,
  type WatchConfig,
  type WatchTickDecision,
} from './watch-business-logic';
import type { Position } from '@/types/position';

/** Source label written into analysis_log rows for watch-emitted alerts. */
const WATCH_SOURCE = 'watch-daemon';

/** In-memory per-(session,coin) alert state for cross-tick dedup. */
export type AlertStateStore = Map<string, string[]>;

/** Stable key for a position's alert state. */
function alertKey(sessionId: string, coin: string): string {
  return `${sessionId}:${coin.trim().toUpperCase()}`;
}

/** What one monitored position resolved to, for the caller's logging. */
export interface MonitoredResult {
  sessionId: string;
  coin: string;
  decision: WatchTickDecision;
}

/** The outcome of a full cycle across all monitored positions. */
export interface WatchCycleResult {
  /** Sessions that were active this cycle. */
  activeSessions: number;
  /** Open positions monitored this cycle (across all sessions). */
  monitored: MonitoredResult[];
  /** Per-position failures (isolated — they do not abort the cycle). */
  failures: Array<{ sessionId: string; coin: string; error: string }>;
}

/**
 * Fetch a fresh mark price for a coin: the most recent 15m candle close. Throws
 * on a hard failure (no candles + no cache) so the tick is treated as failed and
 * isolated by the caller rather than marking to a bogus price.
 */
async function fetchMarkPrice(coin: string, now: number): Promise<number> {
  const lookbackMs = 6 * 60 * 60 * 1000; // 6h of 15m candles
  const res = await fetchCandles(coin, '15m', now - lookbackMs, now);
  const last = res.candles[res.candles.length - 1];
  if (!last || !Number.isFinite(last.close) || last.close <= 0) {
    throw new Error(`no mark price for ${coin}${res.error ? ` (${res.error})` : ''}`);
  }
  return last.close;
}

/**
 * Run ONE tick for ONE open position: fetch mark + health, decide (pure),
 * persist the snapshot + pnl, and emit any new alerts to the analysis stream.
 * Mutates `alertState` so the next tick dedupes against this tick. Throws on a
 * hard I/O error (the caller isolates it).
 */
export async function runWatchTickForPosition(
  sessionId: string,
  position: Position,
  alertState: AlertStateStore,
  opts: { config?: WatchConfig; now?: number } = {},
): Promise<WatchTickDecision> {
  const now = opts.now ?? Date.now();
  const coin = position.coin;
  const key = alertKey(sessionId, coin);

  const [markPx, health] = await Promise.all([
    fetchMarkPrice(coin, now),
    assessHealth(coin, { side: position.side, entryPx: position.avgEntryPx }, now),
  ]);

  const decision = decideTick({
    position,
    markPx,
    health,
    lastAlertCodes: alertState.get(key) ?? [],
    config: opts.config,
  });

  // Persist the health snapshot (drives the cockpit HealthPanel) and a pnl
  // snapshot carrying the live mark + unrealized P&L (drives the PositionPanel).
  await writeHealthSnapshot({
    sessionId,
    score: decision.snapshot.score,
    pContinuation: decision.snapshot.pContinuation,
    pAdverse: decision.snapshot.pAdverse,
    alerts: decision.snapshot.alerts,
  });
  await writePnlSnapshot({
    sessionId,
    coin,
    realizedPnlUsd: decision.pnl.realizedPnlUsd,
    unrealizedPnlUsd: decision.pnl.unrealizedPnlUsd,
    feesPaidUsd: decision.pnl.feesPaidUsd,
    markPx: decision.pnl.markPx,
  });

  // Emit NEW high-severity alerts to the analysis stream (deduped already by the
  // pure decision — only state changes reach here, never the same alert twice).
  for (const alert of decision.newAlerts) {
    await writeAnalysisLog({
      sessionId,
      source: WATCH_SOURCE,
      message: formatAlertMessage(coin, alert, decision.pnl),
      severity: alert.severity,
    });
  }

  // Record this tick's active alert set as the dedup baseline for the next tick.
  alertState.set(key, decision.activeAlertCodes);
  return decision;
}

/**
 * Run a full watch CYCLE: find every active session, monitor each open position,
 * isolating per-position failures so one network/Supabase error does not abort
 * the rest of the cycle or kill the loop. Returns a structured summary the
 * script logs.
 */
export async function runWatchCycle(
  alertState: AlertStateStore,
  opts: { config?: WatchConfig; now?: number } = {},
): Promise<WatchCycleResult> {
  const sessions = await listActiveSessions();
  const monitored: MonitoredResult[] = [];
  const failures: WatchCycleResult['failures'] = [];

  for (const session of sessions) {
    let positions: Position[];
    try {
      positions = await loadOpenPositions(session.id);
    } catch (err) {
      failures.push({ sessionId: session.id, coin: '*', error: extractErrorMessage(err) });
      continue;
    }
    for (const position of positions) {
      try {
        const decision = await runWatchTickForPosition(session.id, position, alertState, opts);
        monitored.push({ sessionId: session.id, coin: position.coin, decision });
      } catch (err) {
        failures.push({
          sessionId: session.id,
          coin: position.coin,
          error: extractErrorMessage(err),
        });
      }
    }
  }

  return { activeSessions: sessions.length, monitored, failures };
}
