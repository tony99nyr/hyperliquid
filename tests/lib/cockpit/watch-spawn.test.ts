/**
 * Pins the auto-monitor-on-fill spawn guard. `ensureWatchDaemon` must:
 *   - spawn the detached watch daemon when none is running (it WON the atomic
 *     lock), and record its pid;
 *   - be a NO-OP when a confirmed-live daemon already holds the lock (the
 *     double-spawn guard / atomic acquire lost — FIX 2);
 *   - re-spawn when the lock is stale/dead OR the lock pid is alive but NOT a
 *     verified watch daemon (recycled pid — FIX 3), erring toward monitoring.
 * The spawn + lock primitives are injected so no real process is launched.
 *
 * Plus real-primitive tests for `defaultTryAcquireLock` (atomic O_EXCL acquire,
 * per-user lock path) and `defaultPidIsWatchDaemon` (pid liveness + pgrep
 * ownership), with `node:child_process` mocked so no real pgrep runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Real-primitive harness: isolate the lockfile to a temp per-user dir and
// --- mock pgrep BEFORE importing the module (WATCH_LOCK_PATH is import-time).
import { mkdtempSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runtimeDir = mkdtempSync(join(tmpdir(), 'hl-watch-test-'));
process.env.XDG_RUNTIME_DIR = runtimeDir;

const execFileSyncMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: unknown[]) => execFileSyncMock(...args) };
});

const {
  ensureWatchDaemon,
  defaultTryAcquireLock,
  defaultPidIsWatchDaemon,
  WATCH_LOCK_PATH,
} = await import('@/lib/cockpit/watch-spawn');
type WatchSpawnDeps = import('@/lib/cockpit/watch-spawn').WatchSpawnDeps;

function makeDeps(over: Partial<WatchSpawnDeps> = {}): WatchSpawnDeps {
  return {
    spawnDaemon: vi.fn().mockReturnValue(9001),
    tryAcquireLock: vi.fn().mockReturnValue(true),
    recordPid: vi.fn(),
    ...over,
  };
}

afterEach(() => {
  try {
    if (existsSync(WATCH_LOCK_PATH)) rmSync(WATCH_LOCK_PATH);
  } catch {
    /* ignore */
  }
});

describe('ensureWatchDaemon (injected seam)', () => {
  it('spawns a detached daemon when it WINS the atomic lock and records its pid', () => {
    const deps = makeDeps();
    const result = ensureWatchDaemon(20, deps);

    expect(result.status).toBe('spawned');
    expect(result.pid).toBe(9001);
    expect(deps.tryAcquireLock).toHaveBeenCalledTimes(1);
    expect(deps.spawnDaemon).toHaveBeenCalledTimes(1);
    expect(deps.spawnDaemon).toHaveBeenCalledWith(20);
    expect(deps.recordPid).toHaveBeenCalledWith(9001);
  });

  it('is a NO-OP when the atomic acquire loses to a confirmed-live daemon (double-spawn guard)', () => {
    const deps = makeDeps({ tryAcquireLock: vi.fn().mockReturnValue(false) });
    const result = ensureWatchDaemon(20, deps);

    expect(result.status).toBe('already-running');
    expect(deps.spawnDaemon).not.toHaveBeenCalled();
    expect(deps.recordPid).not.toHaveBeenCalled();
  });

  it('does not record a pid when the spawn returns null (unknown pid)', () => {
    const deps = makeDeps({ spawnDaemon: vi.fn().mockReturnValue(null) });
    const result = ensureWatchDaemon(20, deps);
    expect(result.status).toBe('spawned');
    expect(result.pid).toBeNull();
    expect(deps.recordPid).not.toHaveBeenCalled();
  });
});

describe('defaultTryAcquireLock — atomic acquire (FIX 2)', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    if (existsSync(WATCH_LOCK_PATH)) rmSync(WATCH_LOCK_PATH);
  });

  it('writes the lockfile to a per-user dir, not world-writable tmpdir', () => {
    expect(WATCH_LOCK_PATH.startsWith(runtimeDir)).toBe(true);
  });

  it('wins when no lock exists and no hand-started daemon (pgrep empty)', () => {
    execFileSyncMock.mockImplementation(() => {
      const e = new Error('no match') as Error & { status: number };
      e.status = 1; // pgrep ran, matched nothing
      throw e;
    });
    expect(defaultTryAcquireLock(process.pid)).toBe(true);
    expect(existsSync(WATCH_LOCK_PATH)).toBe(true);
    expect(readFileSync(WATCH_LOCK_PATH, 'utf8')).toBe(String(process.pid));
  });

  it('LOSES when an existing lock is held by a confirmed-live watch daemon (no second spawn)', () => {
    // Existing lock holding OUR live pid; pgrep confirms that pid IS a watch proc.
    writeFileSync(WATCH_LOCK_PATH, String(process.pid), 'utf8');
    execFileSyncMock.mockImplementation(() => `${process.pid}\n`);
    expect(defaultTryAcquireLock(424242)).toBe(false);
    // Lock unchanged (still the original holder).
    expect(readFileSync(WATCH_LOCK_PATH, 'utf8')).toBe(String(process.pid));
  });

  it('does not spawn when a hand-started watch daemon holds NO lockfile (pgrep match)', () => {
    // No lock on disk, but pgrep reports a live watch process.
    execFileSyncMock.mockImplementation(() => `${process.pid}\n`);
    expect(defaultTryAcquireLock(424242)).toBe(false);
    expect(existsSync(WATCH_LOCK_PATH)).toBe(false);
  });
});

describe('defaultTryAcquireLock — stale / dead / recycled (FIX 3, err toward monitoring)', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    if (existsSync(WATCH_LOCK_PATH)) rmSync(WATCH_LOCK_PATH);
  });

  it('STALE/dead lock pid → replaces the lock and wins (re-spawn proceeds)', () => {
    // A pid that is not alive. pgrep matches nothing.
    writeFileSync(WATCH_LOCK_PATH, '999999', 'utf8');
    execFileSyncMock.mockImplementation(() => {
      const e = new Error('no match') as Error & { status: number };
      e.status = 1;
      throw e;
    });
    expect(defaultTryAcquireLock(555)).toBe(true);
    expect(readFileSync(WATCH_LOCK_PATH, 'utf8')).toBe('555'); // lock replaced
  });

  it('RECYCLED pid alive but NOT a watch process → treated as stale → re-spawns', () => {
    // Lock holds OUR pid (alive) but pgrep returns a DIFFERENT pid set — i.e. our
    // pid is alive yet not a watch daemon (a recycled-pid impostor).
    writeFileSync(WATCH_LOCK_PATH, String(process.pid), 'utf8');
    execFileSyncMock.mockImplementation(() => '123456\n'); // some other pid, not ours
    expect(defaultTryAcquireLock(777)).toBe(true);
    expect(readFileSync(WATCH_LOCK_PATH, 'utf8')).toBe('777'); // lock replaced
  });

  it('pgrep UNAVAILABLE + alive lock pid → cannot confirm → re-spawns (err toward monitoring)', () => {
    writeFileSync(WATCH_LOCK_PATH, String(process.pid), 'utf8');
    execFileSyncMock.mockImplementation(() => {
      throw new Error('pgrep: command not found'); // no .status → unavailable
    });
    expect(defaultTryAcquireLock(888)).toBe(true);
    expect(readFileSync(WATCH_LOCK_PATH, 'utf8')).toBe('888');
  });
});

describe('defaultPidIsWatchDaemon — pid ownership (FIX 3)', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it('false for a dead pid (no pgrep needed)', () => {
    expect(defaultPidIsWatchDaemon(999999)).toBe(false);
  });

  it('true only when the live pid is in the pgrep match set', () => {
    execFileSyncMock.mockImplementation(() => `${process.pid}\n`);
    expect(defaultPidIsWatchDaemon(process.pid)).toBe(true);
  });

  it('false when the live pid is NOT in the pgrep set (recycled pid)', () => {
    execFileSyncMock.mockImplementation(() => '123456\n');
    expect(defaultPidIsWatchDaemon(process.pid)).toBe(false);
  });

  it('false when pgrep is unavailable (cannot confirm → not running)', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('command not found');
    });
    expect(defaultPidIsWatchDaemon(process.pid)).toBe(false);
  });
});
