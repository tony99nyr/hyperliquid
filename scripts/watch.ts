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

/** Default poll interval (seconds) — ~20s balances freshness vs. HL rate limits. */
const DEFAULT_INTERVAL_SECONDS = 20;
/** Floor so a fat-fingered --interval 0 cannot hammer the HL/Supabase endpoints. */
const MIN_INTERVAL_SECONDS = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run one cycle and log a concise summary. Never throws (cycle isolates errors). */
async function runOneCycle(alertState: AlertStateStore): Promise<void> {
  const ts = new Date().toISOString();
  try {
    const result = await runWatchCycle(alertState);
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
  } catch (err) {
    // Defense-in-depth: the cycle already isolates per-position errors, but a
    // failure in session discovery itself must NOT kill the loop.
    const msg = err instanceof Error ? err.message : String(err);
    line(`[${ts}] WARN cycle error (continuing): ${msg}`);
  }
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

  while (!stopping) {
    await runOneCycle(alertState);
    if (stopping) break;
    // Sleep in short slices so SIGINT is honored promptly mid-wait.
    const wakeAt = Date.now() + interval * 1000;
    while (!stopping && Date.now() < wakeAt) {
      await sleep(Math.min(250, wakeAt - Date.now()));
    }
  }

  line('watch daemon stopped cleanly.');
});
