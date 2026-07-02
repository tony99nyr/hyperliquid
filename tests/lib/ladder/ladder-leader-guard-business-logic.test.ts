import { describe, it, expect } from 'vitest';
import { leaderGuardVerdict, type LeaderGuardInput } from '@/lib/ladder/ladder-leader-guard-business-logic';

const NOW = 1_700_000_000_000;
const ARMED = NOW - 24 * 3_600_000;
const FRESH = NOW - 60_000;

function input(over: Partial<LeaderGuardInput> = {}): LeaderGuardInput {
  return { coin: 'HYPE', side: 'long', armedAtMs: ARMED, positions: [], actions: [], maxFeedAgeMs: 30 * 60_000, now: NOW, ...over };
}

describe('leaderGuardVerdict', () => {
  it('disarms on a close action AFTER arming (strongest signal)', () => {
    const v = leaderGuardVerdict(input({ actions: [{ coin: 'HYPE', kind: 'close', atMs: ARMED + 1000 }] }));
    expect(v.shouldDisarm).toBe(true);
    expect(v.reason).toMatch(/leader-close/);
  });

  it('disarms on a flip action after arming', () => {
    const v = leaderGuardVerdict(input({ actions: [{ coin: 'HYPE', kind: 'flip', atMs: ARMED + 1000 }] }));
    expect(v.shouldDisarm).toBe(true);
    expect(v.reason).toMatch(/flip/);
  });

  it('ignores a close BEFORE arming (old history is not an exit from THIS trade)', () => {
    const v = leaderGuardVerdict(input({
      actions: [{ coin: 'HYPE', kind: 'close', atMs: ARMED - 1000 }],
      positions: [{ coin: 'HYPE', side: 'long', updatedAtMs: FRESH }],
    }));
    expect(v.shouldDisarm).toBe(false);
  });

  it('ignores reduce actions (trimming is not exiting)', () => {
    const v = leaderGuardVerdict(input({
      actions: [{ coin: 'HYPE', kind: 'reduce', atMs: ARMED + 1000 }],
      positions: [{ coin: 'HYPE', side: 'long', updatedAtMs: FRESH }],
    }));
    expect(v.shouldDisarm).toBe(false);
  });

  it('disarms on an opposite-side live position (flipped)', () => {
    const v = leaderGuardVerdict(input({ positions: [{ coin: 'HYPE', side: 'short', updatedAtMs: FRESH }] }));
    expect(v.shouldDisarm).toBe(true);
    expect(v.reason).toMatch(/leader-flip/);
  });

  it('holds while the leader is still in on the same side', () => {
    const v = leaderGuardVerdict(input({ positions: [{ coin: 'HYPE', side: 'long', updatedAtMs: FRESH }] }));
    expect(v.shouldDisarm).toBe(false);
  });

  it('disarms when the coin is absent but other FRESH rows prove coverage (live-book mirror)', () => {
    const v = leaderGuardVerdict(input({ positions: [{ coin: 'ETH', side: 'long', updatedAtMs: FRESH }] }));
    expect(v.shouldDisarm).toBe(true);
    expect(v.reason).toMatch(/leader-exit/);
  });

  it('does NOT disarm on absence when coverage is stale', () => {
    const v = leaderGuardVerdict(input({ positions: [{ coin: 'ETH', side: 'long', updatedAtMs: NOW - 2 * 3_600_000 }] }));
    expect(v.shouldDisarm).toBe(false);
  });

  it('does NOT disarm blind — zero rows is ambiguous (unwatched vs flat-everywhere)', () => {
    const v = leaderGuardVerdict(input({ positions: [], actions: [] }));
    expect(v.shouldDisarm).toBe(false);
  });
});
