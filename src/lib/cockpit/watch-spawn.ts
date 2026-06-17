/**
 * Auto-start the non-agent watch daemon (I/O). The orchestration requirement:
 * the monitor must come up "as soon as the trade executes" WITHOUT the user
 * running `pnpm watch` by hand.
 *
 * Implemented as a DETACHED background spawn of `pnpm watch` that outlives the
 * parent script (`.unref()`), so a one-shot skill run (open-position /
 * run-session) leaves a persistent monitor behind. It is WATCH-ONLY by
 * construction — it can only ever spawn the watch daemon, which is statically
 * pinned to never trade (tests/lib/watch/no-trade-guarantee.test.ts).
 *
 * DOUBLE-SPAWN GUARD (atomic + pid-ownership verified):
 *   1. A per-user lockfile holding the running daemon's pid, acquired with an
 *      ATOMIC O_EXCL create (`flag: 'wx'`). Two near-simultaneous callers can no
 *      longer both observe "not running" and both spawn — only the winner of the
 *      atomic create spawns. The loser (EEXIST) re-validates the existing pid.
 *   2. pid-OWNERSHIP verification: the lock pid counts as "running" ONLY if it is
 *      alive AND confirmed to be OUR watch daemon (cross-checked via
 *      `pgrep -f scripts/watch.ts`). A crashed daemon can leave a lockfile whose
 *      pid the OS later recycles to an unrelated process — `process.kill(pid, 0)`
 *      would say "alive" and we'd wrongly skip spawning, leaving an open position
 *      SILENTLY UNMONITORED. So if the pid is alive but NOT confirmable as the
 *      watch daemon (or pgrep is unavailable), we ERR TOWARD MONITORING: treat the
 *      lock as stale, replace it, and spawn. A rare bounded double-daemon (double
 *      snapshots — a documented Low) is strictly preferable to no monitor.
 *
 * The lockfile lives in a per-user dir (XDG_RUNTIME_DIR → homedir → tmpdir), not
 * world-writable tmpdir, so another user can't pre-create it to block our spawn.
 *
 * The spawn fn is injectable so tests can assert "spawn was/ wasn't invoked"
 * without launching a real process.
 */

import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

/**
 * Per-user directory for the lock. Prefer XDG_RUNTIME_DIR (the canonical per-user
 * runtime dir), else the home directory; fall back to the world-writable tmpdir
 * only if neither exists (last resort — the atomic create still protects us).
 */
function lockDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && xdg.trim().length > 0) return xdg;
  const home = homedir();
  if (home && home.trim().length > 0) return home;
  return tmpdir();
}

/** Where the single-instance lock lives (one daemon per user is enough). */
export const WATCH_LOCK_PATH = join(lockDir(), 'hl-cockpit-watch.lock');

/** Minimal seam so callers/tests can inject spawn + the lock primitives. */
export interface WatchSpawnDeps {
  /** Spawn the daemon. Returns the child's pid (or null when unknown). */
  spawnDaemon: (intervalSeconds: number) => number | null;
  /**
   * Atomically acquire the lock (O_EXCL create). Returns true when WE created it
   * (we own the spawn). Returns false when it already existed AND the holder is a
   * confirmed-live watch daemon (someone else is monitoring — don't spawn). When
   * the existing lock is stale/dead/unconfirmable, it is replaced and `true` is
   * returned (we err toward monitoring). The pid arg is written into the lock so
   * a placeholder can be recorded before the real child pid is known.
   */
  tryAcquireLock: (placeholderPid: number) => boolean;
  /** Persist the running daemon's pid to the lockfile (best-effort, overwrite). */
  recordPid: (pid: number) => void;
}

export interface EnsureWatchResult {
  /** 'spawned' — a new daemon was started; 'already-running' — one existed. */
  status: 'spawned' | 'already-running';
  /** The daemon pid when we spawned it (null when unknown / already running). */
  pid: number | null;
}

/** Is `pid` a live process? `process.kill(pid, 0)` throws ESRCH when it isn't. */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but we can't signal it (still alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read the lockfile pid, or null when absent/garbage. */
function readLockPid(): number | null {
  if (!existsSync(WATCH_LOCK_PATH)) return null;
  try {
    const pid = Number(readFileSync(WATCH_LOCK_PATH, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * pgrep the watch-daemon pids (processes whose cmdline matches scripts/watch.ts).
 * Returns null when pgrep is UNAVAILABLE (vs. an empty set when it ran but found
 * none) — callers must distinguish "confirmed none" from "couldn't check".
 */
function pgrepWatchPids(): Set<number> | null {
  try {
    const out = execFileSync('pgrep', ['-f', 'scripts/watch.ts'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = out
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    return new Set(pids);
  } catch (err) {
    // Exit code 1 = ran fine, matched nothing (confirmed empty set).
    if ((err as { status?: number }).status === 1) return new Set();
    // Anything else (pgrep missing, ENOENT, EACCES) = couldn't check.
    return null;
  }
}

/**
 * Confirm that `pid` is genuinely OUR watch daemon — alive AND present in the
 * pgrep match set. Returns false when the pid is dead, when it's alive but not a
 * watch process (recycled pid), OR when pgrep couldn't run (can't confirm).
 * NOTE: deliberately conservative — "can't confirm" is treated as "not running"
 * so the caller errs toward (re)spawning a monitor rather than trusting a pid we
 * cannot verify and leaving an open position silently unmonitored.
 */
export function defaultPidIsWatchDaemon(pid: number): boolean {
  if (!isPidAlive(pid)) return false;
  const watchPids = pgrepWatchPids();
  if (watchPids === null) return false; // pgrep unavailable → cannot confirm → not running
  return watchPids.has(pid);
}

/**
 * Atomically acquire the lock. Tries an O_EXCL create (`flag: 'wx'`) so only one
 * concurrent caller can win. On EEXIST, re-validates the holder: if it's a
 * confirmed-live watch daemon we lose (return false, don't spawn). Otherwise the
 * lock is stale/unconfirmable → replace it and win (return true). Also handles a
 * daemon started by hand (`pnpm watch`) that holds no lockfile: if pgrep finds a
 * live watch process even though no lock exists, we treat one as running.
 */
export function defaultTryAcquireLock(placeholderPid: number): boolean {
  // Honor a hand-started daemon that left no lockfile: if pgrep confirms a live
  // watch process, one is already monitoring — don't spawn a duplicate.
  if (!existsSync(WATCH_LOCK_PATH)) {
    const watchPids = pgrepWatchPids();
    if (watchPids !== null && watchPids.size > 0) return false;
  }

  try {
    writeFileSync(WATCH_LOCK_PATH, String(placeholderPid), { encoding: 'utf8', flag: 'wx' });
    return true; // we created it atomically → we own the spawn
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      // Couldn't even create the lock (e.g. EACCES). Err toward monitoring: spawn
      // anyway. The pgrep ownership check still bounds duplicates in practice.
      return true;
    }
  }

  // Lock already exists. Re-validate the holder's liveness + ownership (FIX 3).
  const lockPid = readLockPid();
  if (lockPid !== null && defaultPidIsWatchDaemon(lockPid)) {
    return false; // a confirmed watch daemon owns it → do NOT spawn
  }

  // Stale / dead / recycled-pid / unconfirmable → replace the lock and win.
  // ERR TOWARD MONITORING: a bounded double-daemon beats a silently unmonitored
  // position. Replace via unlink + exclusive re-create so a racing winner is
  // still respected (if someone re-created it first, we lose the create).
  try {
    unlinkSync(WATCH_LOCK_PATH);
  } catch {
    // Already gone — fine.
  }
  try {
    writeFileSync(WATCH_LOCK_PATH, String(placeholderPid), { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch {
    // A racing caller re-created the lock between our unlink and create. They win
    // the spawn; we stand down to avoid a triple-spawn.
    return false;
  }
}

/** Default detached spawn of `pnpm watch --interval <n>`. */
function defaultSpawnDaemon(intervalSeconds: number): number | null {
  const child = nodeSpawn('pnpm', ['watch', '--interval', String(intervalSeconds)], {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
  });
  child.unref();
  return child.pid ?? null;
}

function defaultRecordPid(pid: number): void {
  try {
    // Overwrite the placeholder pid written at acquire time with the real child
    // pid (truncating overwrite, not exclusive — we already hold the lock).
    writeFileSync(WATCH_LOCK_PATH, String(pid), 'utf8');
  } catch {
    // Best-effort: a missing lock just means the pgrep ownership check guards.
  }
}

const defaultDeps: WatchSpawnDeps = {
  spawnDaemon: defaultSpawnDaemon,
  tryAcquireLock: defaultTryAcquireLock,
  recordPid: defaultRecordPid,
};

/**
 * Ensure the watch daemon is running, spawning a detached one if not. Idempotent:
 * a second call while a daemon is alive is a no-op ('already-running'). Safe to
 * call from any skill that opens a position — the monitor comes up the moment the
 * trade executes and survives the skill process exiting.
 *
 * @param intervalSeconds poll cadence passed to `pnpm watch --interval`.
 * @param deps injectable seam (defaults to the real spawn + guards).
 */
export function ensureWatchDaemon(
  intervalSeconds = 20,
  deps: WatchSpawnDeps = defaultDeps,
): EnsureWatchResult {
  // ATOMIC acquire (FIX 2): only the winner of the O_EXCL create spawns. A
  // confirmed-live watch daemon already holding the lock makes this return false
  // (no double-spawn). A stale/recycled/unconfirmable lock is replaced and we
  // win — ERR TOWARD MONITORING (FIX 3): a bounded double-daemon is better than a
  // silently unmonitored open position. Placeholder pid is our own until the
  // child pid is known.
  if (!deps.tryAcquireLock(process.pid)) {
    return { status: 'already-running', pid: null };
  }
  const pid = deps.spawnDaemon(intervalSeconds);
  if (pid !== null) deps.recordPid(pid);
  return { status: 'spawned', pid };
}
