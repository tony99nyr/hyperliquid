/**
 * Pins the auto-monitor-on-fill spawn guard. `ensureWatchDaemon` must:
 *   - spawn the detached watch daemon when none is running, and record its pid;
 *   - be a NO-OP when a daemon is already running (the double-spawn guard).
 * The spawn + liveness checks are injected so no real process is launched.
 */

import { describe, it, expect, vi } from 'vitest';
import { ensureWatchDaemon, type WatchSpawnDeps } from '@/lib/cockpit/watch-spawn';

function makeDeps(over: Partial<WatchSpawnDeps> = {}): WatchSpawnDeps {
  return {
    spawnDaemon: vi.fn().mockReturnValue(9001),
    isDaemonRunning: vi.fn().mockReturnValue(false),
    recordPid: vi.fn(),
    ...over,
  };
}

describe('ensureWatchDaemon', () => {
  it('spawns a detached daemon when none is running and records its pid', () => {
    const deps = makeDeps();
    const result = ensureWatchDaemon(20, deps);

    expect(result.status).toBe('spawned');
    expect(result.pid).toBe(9001);
    expect(deps.spawnDaemon).toHaveBeenCalledTimes(1);
    expect(deps.spawnDaemon).toHaveBeenCalledWith(20);
    expect(deps.recordPid).toHaveBeenCalledWith(9001);
  });

  it('is a NO-OP when a daemon is already running (double-spawn guard)', () => {
    const deps = makeDeps({ isDaemonRunning: vi.fn().mockReturnValue(true) });
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
