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
 * DOUBLE-SPAWN GUARD (two layers):
 *   1. A lockfile (`<tmp>/hl-cockpit-watch.lock`) holding the running daemon's
 *      pid. If the file exists AND that pid is alive, we DON'T spawn again.
 *   2. A `pgrep`-style scan for an existing `scripts/watch.ts` process as a
 *      belt-and-suspenders check (covers a daemon started manually via
 *      `pnpm watch`, which wouldn't have written our lockfile).
 *
 * The lockfile is best-effort: a stale lock (pid not alive) is reclaimed. We do
 * NOT delete it on the daemon's exit (the daemon doesn't know about it) — the
 * stale-pid check handles that on the next attempt.
 *
 * The spawn fn is injectable so tests can assert "spawn was/ wasn't invoked"
 * without launching a real process.
 */

import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Where the single-instance lock lives (one daemon per machine is enough). */
export const WATCH_LOCK_PATH = join(tmpdir(), 'hl-cockpit-watch.lock');

/** Minimal seam so callers/tests can inject spawn + the liveness checks. */
export interface WatchSpawnDeps {
  /** Spawn the daemon. Returns the child's pid (or null when unknown). */
  spawnDaemon: (intervalSeconds: number) => number | null;
  /** True when a daemon is already running (lockfile pid alive OR pgrep match). */
  isDaemonRunning: () => boolean;
  /** Persist the running daemon's pid to the lockfile (best-effort). */
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

/** Default liveness check: lockfile pid alive, else a pgrep scan for watch.ts. */
function defaultIsDaemonRunning(): boolean {
  const lockPid = readLockPid();
  if (lockPid !== null && isPidAlive(lockPid)) return true;

  // Belt-and-suspenders: a daemon started by hand (`pnpm watch`) won't have our
  // lockfile. pgrep for the watch script. Fail-soft: if pgrep is unavailable we
  // simply rely on the lockfile check above.
  try {
    const out = execFileSync('pgrep', ['-f', 'scripts/watch.ts'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
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
    writeFileSync(WATCH_LOCK_PATH, String(pid), 'utf8');
  } catch {
    // Best-effort: a missing lock just means the pgrep fallback does the guarding.
  }
}

const defaultDeps: WatchSpawnDeps = {
  spawnDaemon: defaultSpawnDaemon,
  isDaemonRunning: defaultIsDaemonRunning,
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
  if (deps.isDaemonRunning()) {
    return { status: 'already-running', pid: null };
  }
  const pid = deps.spawnDaemon(intervalSeconds);
  if (pid !== null) deps.recordPid(pid);
  return { status: 'spawned', pid };
}
