import { describe, expect, it } from 'vitest';
import { backoffDelay, isFresh } from '../../../scripts/_study-io';
import { firstDailyGap, mergeWindows, snapFunding } from '../../../scripts/_htf-replay-data';

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe('study I/O helpers', () => {
  it('backs off exponentially, honours Retry-After and caps the wait', () => {
    expect(backoffDelay(0, 1000, 60_000, null, 0)).toBe(1000);
    expect(backoffDelay(3, 1000, 60_000, null, 0)).toBe(8000);
    expect(backoffDelay(0, 1000, 60_000, '20', 0)).toBe(20_000);
    expect(backoffDelay(10, 1000, 60_000, null, 0)).toBe(60_000);
  });

  it('treats a cache entry as fresh only inside its maximum age', () => {
    expect(isFresh(1000, undefined, 9_999_999)).toBe(true);
    expect(isFresh(1000, 500, 1400)).toBe(true);
    expect(isFresh(1000, 500, 1600)).toBe(false);
  });

  it('snaps jittered funding times to the nominal hour and drops duplicates', () => {
    const rows = snapFunding([{ time: 3 * HOUR + 48, fundingHourly: 1 }, { time: 4 * HOUR - 30, fundingHourly: 2 }, { time: 5 * HOUR + 1, fundingHourly: 3 }]);
    expect(rows.map((r) => r.time)).toEqual([3 * HOUR, 4 * HOUR, 5 * HOUR]);
  });

  it('finds the first daily gap and merges nearby windows', () => {
    const bar = (time: number) => ({ time, open: 1, high: 1, low: 1, close: 1 });
    expect(firstDailyGap([bar(0), bar(DAY), bar(2 * DAY)])).toBe(-1);
    expect(firstDailyGap([bar(0), bar(DAY), bar(3 * DAY)])).toBe(2);
    expect(mergeWindows([[0, 2 * DAY], [3 * DAY, 4 * DAY], [20 * DAY, 21 * DAY]])).toEqual([[0, 4 * DAY], [20 * DAY, 21 * DAY]]);
  });
});
