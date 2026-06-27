/**
 * Pins the PURE HL order logic — the auditable layer (formatting, action shape,
 * response parsing) that we own while the crypto is delegated. The action key
 * ORDER is load-bearing (it's the signed byte layout), so it's asserted exactly.
 */

import { describe, it, expect } from 'vitest';
import {
  trimZeros,
  formatHlSize,
  formatHlPrice,
  aggressiveIocPrice,
  buildIocOrderAction,
  buildStopOrderAction,
  buildBracketAction,
  resolveAsset,
  parseOrderResponse,
} from '@/lib/hyperliquid/hyperliquid-order-business-logic';

describe('trimZeros / formatHlSize', () => {
  it('strips trailing zeros + bare dot', () => {
    expect(trimZeros('1.500')).toBe('1.5');
    expect(trimZeros('2.000')).toBe('2');
    expect(trimZeros('1700')).toBe('1700');
  });
  it('floors size to szDecimals (never oversize)', () => {
    expect(formatHlSize(1.23456, 4)).toBe('1.2345'); // floored, not rounded up
    expect(formatHlSize(1.29999, 2)).toBe('1.29'); // floor, not 1.30
    expect(formatHlSize(1.5, 4)).toBe('1.5');
    expect(formatHlSize(2, 3)).toBe('2');
  });
  it('floors a sub-lot size to "0" (caller rejects it pre-flight)', () => {
    expect(formatHlSize(0.00005, 4)).toBe('0');
  });
});

describe('formatHlPrice (5 sig figs, maxDecimals = 6 - szDecimals for perps)', () => {
  it('integers pass through unchanged', () => {
    expect(formatHlPrice(1700, 4)).toBe('1700');
    expect(formatHlPrice(63000, 5)).toBe('63000');
  });
  it('clamps to 5 significant figures', () => {
    // szDecimals 2 → maxDec 4; 5 sig figs dominates.
    expect(formatHlPrice(1234.567, 2)).toBe('1234.6');
  });
  it('clamps decimals to (6 - szDecimals) and strips zeros', () => {
    // szDecimals 4 → maxDec 2.
    expect(formatHlPrice(1700.5, 4)).toBe('1700.5');
    expect(formatHlPrice(2.34999, 4)).toBe('2.35');
  });
});

describe('aggressiveIocPrice', () => {
  it('buys above / sells below the mark by the buffer', () => {
    expect(aggressiveIocPrice(2000, true, 0.05)).toBeCloseTo(2100, 6);
    expect(aggressiveIocPrice(2000, false, 0.05)).toBeCloseTo(1900, 6);
  });
});

describe('buildIocOrderAction — exact shape + LOAD-BEARING key order', () => {
  it('builds {type,orders,grouping} with order keys a,b,p,s,r,t and IOC tif', () => {
    const action = buildIocOrderAction({ assetIndex: 1, isBuy: true, priceStr: '2100', sizeStr: '1.5', reduceOnly: false });
    expect(Object.keys(action)).toEqual(['type', 'orders', 'grouping']);
    expect(action.type).toBe('order');
    expect(action.grouping).toBe('na');
    const o = action.orders[0];
    expect(Object.keys(o)).toEqual(['a', 'b', 'p', 's', 'r', 't']);
    expect(o).toEqual({ a: 1, b: true, p: '2100', s: '1.5', r: false, t: { limit: { tif: 'Ioc' } } });
    // p and s MUST be strings (numbers would hit msgpack float encoding).
    expect(typeof o.p).toBe('string');
    expect(typeof o.s).toBe('string');
  });
});

describe('buildStopOrderAction — reduce-only stop-market trigger shape', () => {
  it('is a reduce-only SL trigger with the canonical key order', () => {
    const action = buildStopOrderAction({ assetIndex: 5, isBuy: false, triggerPxStr: '1628.9', sizeStr: '2' });
    expect(action.type).toBe('order');
    expect(action.grouping).toBe('na');
    const o = action.orders[0];
    expect(Object.keys(o)).toEqual(['a', 'b', 'p', 's', 'r', 't']); // load-bearing msgpack order
    expect(o.a).toBe(5);
    expect(o.b).toBe(false); // a long's stop SELLS
    expect(o.r).toBe(true); // ALWAYS reduce-only — can only close
    expect(o.t).toEqual({ trigger: { isMarket: true, triggerPx: '1628.9', tpsl: 'sl' } });
  });
  it('builds a TAKE-PROFIT trigger when tpsl="tp" (still reduce-only)', () => {
    const action = buildStopOrderAction({ assetIndex: 5, isBuy: false, triggerPxStr: '1750', sizeStr: '2', tpsl: 'tp' });
    const o = action.orders[0];
    expect(o.r).toBe(true); // reduce-only either way
    expect(o.t).toEqual({ trigger: { isMarket: true, triggerPx: '1750', tpsl: 'tp' } });
  });
});

describe('buildBracketAction — native OCO (positionTpsl): stop + take-profit', () => {
  it('emits two same-side reduce-only legs (stop first, tp second) grouped positionTpsl', () => {
    const action = buildBracketAction({ assetIndex: 5, isBuy: false, stopPxStr: '1700', tpPxStr: '1450', sizeStr: '0.36' });
    expect(action.type).toBe('order');
    expect(action.grouping).toBe('positionTpsl'); // links the legs one-cancels-other
    expect(action.orders).toHaveLength(2);
    const [sl, tp] = action.orders;
    // both legs CLOSE the position → same side (a short's bracket BUYS), both reduce-only
    expect(sl.b).toBe(false); expect(tp.b).toBe(false);
    expect(sl.r).toBe(true); expect(tp.r).toBe(true);
    // load-bearing key order within each leg
    expect(Object.keys(sl)).toEqual(['a', 'b', 'p', 's', 'r', 't']);
    // leg 0 = stop ('sl'), leg 1 = take-profit ('tp')
    expect(sl.t).toEqual({ trigger: { isMarket: true, triggerPx: '1700', tpsl: 'sl' } });
    expect(tp.t).toEqual({ trigger: { isMarket: true, triggerPx: '1450', tpsl: 'tp' } });
  });
});

describe('resolveAsset', () => {
  const universe = [
    { name: 'BTC', szDecimals: 5 },
    { name: 'ETH', szDecimals: 4 },
    { name: 'HYPE', szDecimals: 2 },
  ];
  it('maps a coin to its index + szDecimals (case-insensitive)', () => {
    expect(resolveAsset(universe, 'eth')).toEqual({ assetIndex: 1, szDecimals: 4 });
    expect(resolveAsset(universe, 'HYPE')).toEqual({ assetIndex: 2, szDecimals: 2 });
  });
  it('throws for a coin not in the universe', () => {
    expect(() => resolveAsset(universe, 'DOGE')).toThrow(/not in HL perp universe/);
  });
});

describe('parseOrderResponse', () => {
  it('extracts a filled order', () => {
    const r = parseOrderResponse({
      status: 'ok',
      response: { type: 'order', data: { statuses: [{ filled: { totalSz: '1.5', avgPx: '2001.3', oid: 999 } }] } },
    });
    expect(r).toEqual({ filled: true, oid: 999, filledSize: 1.5, avgPrice: 2001.3 });
  });
  it('treats a resting IOC as NO FILL (not an error)', () => {
    const r = parseOrderResponse({ status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 7 } }] } } });
    expect(r).toEqual({ filled: false, oid: 7, filledSize: 0, avgPrice: null });
  });
  it('throws on a per-order error', () => {
    expect(() =>
      parseOrderResponse({ status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'insufficient margin' }] } } }),
    ).toThrow(/insufficient margin/);
  });
  it('throws on a top-level failure (status !== ok)', () => {
    expect(() => parseOrderResponse({ status: 'err', response: 'bad nonce' })).toThrow(/HL exchange rejected: bad nonce/);
  });
  it('throws when there is no status', () => {
    expect(() => parseOrderResponse({ status: 'ok', response: { type: 'order', data: { statuses: [] } } })).toThrow(/no order status/);
  });
});
