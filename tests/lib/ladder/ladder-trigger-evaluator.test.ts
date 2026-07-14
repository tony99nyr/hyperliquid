/**
 * Pins the PURE, authority-free ladder trigger evaluator. The load-bearing property
 * is FAIL-CLOSED: a stale/missing/malformed snapshot NEVER reports conditionMet=true.
 * Price/volume/funding/indicator kinds each have a met + not-met + fail-closed case.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateRungTrigger,
  evaluateLadderRungs,
  type RungMarketSnapshot,
} from '@/lib/ladder/ladder-trigger-evaluator';
import type { LadderRung, RungTriggerKind, RungStatus } from '@/lib/ladder/ladder-types';

function rung(over: Partial<LadderRung> = {}): LadderRung {
  return {
    id: 'r1',
    ladderId: 'L1',
    seq: 1,
    coin: 'ETH',
    side: 'long',
    action: 'open',
    triggerKind: 'price_above' as RungTriggerKind,
    triggerPx: 2000,
    triggerMeta: null,
    sizeCoins: null,
    reduceFrac: null,
    riskUsd: 50,
    stopFrac: 0.04,
    leverage: 5,
    stopPx: 1920,
    targetPx: 2200,
    status: 'pending' as RungStatus,
    cloid: 'L1:r1',
    ...over,
  };
}

const snap = (over: Partial<RungMarketSnapshot> = {}): RungMarketSnapshot => ({ coin: 'ETH', completedClose: 2000, ...over });

describe('evaluateRungTrigger — fail-closed guards', () => {
  it('no snapshot → not met', () => {
    expect(evaluateRungTrigger(rung(), undefined).conditionMet).toBe(false);
  });
  it('stale snapshot → not met even when the price would otherwise cross', () => {
    const res = evaluateRungTrigger(rung({ triggerPx: 1900 }), snap({ completedClose: 2000, stale: true }));
    expect(res.conditionMet).toBe(false);
    expect(res.reason).toMatch(/stale/);
  });
  it('price trigger with no completed close → not met', () => {
    expect(evaluateRungTrigger(rung(), snap({ completedClose: 0 })).conditionMet).toBe(false);
  });
  it('price trigger missing triggerPx → not met', () => {
    expect(evaluateRungTrigger(rung({ triggerPx: null }), snap()).conditionMet).toBe(false);
  });
  it('an Infinity completed close fails closed (does not pass `> 0`)', () => {
    const res = evaluateRungTrigger(rung({ triggerPx: 1950 }), snap({ completedClose: Infinity }));
    expect(res.conditionMet).toBe(false);
    expect(res.reason).toMatch(/finite/);
  });
  it('a snapshot for the WRONG coin fails closed (mis-keyed daemon guard)', () => {
    const res = evaluateRungTrigger(rung({ coin: 'ETH', triggerPx: 1950 }), { coin: 'BTC', completedClose: 60000 });
    expect(res.conditionMet).toBe(false);
    expect(res.reason).toMatch(/≠|snapshot coin/);
  });
});

describe('evaluateRungTrigger — price_above / price_below', () => {
  it('price_above: met when completed close ≥ level', () => {
    expect(evaluateRungTrigger(rung({ triggerPx: 1950 }), snap({ completedClose: 2000 })).conditionMet).toBe(true);
  });
  it('price_above: not met when close is below the level', () => {
    expect(evaluateRungTrigger(rung({ triggerPx: 2050 }), snap({ completedClose: 2000 })).conditionMet).toBe(false);
  });
  it('price_below: met when completed close ≤ level', () => {
    const r = rung({ triggerKind: 'price_below', triggerPx: 1900, side: 'short' });
    expect(evaluateRungTrigger(r, snap({ completedClose: 1880 })).conditionMet).toBe(true);
    expect(evaluateRungTrigger(r, snap({ completedClose: 1920 })).conditionMet).toBe(false);
  });
});

describe('evaluateRungTrigger — volume', () => {
  const vr = rung({ triggerKind: 'volume', triggerPx: null, triggerMeta: { minVolume: 1000 } });
  it('met when completed volume ≥ minVolume', () => {
    expect(evaluateRungTrigger(vr, snap({ completedVolume: 1500 })).conditionMet).toBe(true);
  });
  it('not met when below the floor', () => {
    expect(evaluateRungTrigger(vr, snap({ completedVolume: 500 })).conditionMet).toBe(false);
  });
  it('fail-closed when the snapshot has no volume', () => {
    expect(evaluateRungTrigger(vr, snap({})).conditionMet).toBe(false);
  });
  it('fail-closed when minVolume is missing', () => {
    expect(evaluateRungTrigger(rung({ triggerKind: 'volume', triggerMeta: {} }), snap({ completedVolume: 9999 })).conditionMet).toBe(false);
  });
});

describe('evaluateRungTrigger — funding', () => {
  it('above: met when funding ≥ threshold', () => {
    const r = rung({ triggerKind: 'funding', triggerMeta: { op: 'above', fundingRate: 0.0001 } });
    expect(evaluateRungTrigger(r, snap({ fundingRate: 0.0002 })).conditionMet).toBe(true);
    expect(evaluateRungTrigger(r, snap({ fundingRate: 0.00005 })).conditionMet).toBe(false);
  });
  it('below: met when funding ≤ threshold (e.g. negative funding pays shorts)', () => {
    const r = rung({ triggerKind: 'funding', triggerMeta: { op: 'below', fundingRate: -0.0001 } });
    expect(evaluateRungTrigger(r, snap({ fundingRate: -0.0003 })).conditionMet).toBe(true);
  });
  it('fail-closed when funding rate or op is missing', () => {
    expect(evaluateRungTrigger(rung({ triggerKind: 'funding', triggerMeta: { op: 'above' } }), snap({ fundingRate: 1 })).conditionMet).toBe(false);
    expect(evaluateRungTrigger(rung({ triggerKind: 'funding', triggerMeta: { op: 'above', fundingRate: 0 } }), snap({})).conditionMet).toBe(false);
  });
});

describe('evaluateRungTrigger — indicator', () => {
  // Indicator triggers are EXIT-ONLY — the fixture must be a reduce rung (an open/add
  // indicator rung now fails closed by design; pinned below).
  const ir = rung({ action: 'reduce', triggerKind: 'indicator', triggerMeta: { op: 'above', indicatorName: 'rsi14', indicatorValue: 70 } });
  it('met when the named indicator crosses the threshold', () => {
    expect(evaluateRungTrigger(ir, snap({ indicators: { rsi14: 72 } })).conditionMet).toBe(true);
    expect(evaluateRungTrigger(ir, snap({ indicators: { rsi14: 65 } })).conditionMet).toBe(false);
  });
  it('fail-closed when the indicator is absent from the snapshot', () => {
    expect(evaluateRungTrigger(ir, snap({ indicators: { macd: 1 } })).conditionMet).toBe(false);
  });

  it('fail-closed for indicator triggers on exposure-INCREASING rungs (exit-only, in depth)', () => {
    const openRung = rung({ action: 'open', triggerKind: 'indicator', triggerMeta: { op: 'above', indicatorName: 'rsi14', indicatorValue: 70 } });
    expect(evaluateRungTrigger(openRung, snap({ indicators: { rsi14: 99 } })).conditionMet).toBe(false);
    const addRung = rung({ action: 'add', triggerKind: 'indicator', triggerMeta: { op: 'above', indicatorName: 'rsi14', indicatorValue: 70 } });
    expect(evaluateRungTrigger(addRung, snap({ indicators: { rsi14: 99 } })).conditionMet).toBe(false);
  });

  describe('floorPx gate (momentum exits: "only beyond this price")', () => {
    const stall = (floorPx?: number) =>
      rung({
        side: 'long',
        action: 'reduce',
        triggerKind: 'indicator',
        triggerPx: null,
        triggerMeta: { op: 'above', indicatorName: 'momentum-stall-long', indicatorValue: 2, ...(floorPx !== undefined ? { floorPx } : {}) },
      });

    it('fires only when the indicator crosses AND the close is beyond the floor', () => {
      const indicators = { 'momentum-stall-long': 2 };
      // Below the floor: stall present but gated.
      expect(evaluateRungTrigger(stall(2050), snap({ completedClose: 2000, indicators })).conditionMet).toBe(false);
      // Beyond the floor: fires.
      expect(evaluateRungTrigger(stall(2050), snap({ completedClose: 2060, indicators })).conditionMet).toBe(true);
      // No floor: indicator alone decides.
      expect(evaluateRungTrigger(stall(), snap({ completedClose: 1900, indicators })).conditionMet).toBe(true);
    });

    it('short side: floor is a CEILING (close must be at or below it)', () => {
      const shortStall = rung({
        side: 'short',
        action: 'reduce',
        triggerKind: 'indicator',
        triggerPx: null,
        triggerMeta: { op: 'above', indicatorName: 'momentum-stall-short', indicatorValue: 2, floorPx: 1950 },
      });
      const indicators = { 'momentum-stall-short': 3 };
      expect(evaluateRungTrigger(shortStall, snap({ completedClose: 1940, indicators })).conditionMet).toBe(true);
      expect(evaluateRungTrigger(shortStall, snap({ completedClose: 1990, indicators })).conditionMet).toBe(false);
    });

    it('fail-closed on an invalid floor or a missing completed close', () => {
      expect(evaluateRungTrigger(stall(NaN), snap({ completedClose: 2000, indicators: { 'momentum-stall-long': 3 } })).conditionMet).toBe(false);
      expect(evaluateRungTrigger(stall(2050), snap({ completedClose: 0, indicators: { 'momentum-stall-long': 3 } })).conditionMet).toBe(false);
    });
  });
});

describe('evaluateLadderRungs — only PENDING rungs, snapshot-by-coin', () => {
  it('skips non-pending rungs and matches snapshots case-insensitively', () => {
    const rungs: LadderRung[] = [
      rung({ id: 'a', coin: 'ETH', triggerPx: 1950, status: 'pending' }),
      rung({ id: 'b', coin: 'BTC', triggerKind: 'price_below', triggerPx: 60000, status: 'pending' }),
      rung({ id: 'c', coin: 'ETH', triggerPx: 1950, status: 'fired' }), // already fired → ignored
    ];
    const snaps: Record<string, RungMarketSnapshot> = {
      ETH: { coin: 'ETH', completedClose: 2000 },
      BTC: { coin: 'BTC', completedClose: 59000 },
    };
    const results = evaluateLadderRungs(rungs, snaps);
    expect(results).toHaveLength(2); // the 'fired' rung is excluded
    expect(results.find((r) => r.rungId === 'a')?.conditionMet).toBe(true); // ETH 2000 ≥ 1950
    expect(results.find((r) => r.rungId === 'b')?.conditionMet).toBe(true); // BTC 59000 ≤ 60000
  });

  it('a pending rung with no snapshot for its coin fails closed', () => {
    const results = evaluateLadderRungs([rung({ id: 'a', coin: 'SOL' })], {});
    expect(results[0].conditionMet).toBe(false);
  });

  it('normalizes snapshot keys to upper — a lowercase-keyed snapshot still matches', () => {
    const results = evaluateLadderRungs(
      [rung({ id: 'a', coin: 'ETH', triggerPx: 1950 })],
      { eth: { coin: 'eth', completedClose: 2000 } },
    );
    expect(results[0].conditionMet).toBe(true);
  });
});
