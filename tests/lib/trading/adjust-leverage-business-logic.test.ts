import { describe, it, expect } from 'vitest';
import {
  adjustLeveragePlan,
  ADJUST_LIQ_DANGER_PCT,
  type AdjustLeverageInput,
} from '@/lib/trading/adjust-leverage-business-logic';

const base: AdjustLeverageInput = {
  side: 'long',
  entryPx: 2000,
  markPx: 2000,
  currentLeverage: 5,
  requestedLeverage: 10,
  coinMax: 25,
};

describe('adjustLeveragePlan', () => {
  it('validates the requested leverage into [1, coinMax]', () => {
    expect(adjustLeveragePlan({ ...base, requestedLeverage: 999 }).leverage).toBe(25);
    expect(adjustLeveragePlan({ ...base, requestedLeverage: 0 }).leverage).toBe(1);
    expect(adjustLeveragePlan({ ...base, requestedLeverage: 8 }).leverage).toBe(8);
  });

  it('computes the new liq below entry for a long (isolated)', () => {
    // 10x long @ 2000 → liq = 2000 * (1 - 1/10) = 1800
    expect(adjustLeveragePlan({ ...base, requestedLeverage: 10 }).liqPx).toBeCloseTo(1800, 6);
  });

  it('computes the new liq above entry for a short', () => {
    // 10x short @ 2000 → liq = 2000 * (1 + 1/10) = 2200
    const p = adjustLeveragePlan({ ...base, side: 'short', requestedLeverage: 10 });
    expect(p.liqPx).toBeCloseTo(2200, 6);
  });

  it('reports currentLiqPx at the existing leverage (before/after)', () => {
    // 5x long @ 2000 → 1600
    expect(adjustLeveragePlan(base).currentLiqPx).toBeCloseTo(1600, 6);
  });

  it('marks changed=true when leverage differs, false when it matches (integer compare)', () => {
    expect(adjustLeveragePlan({ ...base, currentLeverage: 5, requestedLeverage: 10 }).changed).toBe(true);
    expect(adjustLeveragePlan({ ...base, currentLeverage: 10, requestedLeverage: 10 }).changed).toBe(false);
    // 10.0 vs 10 → not changed
    expect(adjustLeveragePlan({ ...base, currentLeverage: 10, requestedLeverage: 10.0 }).changed).toBe(false);
  });

  it('treats null current leverage as changed (first-time set), never a raise', () => {
    const p = adjustLeveragePlan({ ...base, currentLeverage: null, requestedLeverage: 10 });
    expect(p.changed).toBe(true);
    expect(p.isRaise).toBe(false);
    expect(p.dangerNearMark).toBe(false); // can't assert a raise without a baseline
  });

  it('FLAGS danger when a RAISE pushes liq within the danger band of mark', () => {
    // long @ 2000, mark 2000. 25x → liq = 1920 → 4% from mark < 5% → danger.
    const p = adjustLeveragePlan({ ...base, currentLeverage: 5, requestedLeverage: 25, coinMax: 25 });
    expect(p.isRaise).toBe(true);
    expect(p.liqDistFromMarkPct).toBeCloseTo(4, 6);
    expect(p.dangerNearMark).toBe(true);
  });

  it('does NOT flag danger when liq stays outside the band', () => {
    // 10x → liq 1800 → 10% from mark > 5% → safe.
    const p = adjustLeveragePlan({ ...base, currentLeverage: 5, requestedLeverage: 10 });
    expect(p.dangerNearMark).toBe(false);
    expect(p.liqDistFromMarkPct).toBeGreaterThan(ADJUST_LIQ_DANGER_PCT);
  });

  it('NEVER flags danger when LOWERING leverage (liq moves away from mark)', () => {
    // from 25x down to 5x — even though we pass a tight mark, lowering is always safe.
    const p = adjustLeveragePlan({ ...base, currentLeverage: 25, requestedLeverage: 5, markPx: 1950 });
    expect(p.isRaise).toBe(false);
    expect(p.dangerNearMark).toBe(false);
  });

  it('returns null liq distance / no danger when mark is unknown', () => {
    const p = adjustLeveragePlan({ ...base, markPx: null, currentLeverage: 5, requestedLeverage: 25 });
    expect(p.liqDistFromMarkPct).toBeNull();
    expect(p.dangerNearMark).toBe(false);
  });

  it('returns null liq for a degenerate entry price', () => {
    const p = adjustLeveragePlan({ ...base, entryPx: 0 });
    expect(p.liqPx).toBeNull();
    expect(p.currentLiqPx).toBeNull();
  });
});
