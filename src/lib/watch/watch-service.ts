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
import { assessHealth, HEALTH_LOOKBACK_MS } from '@/lib/health/health-engine';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { INTERVAL_MS } from '@/lib/hyperliquid/candle-service-business-logic';
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

/** Spacing between per-position HL work (ms) — gentle pacing, not a hammer. */
const HL_REQUEST_SPACING_MS = 150;
/** Base + cap for exponential backoff after consecutive HL failures (ms). */
const HL_BACKOFF_BASE_MS = 500;
const HL_BACKOFF_MAX_MS = 8000;

/**
 * Consecutive HL/tick failures — drives the per-cycle backoff sleep.
 *
 * INTENTIONALLY MODULE-LEVEL (global across coins/sessions): HL rate limits are
 * per-IP, so one shared pacing counter is correct — don't "fix" this to be
 * per-coin/per-session, that would let N coins each hammer the IP independently.
 */
let consecutiveHlFailures = 0;

/** Default slice for interruptible sleeps (ms) — small enough for prompt SIGINT. */
const SLEEP_SLICE_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep `ms`, but in short slices so a `shouldStop()` predicate (SIGINT/abort)
 * interrupts promptly instead of blocking the full duration. Returns early the
 * moment `shouldStop` flips true. When no predicate is given, sleeps once.
 */
async function interruptibleSleep(ms: number, shouldStop?: () => boolean): Promise<void> {
  if (ms <= 0) return;
  if (!shouldStop) {
    await sleep(ms);
    return;
  }
  const deadline = Date.now() + ms;
  while (!shouldStop() && Date.now() < deadline) {
    await sleep(Math.min(SLEEP_SLICE_MS, deadline - Date.now()));
  }
}

/** Backoff delay for the current consecutive-failure streak (capped). PURE-ish. */
function currentBackoffMs(): number {
  if (consecutiveHlFailures <= 0) return 0;
  return Math.min(HL_BACKOFF_MAX_MS, HL_BACKOFF_BASE_MS * 2 ** (consecutiveHlFailures - 1));
}

/** Reset the HL backoff streak (test hook + called on a successful tick). */
export function _resetHlBackoff(): void {
  consecutiveHlFailures = 0;
}

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

/** A mark is "too old" if its last candle is older than this many 15m periods. */
const MAX_MARK_AGE_PERIODS = 2;

/**
 * Fetch a fresh mark price for a coin: the most recent 15m candle close.
 *
 * SINGLE SOURCE: the window is the IDENTICAL 15m window the health engine fetches
 * (`HEALTH_LOOKBACK_MS['15m']` back from `now`), so this hits the candle-service
 * cache the health engine just populated — one HL round-trip per tick, not two.
 *
 * FAIL ON STALE: throws when the candle-service returns a STALE result (HL outage
 * → last cached/empty value) OR when the newest candle is older than ~2 periods
 * (illiquid coin / gap). The per-position try/catch isolates the throw so P&L and
 * alerts are NEVER computed or written against a stale mark.
 */
async function fetchMarkPrice(coin: string, now: number): Promise<number> {
  const res = await fetchCandles(coin, '15m', now - HEALTH_LOOKBACK_MS['15m'], now);
  if (res.stale) {
    throw new Error(`stale mark for ${coin}${res.error ? ` (${res.error})` : ''}`);
  }
  const last = res.candles[res.candles.length - 1];
  if (!last || !Number.isFinite(last.close) || last.close <= 0) {
    throw new Error(`no mark price for ${coin}${res.error ? ` (${res.error})` : ''}`);
  }
  const maxAgeMs = MAX_MARK_AGE_PERIODS * INTERVAL_MS['15m'];
  if (now - last.timestamp > maxAgeMs) {
    throw new Error(
      `mark too old for ${coin}: last candle ${Math.round((now - last.timestamp) / 60000)}m ago`,
    );
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

  // Health first: it fetches the 15m window; `fetchMarkPrice` then reuses that
  // cached 15m close (single HL round-trip for the mark, FIX 1a). Both use the
  // SAME `now`, so the bucketed candle-cache key matches.
  const health = await assessHealth(
    coin,
    { side: position.side, entryPx: position.avgEntryPx },
    now,
  );
  const markPx = await fetchMarkPrice(coin, now);

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
    coin,
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
  opts: { config?: WatchConfig; now?: number; shouldStop?: () => boolean } = {},
): Promise<WatchCycleResult> {
  const { shouldStop } = opts;
  // PER-CYCLE BACKOFF (FIX A): snapshot the delay ONCE at cycle start, based on
  // the PRIOR cycle's failure streak, and sleep it once before processing any
  // positions. (Previously this was re-slept before EVERY position, so a
  // multi-position HL outage compounded the backoff within a single cycle.)
  // Interruptible (FIX B) so SIGINT during an outage doesn't block up to ~8s.
  const cycleBackoffMs = currentBackoffMs();
  if (cycleBackoffMs > 0) await interruptibleSleep(cycleBackoffMs, shouldStop);

  const sessions = await listActiveSessions();
  const monitored: MonitoredResult[] = [];
  const failures: WatchCycleResult['failures'] = [];
  // Alert-state keys touched this cycle; anything NOT here = a position that
  // closed (or whose session went inactive) → its stale dedup baseline is pruned
  // below so a re-open re-fires its alerts (FIX 5).
  const seenKeys = new Set<string>();

  // Count HL/tick failures THIS cycle so we can reset the global streak on a
  // clean/zero-position cycle (FIX C) rather than only when a single position
  // ticks OK.
  let cycleHlFailures = 0;

  let first = true;
  for (const session of sessions) {
    let positions: Position[];
    try {
      positions = await loadOpenPositions(session.id);
    } catch (err) {
      failures.push({ sessionId: session.id, coin: '*', error: extractErrorMessage(err) });
      continue;
    }
    for (const position of positions) {
      seenKeys.add(alertKey(session.id, position.coin));
      // Gentle per-position spacing so HL isn't hit at full rate (the harder
      // backoff is applied once per cycle above, FIX A). Interruptible (FIX B).
      if (!first) await interruptibleSleep(HL_REQUEST_SPACING_MS, shouldStop);
      first = false;

      try {
        const decision = await runWatchTickForPosition(session.id, position, alertState, opts);
        monitored.push({ sessionId: session.id, coin: position.coin, decision });
      } catch (err) {
        cycleHlFailures++;
        failures.push({
          sessionId: session.id,
          coin: position.coin,
          error: extractErrorMessage(err),
        });
      }
    }
  }

  // Backoff-streak accounting (FIX A + FIX C): the streak counts consecutive
  // FAILING CYCLES (not positions), so the exponential backoff grows at most once
  // per cycle. A cycle that attempted ZERO positions, or attempted some with NO
  // HL failures, is healthy → reset the streak so a fresh re-open isn't wrongly
  // penalized. Only a cycle that had at least one HL failure grows it by one.
  if (cycleHlFailures === 0) {
    consecutiveHlFailures = 0;
  } else {
    consecutiveHlFailures++;
  }

  // Prune dedup baselines for positions no longer open (FIX 5).
  for (const key of [...alertState.keys()]) {
    if (!seenKeys.has(key)) alertState.delete(key);
  }

  return { activeSessions: sessions.length, monitored, failures };
}
