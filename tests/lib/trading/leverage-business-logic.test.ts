/**
 * Pins the PURE leverage math (Item 3): margin / liquidation / ROE + the SAFETY
 * GUARD (liquidation-inside-stop), plus the server-side validation bound and the
 * leader presets. Notional is leverage-INDEPENDENT (risk-sized); leverage governs
 * only margin/liq/ROE — these tests lock that.
 */

import { describe, it, expect } from 'vitest';
import {
  clampLeverage,
  serverValidateLeverage,
  liquidationPx,
  roeAtPx,
  deriveLeverageRead,
  liquidationInsideStop,
  resolveCoinMaxLeverage,
  halfLeaderLeverage,
} from '@/lib/trading/leverage-business-logic';

describe('clampLeverage', () => {
  it('keeps a value in band, clamps below 1 and above max', () => {
    expect(clampLeverage(5, 20)).toBe(5);
    expect(clampLeverage(0.4, 20)).toBe(1);
    expect(clampLeverage(40, 20)).toBe(20);
  });
  it('NaN / bad max defaults to 1', () => {
    expect(clampLeverage(NaN, 20)).toBe(1);
    expect(clampLeverage(5, NaN)).toBe(1);
  });
});

describe('serverValidateLeverage (DO NOT trust the client)', () => {
  it('clamps a client-sent value to [1, coinMax]', () => {
    expect(serverValidateLeverage(99, 25, 5)).toBe(25);
    expect(serverValidateLeverage(0, 25, 5)).toBe(5); // non-positive ⇒ fallback, then clamp
    expect(serverValidateLeverage(10, 25, 5)).toBe(10);
  });
  it('null/undefined/garbage ⇒ the proposal fallback (clamped)', () => {
    expect(serverValidateLeverage(undefined, 25, 5)).toBe(5);
    expect(serverValidateLeverage(null, 25, 5)).toBe(5);
    expect(serverValidateLeverage('abc', 25, 5)).toBe(5);
    expect(serverValidateLeverage(undefined, 25, 99)).toBe(25); // fallback also clamped
  });
  it('accepts a numeric string', () => {
    expect(serverValidateLeverage('8', 25, 5)).toBe(8);
  });
});

describe('liquidationPx', () => {
  it('long liquidates below entry by ~entry/leverage', () => {
    // 10x on a 2000 long ⇒ 10% below ⇒ 1800.
    expect(liquidationPx('buy', 2000, 10)).toBeCloseTo(1800, 6);
  });
  it('short liquidates above entry by ~entry/leverage', () => {
    expect(liquidationPx('sell', 2000, 10)).toBeCloseTo(2200, 6);
  });
  it('returns null for degenerate inputs', () => {
    expect(liquidationPx('buy', 0, 10)).toBeNull();
    expect(liquidationPx('buy', 2000, 0)).toBeNull();
  });
});

describe('roeAtPx', () => {
  it('ROE = price-move% * leverage, signed for the side', () => {
    // long 2000 → 2100 (+5%) at 10x ⇒ +50% ROE.
    expect(roeAtPx('buy', 2000, 2100, 10)).toBeCloseTo(50, 6);
    // short 2000 → 2100 (+5% price, adverse) at 10x ⇒ -50% ROE.
    expect(roeAtPx('sell', 2000, 2100, 10)).toBeCloseTo(-50, 6);
  });
});

describe('deriveLeverageRead', () => {
  it('notional is leverage-independent; margin = notional/leverage', () => {
    const r5 = deriveLeverageRead({ side: 'buy', entryPx: 2000, sz: 1, leverage: 5, stopPx: 1900 });
    const r10 = deriveLeverageRead({ side: 'buy', entryPx: 2000, sz: 1, leverage: 10, stopPx: 1900 });
    expect(r5.notionalUsd).toBe(2000);
    expect(r10.notionalUsd).toBe(2000); // SAME notional — risk-sized
    expect(r5.marginUsd).toBe(400);
    expect(r10.marginUsd).toBe(200); // higher lev ⇒ less margin
  });
  it('ROE@stop is a (signed) loss for a long stop below entry', () => {
    const r = deriveLeverageRead({ side: 'buy', entryPx: 2000, sz: 1, leverage: 10, stopPx: 1900 });
    // -5% move at 10x ⇒ -50% ROE.
    expect(r.roeAtStopPct).toBeCloseTo(-50, 6);
  });
  it('includes ROE@target when a target is supplied', () => {
    const r = deriveLeverageRead({ side: 'buy', entryPx: 2000, sz: 1, leverage: 10, stopPx: 1900, targetPx: 2200 });
    expect(r.roeAtTargetPct).toBeCloseTo(100, 6);
  });
});

describe('liquidationInsideStop — THE SAFETY GUARD', () => {
  it('LONG: 5% stop @ 20x ⇒ liq (~5% below) at/above the stop ⇒ DANGER', () => {
    // entry 2000, stop 1900 (5% below). liq at 20x ⇒ 1900 (5% below) ⇒ liq >= stop.
    const liq = liquidationPx('buy', 2000, 20);
    expect(liquidationInsideStop('buy', liq, 1900)).toBe(true);
  });
  it('LONG: 5% stop @ 5x ⇒ liq (~20% below) is well below the stop ⇒ SAFE', () => {
    const liq = liquidationPx('buy', 2000, 5); // 1600
    expect(liquidationInsideStop('buy', liq, 1900)).toBe(false);
  });
  it('SHORT: stop above entry, liq above entry — danger when liq <= stop', () => {
    // entry 2000, stop 2100 (5% above). liq at 20x ⇒ 2100 ⇒ liq <= stop ⇒ DANGER.
    const liq = liquidationPx('sell', 2000, 20);
    expect(liquidationInsideStop('sell', liq, 2100)).toBe(true);
    const safeLiq = liquidationPx('sell', 2000, 5); // 2400
    expect(liquidationInsideStop('sell', safeLiq, 2100)).toBe(false);
  });
  it('returns false when a price is unknown (cannot assert danger)', () => {
    expect(liquidationInsideStop('buy', null, 1900)).toBe(false);
    expect(liquidationInsideStop('buy', 1800, null)).toBe(false);
    expect(liquidationInsideStop('buy', 1800, undefined)).toBe(false);
  });
});

describe('resolveCoinMaxLeverage', () => {
  it('prefers the leader-reported max', () => {
    expect(resolveCoinMaxLeverage('ETH', 50)).toBe(50);
    expect(resolveCoinMaxLeverage('ETH', 12.7)).toBe(12); // floored
  });
  it('falls back to a conservative per-coin default', () => {
    expect(resolveCoinMaxLeverage('BTC', null)).toBe(40);
    expect(resolveCoinMaxLeverage('ETH', null)).toBe(25);
    expect(resolveCoinMaxLeverage('DOGE', null)).toBe(10);
  });
});

describe('halfLeaderLeverage', () => {
  it('halves (floored, min 1)', () => {
    expect(halfLeaderLeverage(20)).toBe(10);
    expect(halfLeaderLeverage(5)).toBe(2);
    expect(halfLeaderLeverage(1)).toBe(1);
  });
  it('null for unknown leader leverage', () => {
    expect(halfLeaderLeverage(null)).toBeNull();
    expect(halfLeaderLeverage(undefined)).toBeNull();
  });
});
