/**
 * Pins the PURE ladder risk math (§3.5 preview) + the precondition snapshot (§3.7).
 * The load-bearing properties: worst-case uses the SLIPPAGE-BOUNDED stop fill (not the
 * stop price) and sums with NO netting; per-coin liq is at the blended max exposure.
 */

import { describe, it, expect } from 'vitest';
import {
  bookHeatUsd,
  worstStopFill,
  rungWorstCaseLoss,
  perCoinExposure,
  computeLadderRisk,
  buildPreconditionSnapshot,
  hashPreconditionSnapshot,
  addRiskCoveredByProfit,
  STOP_SLIPPAGE_TOL,
  type RungRisk,
} from '@/lib/ladder/ladder-risk-business-logic';

describe('worstStopFill — slippage-bounded stop fill', () => {
  it('long stop sells LOWER by the tolerance', () => {
    expect(worstStopFill('long', 1900)).toBeCloseTo(1900 * (1 - STOP_SLIPPAGE_TOL), 6);
  });
  it('short stop buys HIGHER by the tolerance', () => {
    expect(worstStopFill('short', 2100)).toBeCloseTo(2100 * (1 + STOP_SLIPPAGE_TOL), 6);
  });
  it('null for a degenerate stop', () => {
    expect(worstStopFill('long', 0)).toBeNull();
  });
});

describe('rungWorstCaseLoss — adverse move to the slipped stop', () => {
  it('long: entry 2000, size 1, stop 1900 → (2000 - 1710) × 1 = 290', () => {
    expect(rungWorstCaseLoss({ side: 'long', action: 'open', entryPx: 2000, sizeCoins: 1, stopPx: 1900 })).toBeCloseTo(290, 6);
  });
  it('short: entry 2000, size 2, stop 2100 → (2310 - 2000) × 2 = 620', () => {
    expect(rungWorstCaseLoss({ side: 'short', action: 'open', entryPx: 2000, sizeCoins: 2, stopPx: 2100 })).toBeCloseTo(620, 6);
  });
  it('reduce/close rungs add no stoppable loss → 0', () => {
    expect(rungWorstCaseLoss({ side: 'long', action: 'close', entryPx: 2000, sizeCoins: 1, stopPx: 1900 })).toBe(0);
    expect(rungWorstCaseLoss({ side: 'long', action: 'reduce', entryPx: 2000, sizeCoins: 1, stopPx: 1900 })).toBe(0);
  });
  it('no stop → 0 (caller flags the missing stop separately)', () => {
    expect(rungWorstCaseLoss({ side: 'long', action: 'open', entryPx: 2000, sizeCoins: 1, stopPx: null })).toBe(0);
  });
});

describe('perCoinExposure — blended entry + liq at max aggregate exposure', () => {
  it('blends two same-coin long rungs and computes one aggregate liq', () => {
    const rungs: RungRisk[] = [
      { coin: 'ETH', side: 'long', action: 'open', entryPx: 2000, sizeCoins: 1, leverage: 5, stopPx: 1900 },
      { coin: 'ETH', side: 'long', action: 'add', entryPx: 2100, sizeCoins: 0.5, leverage: 5, stopPx: 1950 },
    ];
    const [eth] = perCoinExposure(rungs);
    expect(eth.totalSizeCoins).toBeCloseTo(1.5, 6);
    expect(eth.blendedEntryPx).toBeCloseTo((2000 * 1 + 2100 * 0.5) / 1.5, 6); // 2033.33
    expect(eth.notionalUsd).toBeCloseTo(3050, 6);
    expect(eth.leverage).toBe(5);
    // isolatedLiqPx long, blended ~2033.33, 5×, mmr 0.004 → ~2033.33*(1-0.2+0.004)
    expect(eth.aggregateLiqPx!).toBeCloseTo(2033.3333 * (1 - 0.2 + 0.004), 2);
  });
  it('leverage = null when rungs on a coin disagree (HL is per-coin)', () => {
    const rungs: RungRisk[] = [
      { coin: 'ETH', side: 'long', action: 'open', entryPx: 2000, sizeCoins: 1, leverage: 5, stopPx: 1900 },
      { coin: 'ETH', side: 'long', action: 'add', entryPx: 2100, sizeCoins: 0.5, leverage: 10, stopPx: 1950 },
    ];
    const [eth] = perCoinExposure(rungs);
    expect(eth.leverage).toBeNull();
    expect(eth.aggregateLiqPx).toBeNull();
  });
  it('excludes reduce/close + degenerate rungs', () => {
    const rungs: RungRisk[] = [
      { coin: 'ETH', side: 'long', action: 'close', entryPx: 2000, sizeCoins: 1, leverage: 5, stopPx: null },
      { coin: 'BTC', side: 'short', action: 'open', entryPx: 0, sizeCoins: 1, leverage: 5, stopPx: 60000 },
    ];
    expect(perCoinExposure(rungs)).toHaveLength(0);
  });
});

describe('computeLadderRisk — totals, no-netting worst-case, cap breaches', () => {
  const rungs: RungRisk[] = [
    { coin: 'ETH', side: 'long', action: 'open', entryPx: 2000, sizeCoins: 1, leverage: 5, stopPx: 1900 },
    { coin: 'BTC', side: 'short', action: 'open', entryPx: 60000, sizeCoins: 0.01, leverage: 4, stopPx: 63000 },
  ];

  it('sums notional + margin and the no-netting worst-case loss', () => {
    const r = computeLadderRisk(rungs, { maxTotalNotionalUsd: null, maxTotalLossUsd: null });
    expect(r.totalNotionalUsd).toBeCloseTo(2000 * 1 + 60000 * 0.01, 4); // 2600
    expect(r.totalMarginUsd).toBeCloseTo(2000 / 5 + 600 / 4, 4); // 400 + 150 = 550
    // ETH: (2000-1710)*1 = 290; BTC short: worstFill 63000*1.1=69300, (69300-60000)*0.01 = 93
    expect(r.aggregateWorstCaseLossUsd).toBeCloseTo(290 + 93, 4);
    expect(r.breaches).toHaveLength(0);
  });

  it('flags a notional-cap breach', () => {
    const r = computeLadderRisk(rungs, { maxTotalNotionalUsd: 2000, maxTotalLossUsd: null });
    expect(r.breaches.some((b) => /notional/i.test(b))).toBe(true);
  });

  it('flags a worst-case-loss breach', () => {
    const r = computeLadderRisk(rungs, { maxTotalNotionalUsd: null, maxTotalLossUsd: 100 });
    expect(r.breaches.some((b) => /worst-case/i.test(b))).toBe(true);
  });

  it('flags a per-coin leverage disagreement', () => {
    const mixed: RungRisk[] = [
      { coin: 'ETH', side: 'long', action: 'open', entryPx: 2000, sizeCoins: 1, leverage: 5, stopPx: 1900 },
      { coin: 'ETH', side: 'long', action: 'add', entryPx: 2100, sizeCoins: 0.5, leverage: 8, stopPx: 1950 },
    ];
    const r = computeLadderRisk(mixed, { maxTotalNotionalUsd: null, maxTotalLossUsd: null });
    expect(r.breaches.some((b) => /per-coin|leverage/i.test(b))).toBe(true);
  });

  it('does NOT let a stopless open rung render $0 worst-case — it breaches (UNBOUNDED)', () => {
    // A naked open contributes 0 to the loss SUM, so without the breach a $100 loss
    // cap would falsely pass. The breach makes the understatement impossible to miss.
    const naked: RungRisk[] = [{ coin: 'ETH', side: 'long', action: 'open', entryPx: 2000, sizeCoins: 1, leverage: 5, stopPx: null }];
    const r = computeLadderRisk(naked, { maxTotalNotionalUsd: null, maxTotalLossUsd: 100 });
    expect(r.aggregateWorstCaseLossUsd).toBe(0); // the sum genuinely can't bound it
    expect(r.breaches.some((b) => /unbounded|no protective stop/i.test(b))).toBe(true);
  });

  it('flags opposing-side rungs on ONE coin instead of blending a fictional liq', () => {
    const opposing: RungRisk[] = [
      { coin: 'ETH', side: 'long', action: 'open', entryPx: 2000, sizeCoins: 1, leverage: 5, stopPx: 1900 },
      { coin: 'ETH', side: 'short', action: 'open', entryPx: 2000, sizeCoins: 1, leverage: 5, stopPx: 2100 },
    ];
    const r = computeLadderRisk(opposing, { maxTotalNotionalUsd: null, maxTotalLossUsd: null });
    expect(r.breaches.some((b) => /both long and short/i.test(b))).toBe(true);
    // Two SEPARATE legs (each with its own real liq), never one blended $4000 long.
    expect(r.perCoin).toHaveLength(2);
    expect(new Set(r.perCoin.map((c) => c.side))).toEqual(new Set(['long', 'short']));
  });
});

describe('addRiskCoveredByProfit (§2 runtime pyramiding guard)', () => {
  it('covered: add risk ≤ unrealized profit', () => {
    expect(addRiskCoveredByProfit(100, 150)).toBe(true);
    expect(addRiskCoveredByProfit(150, 150)).toBe(true); // equal is covered
  });
  it('NOT covered: add risk exceeds profit', () => {
    expect(addRiskCoveredByProfit(200, 150)).toBe(false);
  });
  it('NOT covered when the position is flat/losing (profit ≤ 0) — never martingale', () => {
    expect(addRiskCoveredByProfit(10, 0)).toBe(false);
    expect(addRiskCoveredByProfit(10, -50)).toBe(false);
  });
});

describe('precondition snapshot (§3.7)', () => {
  it('captures only the coins a rung DEPENDS on (add/reduce/close), sorted, leverage 1dp', () => {
    const rungs = [
      { coin: 'ETH', action: 'add' as const },
      { coin: 'BTC', action: 'open' as const }, // open depends on no prior state → excluded
      { coin: 'SOL', action: 'close' as const },
    ];
    const live = [
      { coin: 'ETH', side: 'long' as const, leverage: 5 },
      { coin: 'SOL', side: 'short' as const, leverage: 3.25 },
    ];
    expect(buildPreconditionSnapshot(rungs, live)).toBe('ETH:long:5.0|SOL:short:3.3');
  });

  it('marks a depended-on position that does NOT exist at arm', () => {
    const snap = buildPreconditionSnapshot([{ coin: 'ETH', action: 'add' }], []);
    expect(snap).toBe('ETH:none');
  });

  it('EXCLUDES a coin the ladder opens itself — an open→add pyramid armed flat must not drift-disarm', () => {
    // open + add on the SAME coin: the add depends on the ladder's OWN open, not external
    // state. The snapshot must be EMPTY (not 'ETH:none'), so after the open creates the
    // position the add still matches and can fire (the coverage gate guards it instead).
    const rungs = [
      { coin: 'ETH', action: 'open' as const },
      { coin: 'ETH', action: 'add' as const },
      { coin: 'ETH', action: 'reduce' as const },
    ];
    expect(buildPreconditionSnapshot(rungs, [])).toBe(''); // flat at arm
    // and still empty AFTER the open created the ETH position (no drift):
    expect(buildPreconditionSnapshot(rungs, [{ coin: 'ETH', side: 'short', leverage: 3 }])).toBe('');
    // a pure add-to-existing-position ladder (no open for the coin) is STILL guarded:
    expect(buildPreconditionSnapshot([{ coin: 'ETH', action: 'add' }], [])).toBe('ETH:none');
  });

  it('hash is deterministic + changes when the snapshot drifts (side flip / leverage change)', () => {
    const a = buildPreconditionSnapshot([{ coin: 'ETH', action: 'add' }], [{ coin: 'ETH', side: 'long', leverage: 5 }]);
    const b = buildPreconditionSnapshot([{ coin: 'ETH', action: 'add' }], [{ coin: 'ETH', side: 'short', leverage: 5 }]);
    const c = buildPreconditionSnapshot([{ coin: 'ETH', action: 'add' }], [{ coin: 'ETH', side: 'long', leverage: 10 }]);
    expect(hashPreconditionSnapshot(a)).toBe(hashPreconditionSnapshot(a)); // stable
    expect(hashPreconditionSnapshot(a)).not.toBe(hashPreconditionSnapshot(b)); // side flip
    expect(hashPreconditionSnapshot(a)).not.toBe(hashPreconditionSnapshot(c)); // leverage drift
  });
});

describe('bookHeatUsd — fire-time book heat (EDGE_ROADMAP 3a)', () => {
  it('prices stopped positions as |mark−stop| + slip×mark, per unit', () => {
    // long 2 units, mark 100, stop 95 → (5 + 10) × 2 = 30
    expect(bookHeatUsd([{ sz: 2, markPx: 100, stopPx: 95 }])).toBeCloseTo(30, 6);
  });
  it('prices UNSTOPPED positions punitively (never $0 for a missing stop)', () => {
    expect(bookHeatUsd([{ sz: 1, markPx: 100, stopPx: null }])).toBeCloseTo(30, 6); // 3×slip×notional
  });
  it('sums the book and ignores garbage rows', () => {
    const heat = bookHeatUsd([
      { sz: 2, markPx: 100, stopPx: 95 },
      { sz: 1, markPx: 100, stopPx: null },
      { sz: 0, markPx: 100, stopPx: 90 },
      { sz: 1, markPx: 0, stopPx: 90 },
    ]);
    expect(heat).toBeCloseTo(60, 6);
  });
});
