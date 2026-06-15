import { describe, it, expect } from 'vitest';
import { recommendExit, buildExitProposal } from '@/lib/skills/advise-exit-business-logic';
import type { Position } from '@/types/position';
import type { HealthResult } from '@/lib/health/health-engine-types';

function pos(over: Partial<Position> = {}): Position {
  return {
    coin: 'ETH',
    side: 'long',
    sz: 2,
    avgEntryPx: 2000,
    realizedPnlUsd: 0,
    feesPaidUsd: 0,
    ...over,
  };
}

function health(over: Partial<HealthResult> = {}): HealthResult {
  return {
    score: 70,
    pContinuation: 0.6,
    pAdverse: 0.3,
    alerts: [],
    timeframeReads: [],
    ...over,
  };
}

describe('recommendExit', () => {
  it('advises no exit when healthy', () => {
    expect(recommendExit(pos(), health({ score: 75 })).kind).toBe('none');
  });
  it('advises a partial trim in the mid band', () => {
    const r = recommendExit(pos(), health({ score: 50 }));
    expect(r.kind).toBe('partial');
    expect(r.exitSz).toBeCloseTo(1, 6); // half of sz 2
  });
  it('advises a full exit below the floor', () => {
    const r = recommendExit(pos(), health({ score: 20 }));
    expect(r.kind).toBe('full');
    expect(r.exitSz).toBeCloseTo(2, 6);
  });
  it('advises a full exit on a regime flip regardless of score', () => {
    const r = recommendExit(pos(), health({ score: 90, alerts: ['regime-flip-8h'] }));
    expect(r.kind).toBe('full');
  });
  it('returns none for a flat position', () => {
    expect(recommendExit(pos({ side: 'flat', sz: 0 }), health({ score: 10 })).kind).toBe('none');
  });
});

describe('buildExitProposal — reduce-only intent', () => {
  it('builds a reduce-only SELL to close a long', () => {
    const p = buildExitProposal(pos({ side: 'long', sz: 2 }), health({ score: 20 }), {
      clientIntentId: 'exit-1',
      now: 5000,
    });
    expect(p.intent).not.toBeNull();
    expect(p.intent!.reduceOnly).toBe(true);
    expect(p.intent!.side).toBe('sell');
    expect(p.intent!.sz).toBeCloseTo(2, 6);
    expect(p.intent!.createdAt).toBe(5000);
  });
  it('builds a reduce-only BUY to close a short', () => {
    const p = buildExitProposal(pos({ side: 'short', sz: 3 }), health({ score: 20 }), {
      clientIntentId: 'exit-2',
      now: 1,
    });
    expect(p.intent!.side).toBe('buy');
    expect(p.intent!.reduceOnly).toBe(true);
  });
  it('returns a null intent when no exit is advised', () => {
    const p = buildExitProposal(pos(), health({ score: 80 }), { clientIntentId: 'x', now: 1 });
    expect(p.kind).toBe('none');
    expect(p.intent).toBeNull();
  });
});
