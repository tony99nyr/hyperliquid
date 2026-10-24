import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquirePidLock, classifyPidLock } from '../../../scripts/_pid-lock';

const lockIn = async () => path.join(await mkdtemp(path.join(tmpdir(), 'pidlock-')), 'scout.pid');
const exists = (p: string) => access(p).then(() => true, () => false);

describe('scout-watch pid lock classification', () => {
  it('blocks a live process and removes stale or invalid lock contents', () => {
    expect(classifyPidLock('42\n', (pid) => pid === 42)).toBe('held');
    expect(classifyPidLock('42\n', () => false)).toBe('stale');
    expect(classifyPidLock('not-a-pid', () => false)).toBe('invalid');
  });
});

describe('acquirePidLock', () => {
  it('lets exactly one of two simultaneous starts win', async () => {
    const lockPath = await lockIn();
    const results = await Promise.allSettled([acquirePidLock(lockPath), acquirePidLock(lockPath)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await readFile(lockPath, 'utf8')).trim()).toBe(String(process.pid));
  });

  it('replaces a stale lock from a dead pid and releases cleanly', async () => {
    const lockPath = await lockIn();
    await writeFile(lockPath, '999999999');
    const release = await acquirePidLock(lockPath);
    expect((await readFile(lockPath, 'utf8')).trim()).toBe(String(process.pid));
    await release();
    expect(await exists(lockPath)).toBe(false);
  });

  it('treats a fresh unreadable lock as held (another starter may be writing it)', async () => {
    const lockPath = await lockIn();
    await writeFile(lockPath, '');
    await expect(acquirePidLock(lockPath)).rejects.toThrow(/being written/);
    expect(await exists(lockPath)).toBe(true);
  });
});
