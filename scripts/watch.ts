/**
 * pnpm watch — the NON-AGENT WATCH DAEMON (thin I/O entrypoint).
 *
 * The user's explicit requirement: "for watches we should have scripting or
 * non-agent code provide that outside of the session." This is that code. It is
 * a long-running loop that runs OUTSIDE any Claude session and survives the
 * session dying — it must keep monitoring open positions even when no agent is
 * attached.
 *
 * WATCH-ONLY. It NEVER places a trade. Every tick: find active sessions that
 * have an OPEN position (poll — so a position created by a fill is auto-picked-up
 * on the next tick), run the EXISTING health engine, and write health_snapshots
 * + pnl + (deduped) analysis_log rows so the cockpit UI lights up. The trade
 * path (fill-source / executeIntent) is never imported here or in
 * `src/lib/watch/**` — pinned by tests/lib/watch/no-trade-guarantee.test.ts.
 *
 * AUTO-START ON FILL (poll model): the daemon does not subscribe to fills. It
 * polls the `positions` table every interval; the moment a fill writes a non-flat
 * positions row, the next cycle finds it and begins monitoring. P3's session
 * orchestration will SPAWN this at session start, but it also works if simply
 * left running — leave it on and it picks up whatever opens.
 *
 * Usage:
 *   pnpm watch                       # loop forever, ~20s interval
 *   pnpm watch --interval 5          # loop every 5s
 *   pnpm watch --once                # run a single cycle and exit (verification)
 *
 * Resilience: one failing tick is logged and the loop continues (failures are
 * isolated per position in runWatchCycle). SIGINT/SIGTERM trigger a graceful
 * shutdown after the in-flight cycle. Idempotent — restarting is safe (snapshots
 * are append-only history; positions are recomputed from the immutable ledger).
 */

import { parseArgs, optionalNumber, header, line, run } from './_skill-runtime';
import { runWatchCycle, type AlertStateStore } from '@/lib/watch/watch-service';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';

/** Default poll interval (seconds) — ~20s balances freshness vs. HL rate limits. */
const DEFAULT_INTERVAL_SECONDS = 20;
/** Floor so a fat-fingered --interval 0 cannot hammer the HL/Supabase endpoints. */
const MIN_INTERVAL_SECONDS = 2;
/** Consecutive total-failure cycles before a LOUD escalation log (FIX 4). */
const ESCALATE_AFTER_FAILED_CYCLES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * STARTUP HARD-CHECK (FIX 3): fail LOUD + non-zero if the daemon can't actually
 * monitor — Supabase must be configured (service-role client constructs) AND a
 * probe HL fetch must succeed. Without this the daemon would soft-return `[]` and
 * log "no monitored positions" forever while genuinely disconnected, and the
 * operator would never know. Throws → `run()` sets a non-zero exit code.
 *
 * This is STARTUP-ONLY. Per-cycle transient errors stay fail-soft (they must not
 * kill the loop); this check just proves the wiring is real before we begin.
 */
async function preflight(): Promise<void> {
  header('watch daemon — preflight');

  // (1) Supabase service-role client must construct (throws if env is missing).
  try {
    getServiceRoleClient();
    line('✓ Supabase service-role client configured.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Supabase is NOT configured — the daemon cannot read sessions/positions or ` +
        `write snapshots, and would monitor NOTHING silently. ${msg}`,
    );
  }

  // (2) Probe HL — a real candle fetch must return live (non-stale) data.
  const probe = await fetchCandles('BTC', '15m', Date.now() - 60 * 60 * 1000, Date.now());
  if (probe.stale || probe.candles.length === 0) {
    throw new Error(
      `Hyperliquid is unreachable (probe fetch ${probe.stale ? 'stale' : 'empty'}` +
        `${probe.error ? `: ${probe.error}` : ''}) — refusing to start a daemon that ` +
        `can't read marks.`,
    );
  }
  line('✓ Hyperliquid reachable (probe BTC 15m candles).');
}

/** Outcome of one cycle for the loop's heartbeat + failure-escalation tracking. */
interface CycleOutcome {
  /** Positions that ticked OK this cycle. */
  monitored: number;
  /** Active sessions this cycle. */
  activeSessions: number;
  /** True when the cycle ran AND nothing failed (at least, nothing total). */
  ok: boolean;
}

/**
 * Run one cycle and log a concise summary. Never throws (cycle isolates errors).
 * `shouldStop` is threaded into the cycle's in-flight backoff/spacing sleeps so
 * SIGINT interrupts them promptly (FIX B) instead of blocking up to ~8s.
 */
async function runOneCycle(
  alertState: AlertStateStore,
  shouldStop?: () => boolean,
): Promise<CycleOutcome> {
  const ts = new Date().toISOString();
  try {
    const result = await runWatchCycle(alertState, { shouldStop });
    if (result.monitored.length === 0) {
      line(
        `[${ts}] no monitored positions ` +
          `(${result.activeSessions} active session(s), 0 open position(s))`,
      );
    } else {
      for (const m of result.monitored) {
        const d = m.decision;
        const newAlerts = d.newAlerts.map((a) => a.code).join(',') || 'none';
        line(
          `[${ts}] ${m.coin} sess=${m.sessionId.slice(0, 8)} ` +
            `score=${Math.round(d.snapshot.score)} ` +
            `uPnL=$${d.pnl.unrealizedPnlUsd.toFixed(2)} ` +
            `alerts=[${d.snapshot.alerts.join(',') || 'none'}] new=[${newAlerts}]`,
        );
      }
    }
    for (const f of result.failures) {
      line(`[${ts}] WARN tick failed: sess=${f.sessionId.slice(0, 8)} coin=${f.coin} — ${f.error}`);
    }
    // A cycle is a TOTAL failure only when we attempted work and every attempt
    // failed; a clean no-op (no open positions) counts as a healthy cycle.
    const attempted = result.monitored.length + result.failures.length;
    const ok = attempted === 0 || result.monitored.length > 0;
    return { monitored: result.monitored.length, activeSessions: result.activeSessions, ok };
  } catch (err) {
    // Defense-in-depth: the cycle already isolates per-position errors, but a
    // failure in session discovery itself must NOT kill the loop.
    const msg = err instanceof Error ? err.message : String(err);
    line(`[${ts}] WARN cycle error (continuing): ${msg}`);
    return { monitored: 0, activeSessions: 0, ok: false };
  }
}

/** Format an age (ms) compactly for the heartbeat line. */
function fmtAge(ms: number): string {
  if (ms < 1000) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const once = args['once'] === true || args['once'] === 'true';
  const interval = Math.max(
    MIN_INTERVAL_SECONDS,
    optionalNumber(args, 'interval', DEFAULT_INTERVAL_SECONDS),
  );

  // Per-(session,coin) alert state lives in-process so alerts dedupe across ticks
  // within a run. (A fresh process starts with an empty baseline, so a restart
  // re-emits currently-active alerts once — acceptable + intentional.)
  const alertState: AlertStateStore = new Map();

  // HARD-CHECK before doing anything (both --once and loop). Throws → non-zero
  // exit via run() if Supabase or HL is not actually wired up (FIX 3).
  await preflight();

  if (once) {
    header('watch daemon — single cycle (--once)');
    line('WATCH-ONLY: this never places a trade. Running one cycle…');
    await runOneCycle(alertState);
    line('Done (--once).');
    return;
  }

  header(`watch daemon — loop every ${interval}s (Ctrl-C to stop)`);
  line('WATCH-ONLY: this never places a trade. Polling for open positions…');

  let stopping = false;
  const requestStop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    line(`\nReceived ${sig} — finishing the in-flight cycle, then exiting…`);
  };
  process.on('SIGINT', () => requestStop('SIGINT'));
  process.on('SIGTERM', () => requestStop('SIGTERM'));

  // Liveness tracking (FIX 4): heartbeat each cycle + escalate after K straight
  // total-failure cycles so a silent stop is detectable.
  let lastSuccessfulTickAt = Date.now();
  let consecutiveFailedCycles = 0;
  const intervalMs = interval * 1000;

  while (!stopping) {
    const cycleStart = Date.now();
    const outcome = await runOneCycle(alertState, () => stopping);

    if (outcome.ok) {
      lastSuccessfulTickAt = Date.now();
      consecutiveFailedCycles = 0;
    } else {
      consecutiveFailedCycles++;
    }

    // Heartbeat (FIX 4): one line per cycle proving the daemon is alive.
    const ts = new Date().toISOString();
    line(
      `[${ts}] watch alive — ${outcome.activeSessions} session(s), ` +
        `${outcome.monitored} position(s), last ok ${fmtAge(Date.now() - lastSuccessfulTickAt)} ago` +
        (consecutiveFailedCycles > 0 ? ` (⚠ ${consecutiveFailedCycles} failed cycle(s))` : ''),
    );

    // Escalation (FIX 4): after K straight total failures, shout LOUDLY so an
    // operator notices the daemon is running-but-not-working.
    if (consecutiveFailedCycles >= ESCALATE_AFTER_FAILED_CYCLES) {
      console.error(
        `\n[${ts}] ‼ WATCH DAEMON DEGRADED — ${consecutiveFailedCycles} consecutive ` +
          `failed cycles, no successful tick in ${fmtAge(Date.now() - lastSuccessfulTickAt)}. ` +
          `Check HL/Supabase connectivity.`,
      );
    }

    // Cycle-overrun warning (FIX 7): if work outran the interval, the effective
    // poll cadence is silently stretching — say so.
    const elapsed = Date.now() - cycleStart;
    if (elapsed > intervalMs) {
      line(
        `[${ts}] WARN cycle overrun: took ${fmtAge(elapsed)} > interval ${interval}s ` +
          `(effective cadence is stretching).`,
      );
    }

    if (stopping) break;
    // Sleep in short slices so SIGINT is honored promptly mid-wait.
    const wakeAt = cycleStart + intervalMs;
    while (!stopping && Date.now() < wakeAt) {
      await sleep(Math.min(250, wakeAt - Date.now()));
    }
  }

  line('watch daemon stopped cleanly.');
});
