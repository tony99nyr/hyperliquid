import { describe, it, expect } from 'vitest';
import { computeMissingFills, attributeSession } from '@/lib/cockpit/fill-backfill-business-logic';
import type { HlFill } from '@/lib/hyperliquid/hyperliquid-info-service';

function hl(over: Partial<HlFill> = {}): HlFill {
  return {
    coin: 'BTC',
    side: 'sell',
    px: 64_000,
    sz: 0.001,
    time: 1_000,
    closedPnl: -1,
    fee: 0.02,
    dir: 'Close Long',
    oid: 111,
    ...over,
  };
}

const known = (entries: Array<[string, number]> = []) => new Map(entries);

describe('computeMissingFills', () => {
  it('skips orders the ledger already knows (executeIntent bookings AND prior backfills)', () => {
    const { candidates } = computeMissingFills([hl({ oid: 111 }), hl({ oid: 222 })], known([['111', 0.001]]));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].hlOrderId).toBe('222');
  });

  it('reports a known order whose HL size outgrew the booked size (late partials) — never re-books it', () => {
    const { candidates, underBooked } = computeMissingFills(
      [hl({ oid: 7, sz: 0.4, time: 10 }), hl({ oid: 7, sz: 0.6, time: 20 })],
      known([['7', 0.4]]),
    );
    expect(candidates).toHaveLength(0);
    expect(underBooked).toEqual([{ hlOrderId: '7', coin: 'BTC', deltaSz: expect.closeTo(0.6, 9) }]);
  });

  it('no shortfall report when booked size matches (float tolerance)', () => {
    const { underBooked } = computeMissingFills([hl({ oid: 7, sz: 0.3 })], known([['7', 0.3 + 1e-12]]));
    expect(underBooked).toHaveLength(0);
  });

  it('aggregates partial fills of one order: Σsz, volume-weighted px, Σfee, latest time', () => {
    const { candidates: out } = computeMissingFills(
      [
        hl({ oid: 5, px: 100, sz: 1, fee: 0.1, time: 10 }),
        hl({ oid: 5, px: 110, sz: 3, fee: 0.3, time: 20 }),
      ],
      known(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].sz).toBe(4);
    expect(out[0].px).toBeCloseTo((100 * 1 + 110 * 3) / 4);
    expect(out[0].feeUsd).toBeCloseTo(0.4);
    expect(out[0].filledAt).toBe(20);
    expect(out[0].notionalUsd).toBeCloseTo(430);
  });

  it('reduceOnly only when EVERY fill direction closes', () => {
    const closes = computeMissingFills([hl({ oid: 1, dir: 'Close Long' })], known()).candidates;
    const mixed = computeMissingFills(
      [hl({ oid: 2, dir: 'Close Long' }), hl({ oid: 2, dir: 'Open Short' })],
      known(),
    ).candidates;
    expect(closes[0].reduceOnly).toBe(true);
    expect(mixed[0].reduceOnly).toBe(false);
  });

  it('drops spot fills, oid-less fills, zero-size fills, and pre-window fills', () => {
    const { candidates: out } = computeMissingFills(
      [
        hl({ coin: 'PURR/USDC' }),
        hl({ coin: '@107' }),
        hl({ oid: null }),
        hl({ oid: undefined }),
        hl({ sz: 0 }),
        hl({ time: 5, oid: 9 }),
        hl({ time: 50, oid: 10 }),
      ],
      known(),
      10,
    );
    expect(out).toHaveLength(1);
    expect(out[0].hlOrderId).toBe('10');
  });

  it('returns candidates oldest-first so the position fold replays in order', () => {
    const { candidates: out } = computeMissingFills(
      [hl({ oid: 2, time: 200 }), hl({ oid: 1, time: 100 })],
      known(),
    );
    expect(out.map((c) => c.hlOrderId)).toEqual(['1', '2']);
  });
});

describe('attributeSession', () => {
  it('prefers the open-position holder, then last trader, then newest active, then null', () => {
    expect(attributeSession('BTC', { BTC: 'holder' }, { BTC: 'trader' }, 'newest')).toBe('holder');
    // k-prefixed coins arrive from HL as e.g. "kPEPE" — must still hit the maps.
    expect(attributeSession('kPEPE', { KPEPE: 'holder' }, {}, 'newest')).toBe('holder');
    expect(attributeSession('BTC', {}, { BTC: 'trader' }, 'newest')).toBe('trader');
    expect(attributeSession('BTC', {}, {}, 'newest')).toBe('newest');
    expect(attributeSession('BTC', {}, {}, null)).toBeNull();
  });
});
