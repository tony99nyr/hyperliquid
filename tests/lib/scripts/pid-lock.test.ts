import { describe, expect, it } from 'vitest';
import { classifyPidLock } from '../../../scripts/_pid-lock';

describe('scout-watch pid lock classification', () => {
  it('blocks a live process and removes stale or invalid lock contents', () => {
    expect(classifyPidLock('42\n', (pid) => pid === 42)).toBe('held');
    expect(classifyPidLock('42\n', () => false)).toBe('stale');
    expect(classifyPidLock('not-a-pid', () => false)).toBe('invalid');
  });
});
