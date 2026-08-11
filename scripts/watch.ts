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

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { parseArgs, optionalNumber, header, line, run } from './_skill-runtime';
import { runWatchCycle, type AlertStateStore } from '@/lib/watch/watch-service';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { WATCH_LOCK_PATH, defaultPidIsWatchDaemon } from '@/lib/cockpit/watch-spawn';

/** Default poll interval (seconds) — ~20s balances freshness vs. HL rate limits. */
const DEFAULT_INTERVAL_SECONDS = 20;
/** Floor so a fat-fingered --interval 0 cannot hammer the HL/Supabase endpoints. */
const MIN_INTERVAL_SECONDS = 2;
/**
 * Poll cadence while there are NO open positions anywhere (ms). An idle daemon
 * only needs to discover a new position promptly-ish, not mark-to-market — the
 * 20s cadence with zero positions was pure Supabase egress (Aug 2026 fair-use
 * overage). A new fill is picked up within ~2 minutes, and ensureWatchDaemon /
 * open-position paths surface immediately anyway.
 */
const IDLE_INTERVAL_MS = 120_000;
/** Consecutive total-failure cycles before a LOUD escalation log (FIX 4). */
const ESCALATE_AFTER_FAILED_CYCLES = 3;

/**
 * SINGLE-INSTANCE GUARD (egress fix, Aug 2026): five hand-started daemons were
 * once found running side by side — the ensureWatchDaemon lockfile only guards
 * the auto-spawn path, so `pnpm watch` by hand could stack duplicates without
 * bound, multiplying every Supabase poll. The daemon now claims the SAME
 * lockfile itself at startup and refuses to start when a confirmed-live watch
 * daemon (that is not our own ancestor — the spawner records the pnpm wrapper
 * pid) already holds it. Stale/dead/unconfirmable locks are replaced — err
 * toward monitoring, exactly like watch-spawn.
 */
function acquireDaemonLockOrExplain(): { ok: boolean; holderPid?: number } {
  const ancestors = ownAncestorPids();
  if (existsSync(WATCH_LOCK_PATH)) {
    let lockPid: number | null = null;
    try {
      const parsed = Number(readFileSync(WATCH_LOCK_PATH, 'utf8').trim());
      lockPid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } catch {
      lockPid = null;
    }
    if (lockPid !== null && !ancestors.has(lockPid) && defaultPidIsWatchDaemon(lockPid)) {
      return { ok: false, holderPid: lockPid };
    }
  }
  try {
    writeFileSync(WATCH_LOCK_PATH, String(process.pid), 'utf8');
  } catch {
    // Best-effort: an unwritable lock dir must not stop monitoring.
  }
  return { ok: true };
}

/**
 * Our own pid plus its ancestor chain (via /proc). When ensureWatchDaemon spawns
 * us it records the detached `pnpm watch` wrapper pid in the lock — which is our
 * ancestor, not a rival daemon — so the guard must never treat an ancestor as
 * "someone else". Walks at most 15 levels; stops silently where /proc is absent.
 */
function ownAncestorPids(): Set<number> {
  const out = new Set<number>([process.pid]);
  let pid = process.pid;
  for (let i = 0; i < 15; i++) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
      const ppid = Number(afterComm.split(' ')[1]);
      if (!Number.isInteger(ppid) || ppid <= 1) break;
      out.add(ppid);
      pid = ppid;
    } catch {
      break;
    }
  }
  return out;
}

/** Drop the lock on clean shutdown IF we still own it (pid match). Best-effort. */
function releaseDaemonLock(): void {
  try {
    if (readFileSync(WATCH_LOCK_PATH, 'utf8').trim() === String(process.pid)) {
      unlinkSync(WATCH_LOCK_PATH);
    }
  } catch {
    // Already gone or unreadable — fine.
  }
}

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

  // Refuse to stack a duplicate daemon (single-instance guard — see above).
  const lock = acquireDaemonLockOrExplain();
  if (!lock.ok) {
    line(
      `Another watch daemon is already running (pid ${lock.holderPid}) — refusing to ` +
        `start a duplicate. Stop it first (kill ${lock.holderPid}) to hand over.`,
    );
    return;
  }

  header(`watch daemon — loop every ${interval}s (Ctrl-C to stop)`);
  line('WATCH-ONLY: this never places a trade. Polling for open positions…');
  line(`Idle throttle: with 0 open positions the poll slows to every ${IDLE_INTERVAL_MS / 1000}s.`);

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
    // Sleep in short slices so SIGINT is honored promptly mid-wait. With zero
    // open positions the cadence stretches to IDLE_INTERVAL_MS (egress fix) —
    // a HEALTHY idle cycle only; failures keep the fast cadence so recovery from
    // an outage isn't slowed down.
    const cadenceMs =
      outcome.ok && outcome.monitored === 0 ? Math.max(intervalMs, IDLE_INTERVAL_MS) : intervalMs;
    const wakeAt = cycleStart + cadenceMs;
    while (!stopping && Date.now() < wakeAt) {
      await sleep(Math.min(250, wakeAt - Date.now()));
    }
  }

  releaseDaemonLock();
  line('watch daemon stopped cleanly.');
});
