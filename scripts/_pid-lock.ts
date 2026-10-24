import { link, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';

export type LockStatus = 'held' | 'stale' | 'invalid';

export function classifyPidLock(contents: string, isAlive: (pid: number) => boolean): LockStatus {
  const pid = Number(contents.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'invalid';
  return isAlive(pid) ? 'held' : 'stale';
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** An unreadable lock younger than this may still be in flight; treat it as held. */
const INVALID_LOCK_GRACE_MS = 5_000;

/**
 * Single-instance lock. The pid is written to a private temp file first and then
 * hard-linked into place, so the lock file is never visible half-written and two
 * simultaneous starts cannot both win (link fails with EEXIST for the loser).
 * A stale lock is moved aside atomically with rename before removal; if the file
 * moved aside turns out to be a fresh lock from another starter, it is put back.
 */
export async function acquirePidLock(lockPath: string): Promise<() => Promise<void>> {
  const tmpPath = `${lockPath}.${process.pid}.tmp`;
  await writeFile(tmpPath, String(process.pid), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await link(tmpPath, lockPath);
        return async () => {
          try {
            const contents = await readFile(lockPath, 'utf8');
            if (Number(contents.trim()) === process.pid) await unlink(lockPath);
          } catch { /* lock already removed */ }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const observed = await readFile(lockPath, 'utf8').catch(() => '');
      const status = classifyPidLock(observed, pidIsAlive);
      if (status === 'held') throw new Error(`scout-watch already runs with pid ${observed.trim()}`);
      if (status === 'invalid') {
        const ageMs = await stat(lockPath).then((s) => Date.now() - s.mtimeMs).catch(() => Infinity);
        if (ageMs < INVALID_LOCK_GRACE_MS) throw new Error('scout-watch lock is being written by another starter');
      }
      const gravePath = `${lockPath}.${process.pid}.stale`;
      try {
        await rename(lockPath, gravePath);
      } catch {
        continue; // someone else moved or replaced it; retry the link
      }
      const moved = await readFile(gravePath, 'utf8').catch(() => '');
      if (moved.trim() !== observed.trim()) {
        // We moved a fresh lock that another starter created after our read. Put it back.
        await link(gravePath, lockPath).catch(() => undefined);
        await unlink(gravePath).catch(() => undefined);
        throw new Error(`scout-watch already runs with pid ${moved.trim()}`);
      }
      await unlink(gravePath).catch(() => undefined);
    }
    throw new Error('Could not acquire scout-watch pid lock after stale-lock cleanup.');
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }
}
