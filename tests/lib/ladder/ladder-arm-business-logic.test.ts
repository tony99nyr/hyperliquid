/**
 * Pins the PURE arm-readiness validation: expiry/caps gating, per-rung validity (trigger
 * params, sizing, stop on the loss side, leverage band), and the PYRAMIDING guardrails
 * (adds decrease size; the per-coin stop only tightens). Empty warnings ⇒ safe to arm.
 */

import { describe, it, expect } from 'vitest';
import { validateLadderForArm, resolveArmRung, ladderArmConfirmPhrase, type ArmRung, type ValidateLadderInput } from '@/lib/ladder/ladder-arm-business-logic';
import type { LadderRung } from '@/lib/ladder/ladder-types';

const NOW = 1_700_000_000_000;
const coinMax = () => 25; // ETH/BTC ~25× for the tests

function rung(over: Partial<ArmRung> = {}): ArmRung {
  return {
    seq: 1,
    coin: 'ETH',
    side: 'long',
    action: 'open',
    triggerKind: 'price_above',
    triggerPx: 2000,
    triggerMeta: null,
    entryPx: 2000,
    sizeCoins: 1,
    leverage: 5,
    stopPx: 1900,
    ...over,
  };
}

function input(over: Partial<ValidateLadderInput> = {}): ValidateLadderInput {
  return {
    title: 'Breakout ladder',
    expiresAtMs: NOW + 60 * 60 * 1000,
    caps: { maxTotalNotionalUsd: 100_000, maxTotalLossUsd: 5_000 },
    rungs: [rung()],
    now: NOW,
    coinMaxLeverage: coinMax,
    ...over,
  };
}

describe('validateLadderForArm — gating', () => {
  it('a clean single-rung ladder arms with no warnings', () => {
    expect(validateLadderForArm(input()).warnings).toHaveLength(0);
  });
  it('blocks a past expiry', () => {
    expect(validateLadderForArm(input({ expiresAtMs: NOW - 1 })).warnings.some((w) => /expiry/i.test(w))).toBe(true);
  });
  it('requires an expiry', () => {
    expect(validateLadderForArm(input({ expiresAtMs: null })).warnings.some((w) => /expiry/i.test(w))).toBe(true);
  });
  it('requires both caps', () => {
    const w = validateLadderForArm(input({ caps: { maxTotalNotionalUsd: null, maxTotalLossUsd: null } })).warnings;
    expect(w.some((x) => /notional cap/i.test(x))).toBe(true);
    expect(w.some((x) => /loss cap/i.test(x))).toBe(true);
  });
  it('requires a title + at least one rung', () => {
    const w = validateLadderForArm(input({ title: '  ', rungs: [] })).warnings;
    expect(w.some((x) => /title/i.test(x))).toBe(true);
    expect(w.some((x) => /at least one rung/i.test(x))).toBe(true);
  });
});

describe('validateLadderForArm — per-rung validity', () => {
  it('flags a price trigger with no level', () => {
    expect(validateLadderForArm(input({ rungs: [rung({ triggerPx: null })] })).warnings.some((w) => /triggerPx/i.test(w))).toBe(true);
  });
  it('flags an open rung with no stop', () => {
    expect(validateLadderForArm(input({ rungs: [rung({ stopPx: null })] })).warnings.some((w) => /protective stop/i.test(w))).toBe(true);
  });
  it('flags a stop on the WRONG side (long stop above entry)', () => {
    expect(validateLadderForArm(input({ rungs: [rung({ stopPx: 2100 })] })).warnings.some((w) => /loss side/i.test(w))).toBe(true);
  });
  it('flags leverage over the coin max', () => {
    expect(validateLadderForArm(input({ rungs: [rung({ leverage: 50 })] })).warnings.some((w) => /exceeds/i.test(w))).toBe(true);
  });
  it('rejects funding/indicator triggers (the watcher only evaluates price/volume)', () => {
    const fr = rung({ triggerKind: 'funding', triggerPx: null, triggerMeta: { op: 'above', fundingRate: 0.0001 } });
    expect(validateLadderForArm(input({ rungs: [fr] })).warnings.some((w) => /not yet evaluated|funding/i.test(w))).toBe(true);
    const ir = rung({ triggerKind: 'indicator', triggerPx: null, triggerMeta: { op: 'above', indicatorName: 'rsi14', indicatorValue: 70 } });
    expect(validateLadderForArm(input({ rungs: [ir] })).warnings.some((w) => /not yet evaluated|indicator/i.test(w))).toBe(true);
  });

  it('flags a volume trigger missing minVolume', () => {
    const r = rung({ triggerKind: 'volume', triggerPx: null, triggerMeta: {} });
    expect(validateLadderForArm(input({ rungs: [r] })).warnings.some((w) => /minVolume/i.test(w))).toBe(true);
  });
});

describe('validateLadderForArm — pyramiding guardrails (§2)', () => {
  const base = rung({ seq: 1, action: 'open', entryPx: 2000, sizeCoins: 1, stopPx: 1900, triggerPx: 2000 });

  it('accepts a decreasing-size, stop-tightening pyramid', () => {
    const rungs = [
      base,
      rung({ seq: 2, action: 'add', entryPx: 2100, sizeCoins: 0.5, stopPx: 1950, triggerPx: 2100 }),
      rung({ seq: 3, action: 'add', entryPx: 2200, sizeCoins: 0.25, stopPx: 2050, triggerPx: 2200 }),
    ];
    expect(validateLadderForArm(input({ rungs })).warnings).toHaveLength(0);
  });

  it('rejects an add that INCREASES size (averaging-up beyond the base)', () => {
    const rungs = [base, rung({ seq: 2, action: 'add', entryPx: 2100, sizeCoins: 2, stopPx: 1950, triggerPx: 2100 })];
    expect(validateLadderForArm(input({ rungs })).warnings.some((w) => /DECREASE/i.test(w))).toBe(true);
  });

  it('rejects a LOOSENING stop on a later rung', () => {
    // long: a later stop BELOW the prior stop loosens (moves away from the mark).
    const rungs = [base, rung({ seq: 2, action: 'add', entryPx: 2100, sizeCoins: 0.5, stopPx: 1850, triggerPx: 2100 })];
    expect(validateLadderForArm(input({ rungs })).warnings.some((w) => /TIGHTEN/i.test(w))).toBe(true);
  });

  it('short pyramid: stop must FALL to tighten', () => {
    const s1 = rung({ seq: 1, side: 'short', action: 'open', triggerKind: 'price_below', entryPx: 2000, sizeCoins: 1, stopPx: 2100, triggerPx: 2000 });
    const s2loose = rung({ seq: 2, side: 'short', action: 'add', triggerKind: 'price_below', entryPx: 1900, sizeCoins: 0.5, stopPx: 2150, triggerPx: 1900 });
    expect(validateLadderForArm(input({ rungs: [s1, s2loose] })).warnings.some((w) => /TIGHTEN/i.test(w))).toBe(true);
  });

  it('catches a NON-MONOTONE middle dip across 3 rungs (size up then down, stop loosen mid)', () => {
    const rungs = [
      base, // seq 1, size 1, stop 1900
      rung({ seq: 2, action: 'add', entryPx: 2100, sizeCoins: 0.5, stopPx: 1850, triggerPx: 2100 }), // stop loosens (1850 < 1900)
      rung({ seq: 3, action: 'add', entryPx: 2200, sizeCoins: 0.75, stopPx: 2050, triggerPx: 2200 }), // size 0.75 > prior 0.5
    ];
    const w = validateLadderForArm(input({ rungs })).warnings;
    expect(w.some((x) => /TIGHTEN/i.test(x))).toBe(true); // rung 2 loosened
    expect(w.some((x) => /DECREASE/i.test(x))).toBe(true); // rung 3 grew vs rung 2
  });

  it('flags opposing-side rungs on one coin (HL nets per coin)', () => {
    const rungs = [
      rung({ seq: 1, side: 'long', action: 'open', triggerKind: 'price_above', entryPx: 2000, sizeCoins: 1, stopPx: 1900, triggerPx: 2000 }),
      rung({ seq: 2, side: 'short', action: 'open', triggerKind: 'price_below', entryPx: 2000, sizeCoins: 1, stopPx: 2100, triggerPx: 2000 }),
    ];
    expect(validateLadderForArm(input({ rungs })).warnings.some((w) => /both long and short/i.test(w))).toBe(true);
  });
});

function dbRung(over: Partial<LadderRung> = {}): LadderRung {
  return {
    id: 'r1', ladderId: 'L1', seq: 1, coin: 'ETH', side: 'long', action: 'open',
    triggerKind: 'price_above', triggerPx: 2000, triggerMeta: null,
    sizeCoins: null, reduceFrac: null, riskUsd: null, stopFrac: null, leverage: 5, stopPx: null, targetPx: null,
    status: 'pending', cloid: null, ...over,
  };
}

describe('resolveArmRung — entry/size/stop resolution', () => {
  it('price rung: entry = trigger; risk-sizes when no explicit size; derives the stop from stopFrac', () => {
    const r = resolveArmRung(dbRung({ triggerPx: 2000, riskUsd: 50, stopFrac: 0.04, sizeCoins: null, stopPx: null }));
    expect(r.entryPx).toBe(2000);
    expect(r.sizeCoins).toBeCloseTo(50 / (2000 * 0.04), 6); // 0.625
    expect(r.stopPx).toBeCloseTo(2000 * (1 - 0.04), 6); // long stop below
  });
  it('IGNORES an explicit size on an OPEN/ADD rung — risk-sized to match the fire path', () => {
    // An open/add rung with an explicit sizeCoins but risk inputs present must size by
    // RISK (what fireOpenOrAdd does), so arm-consent == what fires. The explicit 1.5 is dropped.
    const r = resolveArmRung(dbRung({ action: 'open', sizeCoins: 1.5, riskUsd: 50, stopFrac: 0.04, triggerPx: 2000 }));
    expect(r.sizeCoins).toBeCloseTo(50 / (2000 * 0.04), 6); // 0.625, NOT 1.5
  });
  it('KEEPS an explicit size on a REDUCE/CLOSE rung (the trim amount)', () => {
    const r = resolveArmRung(dbRung({ action: 'reduce', sizeCoins: 1.5, stopPx: 1850 }));
    expect(r.sizeCoins).toBe(1.5);
  });
  it('short stop derives ABOVE entry', () => {
    const r = resolveArmRung(dbRung({ side: 'short', triggerKind: 'price_below', triggerPx: 2000, riskUsd: 50, stopFrac: 0.04 }));
    expect(r.stopPx).toBeCloseTo(2000 * 1.04, 6);
  });
  it('non-price trigger keeps entry null (sized at fire against the live mark)', () => {
    const r = resolveArmRung(dbRung({ triggerKind: 'volume', triggerPx: null, triggerMeta: { minVolume: 1000 }, sizeCoins: 1 }));
    expect(r.entryPx).toBeNull();
  });
});

describe('ladderArmConfirmPhrase', () => {
  it('is "arm <id8>" lowercased', () => {
    expect(ladderArmConfirmPhrase({ id: 'ABCD1234-5678-90ef' })).toBe('arm abcd1234');
  });
});

describe('validateLadderForArm — caps via the risk read', () => {
  it('surfaces a worst-case-loss breach from the risk read', () => {
    // entry 2000, size 5, stop 1900 → worst (2000-1710)*5 = 1450 > cap 1000.
    const r = rung({ sizeCoins: 5, stopPx: 1900 });
    const res = validateLadderForArm(input({ rungs: [r], caps: { maxTotalNotionalUsd: 1_000_000, maxTotalLossUsd: 1_000 } }));
    expect(res.warnings.some((w) => /worst-case/i.test(w))).toBe(true);
    expect(res.risk.aggregateWorstCaseLossUsd).toBeCloseTo(1450, 4);
  });
});

describe('indicator rungs — EXIT-ONLY momentum exits (arm-time rules)', () => {
  const base = {
    seq: 1,
    coin: 'HYPE',
    side: 'long' as const,
    action: 'reduce' as const,
    triggerKind: 'indicator' as const,
    triggerPx: null,
    triggerMeta: { op: 'above' as const, indicatorName: 'momentum-stall-long', indicatorValue: 2, floorPx: 67 },
    entryPx: null,
    sizeCoins: null,
    leverage: null,
    stopPx: null,
  };
  const arm = (rungOver: Record<string, unknown>) =>
    validateLadderForArm({
      title: 'momentum exit',
      expiresAtMs: NOW + 86_400_000,
      now: NOW,
      rungs: [{ ...base, ...rungOver }],
      caps: { maxTotalNotionalUsd: null, maxTotalLossUsd: null },
      coinMaxLeverage: () => 10,
    });

  it('accepts a well-formed momentum exit (reduce + supported name + side-consistent)', () => {
    const res = arm({});
    expect(res.warnings.filter((w) => w.includes('indicator'))).toEqual([]);
  });

  it('REJECTS indicator triggers on exposure-increasing rungs (open/add)', () => {
    expect(arm({ action: 'open', entryPx: 65, sizeCoins: 1, stopPx: 63 }).warnings.join(' ')).toMatch(/EXIT-ONLY/);
    expect(arm({ action: 'add', entryPx: 66, sizeCoins: 1, stopPx: 64 }).warnings.join(' ')).toMatch(/EXIT-ONLY/);
  });

  it('REJECTS unknown indicator names (a dead rung must not look armed)', () => {
    expect(arm({ triggerMeta: { ...base.triggerMeta, indicatorName: 'rsi14' } }).warnings.join(' ')).toMatch(/unknown indicator/);
  });

  it('REJECTS a side-inconsistent name (long exit watching the short stall)', () => {
    expect(arm({ triggerMeta: { ...base.triggerMeta, indicatorName: 'momentum-stall-short' } }).warnings.join(' ')).toMatch(/must watch/);
  });

  it('REJECTS a non-positive floorPx when set', () => {
    expect(arm({ triggerMeta: { ...base.triggerMeta, floorPx: -1 } }).warnings.join(' ')).toMatch(/floorPx/);
  });
});

describe('momentumConfirm (entry filter) + activation window — arm-time rules', () => {
  const entryRung = (over: Record<string, unknown> = {}) => ({
    seq: 1, coin: 'HYPE', side: 'long' as const, action: 'open' as const,
    triggerKind: 'price_above' as const, triggerPx: 66, triggerMeta: { momentumConfirm: true },
    entryPx: 66, sizeCoins: 1, leverage: 2, stopPx: 63, ...over,
  });
  const arm = (rungOver: Record<string, unknown> = {}, inputOver: Record<string, unknown> = {}) =>
    validateLadderForArm({
      title: 'momentum entry', expiresAtMs: NOW + 86_400_000, now: NOW,
      rungs: [entryRung(rungOver)], caps: { maxTotalNotionalUsd: null, maxTotalLossUsd: null },
      coinMaxLeverage: () => 10, ...inputOver,
    });

  it('accepts momentumConfirm on an open rung', () => {
    expect(arm().warnings.filter((w) => w.includes('momentum'))).toEqual([]);
  });

  it('REJECTS momentumConfirm on a reduce rung (exits use indicator rungs)', () => {
    const w = arm({ action: 'reduce', entryPx: null, sizeCoins: null, stopPx: null, leverage: null }).warnings.join(' ');
    expect(w).toMatch(/ENTRY filter/);
  });

  it('REJECTS an out-of-range momentumMaxFlips', () => {
    expect(arm({ triggerMeta: { momentumConfirm: true, momentumMaxFlips: 5 } }).warnings.join(' ')).toMatch(/momentumMaxFlips/);
  });

  it('REJECTS an out-of-range momentumSustain (only 1 or 2)', () => {
    expect(arm({ triggerMeta: { momentumConfirm: true, momentumSustain: 3 } }).warnings.join(' ')).toMatch(/momentumSustain/);
    expect(arm({ triggerMeta: { momentumConfirm: true, momentumSustain: 2 } }).warnings.filter((w) => w.includes('momentumSustain'))).toEqual([]);
  });

  it('REJECTS an empty activation window (active_from at/after expiry)', () => {
    const w = arm({}, { activeFromMs: NOW + 86_400_000 }).warnings.join(' ');
    expect(w).toMatch(/active_from must be BEFORE expiry/);
    // A valid window passes.
    expect(arm({}, { activeFromMs: NOW + 3_600_000 }).warnings.join(' ')).not.toMatch(/active_from/);
  });
});

describe('stop_move rungs — arm-time rules', () => {
  const smRung = (over: Record<string, unknown> = {}) => ({
    seq: 2, coin: 'HYPE', side: 'long' as const, action: 'stop_move' as const,
    triggerKind: 'price_above' as const, triggerPx: 66.85,
    triggerMeta: { moveTo: 'breakeven' as const },
    entryPx: null, sizeCoins: null, leverage: null, stopPx: null, ...over,
  });
  const arm = (rungOver: Record<string, unknown> = {}) =>
    validateLadderForArm({
      title: 'ratchet', expiresAtMs: NOW + 86_400_000, now: NOW,
      rungs: [smRung(rungOver)], caps: { maxTotalNotionalUsd: 200, maxTotalLossUsd: 25 },
      coinMaxLeverage: () => 10,
    });

  it("accepts a breakeven ratchet and a numeric protective destination", () => {
    expect(arm().warnings).toEqual([]);
    expect(arm({ triggerMeta: { moveTo: 65.0 } }).warnings).toEqual([]); // 65 < trigger 66.85 (long) ✓
  });

  it('REJECTS a missing/invalid moveTo', () => {
    expect(arm({ triggerMeta: {} }).warnings.join(' ')).toMatch(/moveTo/);
    expect(arm({ triggerMeta: { moveTo: -3 } }).warnings.join(' ')).toMatch(/moveTo/);
  });

  it('REJECTS a destination on the WRONG side of the trigger (would loosen or insta-fire)', () => {
    expect(arm({ triggerMeta: { moveTo: 70 } }).warnings.join(' ')).toMatch(/protective side/); // long: 70 > trigger
    expect(
      arm({ side: 'short', triggerKind: 'price_below', triggerPx: 60, triggerMeta: { moveTo: 58 } }).warnings.join(' '),
    ).toMatch(/protective side/); // short: dest must be ABOVE the trigger
  });

  it("REJECTS a trail without a positive distance, and a distance ≥ the trigger", () => {
    expect(arm({ triggerMeta: { moveTo: 'trail' } }).warnings.join(' ')).toMatch(/trailDistancePx/);
    expect(arm({ triggerMeta: { moveTo: 'trail', trailDistancePx: -2 } }).warnings.join(' ')).toMatch(/trailDistancePx/);
    expect(arm({ triggerPx: 66.85, triggerMeta: { moveTo: 'trail', trailDistancePx: 70 } }).warnings.join(' ')).toMatch(/nonsense geometry/);
    expect(arm({ triggerMeta: { moveTo: 'trail', trailDistancePx: 1.5 } }).warnings).toEqual([]); // valid trail
  });

  it('REJECTS non-price triggers on stop_move', () => {
    const w = arm({ triggerKind: 'indicator', triggerMeta: { op: 'above', indicatorName: 'momentum-stall-long', indicatorValue: 2, moveTo: 'breakeven' } }).warnings.join(' ');
    expect(w).toMatch(/price trigger/);
  });

  it('contributes ZERO to the risk read (it can only reduce risk)', () => {
    const res = arm();
    expect(res.risk.aggregateWorstCaseLossUsd).toBe(0);
  });
});
