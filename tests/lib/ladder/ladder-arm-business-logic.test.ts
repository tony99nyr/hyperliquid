/**
 * Pins the PURE arm-readiness validation: expiry/caps gating, per-rung validity (trigger
 * params, sizing, stop on the loss side, leverage band), and the PYRAMIDING guardrails
 * (adds decrease size; the per-coin stop only tightens). Empty warnings ⇒ safe to arm.
 */

import { describe, it, expect } from 'vitest';
import { validateLadderForArm, type ArmRung, type ValidateLadderInput } from '@/lib/ladder/ladder-arm-business-logic';

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

describe('validateLadderForArm — caps via the risk read', () => {
  it('surfaces a worst-case-loss breach from the risk read', () => {
    // entry 2000, size 5, stop 1900 → worst (2000-1710)*5 = 1450 > cap 1000.
    const r = rung({ sizeCoins: 5, stopPx: 1900 });
    const res = validateLadderForArm(input({ rungs: [r], caps: { maxTotalNotionalUsd: 1_000_000, maxTotalLossUsd: 1_000 } }));
    expect(res.warnings.some((w) => /worst-case/i.test(w))).toBe(true);
    expect(res.risk.aggregateWorstCaseLossUsd).toBeCloseTo(1450, 4);
  });
});
