import { describe, it, expect } from 'vitest';
import { computeLeaderDerisk, isMassDerisking, type DeriskAction } from '@/lib/rubric/leader-derisk-business-logic';

const a = (coin: string, kind: DeriskAction['kind'], sizeDelta: number, entryPx = 100): DeriskAction => ({ coin, kind, sizeDelta, entryPx });

describe('computeLeaderDerisk', () => {
  it('all reduces/closes → derisk ~1; all opens/adds → ~0', () => {
    const fleeing = computeLeaderDerisk([a('ETH', 'reduce', -5), a('ETH', 'close', -10)]);
    expect(fleeing.ETH).toBeCloseTo(1, 6);
    const buying = computeLeaderDerisk([a('ETH', 'open', 5), a('ETH', 'add', 10)]);
    expect(buying.ETH).toBeCloseTo(0, 6);
  });

  it('mixed flow → USD-weighted ratio in (0,1)', () => {
    // 30 USD leaving vs 10 USD entering → 0.75
    const r = computeLeaderDerisk([a('ETH', 'reduce', -3), a('ETH', 'add', 1)]);
    expect(r.ETH).toBeCloseTo(0.75, 6);
  });

  it('weights by price (entryPx) not raw size', () => {
    // 1 BTC reduce @60000 vs 1 BTC add @60000 → 0.5
    const r = computeLeaderDerisk([a('BTC', 'reduce', -1, 60000), a('BTC', 'add', 1, 60000)]);
    expect(r.BTC).toBeCloseTo(0.5, 6);
  });

  it('per-coin independence + skips zero/non-finite size', () => {
    const r = computeLeaderDerisk([a('ETH', 'close', -2), a('SOL', 'add', 4), a('ETH', 'reduce', 0)]);
    expect(r.ETH).toBeCloseTo(1, 6);
    expect(r.SOL).toBeCloseTo(0, 6);
  });

  it('flip counts as risk-off (the closed leg fleeing)', () => {
    expect(computeLeaderDerisk([a('ETH', 'flip', -3)]).ETH).toBeCloseTo(1, 6);
  });
});

describe('isMassDerisking', () => {
  it('fires at/above threshold; not below or on null', () => {
    expect(isMassDerisking(0.7, 0.65)).toBe(true);
    expect(isMassDerisking(0.6, 0.65)).toBe(false);
    expect(isMassDerisking(null, 0.65)).toBe(false);
  });
});
