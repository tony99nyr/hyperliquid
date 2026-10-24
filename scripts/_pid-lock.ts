import { open, readFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';

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

export async function acquirePidLock(lockPath: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => {
        try {
          const contents = await readFile(lockPath, 'utf8');
          if (Number(contents.trim()) === process.pid) await unlink(lockPath);
        } catch { /* lock already removed */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const contents = await readFile(lockPath, 'utf8').catch(() => '');
      if (classifyPidLock(contents, pidIsAlive) === 'held') {
        throw new Error(`scout-watch already runs with pid ${contents.trim()}`);
      }
      await unlink(lockPath).catch(() => undefined);
    }
  }
  throw new Error('Could not acquire scout-watch pid lock after stale-lock cleanup.');
}
