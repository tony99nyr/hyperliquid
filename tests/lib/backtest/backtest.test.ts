import { describe, it, expect } from 'vitest';
import { simulateBacktest, bucketByConfidence, type BacktestBar, type BacktestSimConfig, type BacktestTrade } from '@/lib/backtest/backtest-business-logic';

const CFG: BacktestSimConfig = { slippageBps: 0, barHours: 1, notionalUsd: 1000 };

function bar(over: Partial<BacktestBar> & { time: number; close: number }): BacktestBar {
  return {
    open: over.close,
    high: over.high ?? over.close,
    low: over.low ?? over.close,
    side: 'none',
    go: false,
    invalidation: 0,
    target: 0,
    fundingHourly: 0,
    ...over,
  };
}

describe('simulateBacktest', () => {
  it('enters on a GO and exits at TARGET on a later bar (winning long)', () => {
    const bars: BacktestBar[] = [
      bar({ time: 1, close: 100, go: true, side: 'long', invalidation: 95, target: 110 }),
      bar({ time: 2, close: 105, high: 112, low: 104 }), // high crosses target 110
    ];
    const r = simulateBacktest(bars, CFG);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].reason).toBe('target');
    expect(r.trades[0].netPnlUsd).toBeGreaterThan(0); // entry 100 → exit 110 on $1000
    expect(r.wins).toBe(1);
  });

  it('exits at STOP (losing long)', () => {
    const bars: BacktestBar[] = [
      bar({ time: 1, close: 100, go: true, side: 'long', invalidation: 95, target: 110 }),
      bar({ time: 2, close: 96, high: 99, low: 94 }), // low crosses stop 95
    ];
    const r = simulateBacktest(bars, CFG);
    expect(r.trades[0].reason).toBe('stop');
    expect(r.trades[0].netPnlUsd).toBeLessThan(0);
    expect(r.losses).toBe(1);
  });

  it('a short EARNS carry in positive funding (funding reduces cost)', () => {
    const bars: BacktestBar[] = [
      bar({ time: 0, close: 100, go: true, side: 'short', invalidation: 105, target: 90, fundingHourly: 0.0001 }),
      bar({ time: 3_600_000, close: 90, high: 91, low: 89 }), // target hit (short profits)
    ];
    const r = simulateBacktest(bars, CFG);
    expect(r.trades[0].fundingUsd).toBeLessThan(0); // short earns positive funding → negative cost
  });

  it('flips on an opposite-side GO', () => {
    const bars: BacktestBar[] = [
      bar({ time: 1, close: 100, go: true, side: 'long', invalidation: 90, target: 200 }),
      bar({ time: 2, close: 101, high: 102, low: 99, go: true, side: 'short', invalidation: 110, target: 80 }),
    ];
    const r = simulateBacktest(bars, CFG);
    // long opened bar1, flips to short at bar2 close → at least the long trade recorded
    expect(r.trades.some((t) => t.reason === 'flip')).toBe(true);
  });

  it('closes a residual position at the series end', () => {
    const bars: BacktestBar[] = [
      bar({ time: 1, close: 100, go: true, side: 'long', invalidation: 90, target: 200 }),
      bar({ time: 2, close: 105, high: 106, low: 104 }), // neither stop nor target
    ];
    const r = simulateBacktest(bars, CFG);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].reason).toBe('end');
  });

  it('no trades when nothing is GO', () => {
    const r = simulateBacktest([bar({ time: 1, close: 100 }), bar({ time: 2, close: 101 })], CFG);
    expect(r.trades).toHaveLength(0);
    expect(r.netUsd).toBe(0);
  });

  it('MAKER: a passive entry MISSES a runaway move (price never returns to the limit)', () => {
    // GO long at 100; price gaps up and never trades back to 100 → no fill → no trade.
    const bars: BacktestBar[] = [
      bar({ time: 1, close: 100, go: true, side: 'long', invalidation: 95, target: 110 }),
      bar({ time: 2, close: 108, high: 109, low: 105 }), // low 105 > 100 limit → not touched
      bar({ time: 3, close: 112, high: 113, low: 109 }),
    ];
    const r = simulateBacktest(bars, { ...CFG, fillModel: 'maker', maxBarsToFill: 3 });
    expect(r.trades).toHaveLength(0); // missed the winner — the maker adverse-selection cost
  });

  it('MAKER: fills when price returns to the limit, earns rebate, no entry slippage', () => {
    const bars: BacktestBar[] = [
      bar({ time: 1, close: 100, go: true, side: 'long', invalidation: 95, target: 110 }),
      bar({ time: 2, close: 100, high: 101, low: 99 }), // low 99 ≤ 100 → fills at 100
      bar({ time: 3, close: 110, high: 111, low: 100 }), // target hit (maker exit)
    ];
    const r = simulateBacktest(bars, { ...CFG, slippageBps: 20, fillModel: 'maker', makerRebateBps: 1.5 });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].entryPx).toBe(100); // filled at the posted limit, NOT 100 + slippage
    expect(r.trades[0].reason).toBe('target');
    expect(r.trades[0].grossPnlUsd).toBeGreaterThan(0);
  });

  it('MAKER realism: queue-clearance requires trade-THROUGH (a mere touch no longer fills)', () => {
    const bars: BacktestBar[] = [
      bar({ time: 1, close: 100, go: true, side: 'long', invalidation: 95, target: 110 }),
      bar({ time: 2, close: 100, high: 101, low: 100 }), // touches 100 exactly, doesn't trade through
      bar({ time: 3, close: 102, high: 103, low: 101 }),
    ];
    // queueClear 5bps → must reach 100*(1-0.0005)=99.95; low never ≤ 99.95 → no fill.
    const r = simulateBacktest(bars, { ...CFG, fillModel: 'maker', makerQueueClearBps: 5, maxBarsToFill: 3 });
    expect(r.trades).toHaveLength(0);
  });

  it('MAKER realism: adverse-selection nudges the entry against you (filled-then-reversed)', () => {
    const bars: BacktestBar[] = [
      bar({ time: 1, close: 100, go: true, side: 'long', invalidation: 90, target: 120 }),
      bar({ time: 2, close: 99, high: 100, low: 98 }), // trades through 100 → fills
      bar({ time: 3, close: 99.5, high: 100, low: 99 }),
    ];
    const clean = simulateBacktest(bars, { ...CFG, fillModel: 'maker' });
    const adverse = simulateBacktest(bars, { ...CFG, fillModel: 'maker', makerAdverseSelBps: 10 });
    expect(adverse.trades[0].entryPx).toBeGreaterThan(clean.trades[0].entryPx); // buy fills higher (worse)
  });

  it('slippage worsens both legs (a clean target win nets less than gross move)', () => {
    const bars: BacktestBar[] = [
      bar({ time: 1, close: 100, go: true, side: 'long', invalidation: 95, target: 110 }),
      bar({ time: 2, close: 110, high: 110, low: 100 }),
    ];
    const noSlip = simulateBacktest(bars, { ...CFG, slippageBps: 0 });
    const withSlip = simulateBacktest(bars, { ...CFG, slippageBps: 20 });
    expect(withSlip.trades[0].netPnlUsd).toBeLessThan(noSlip.trades[0].netPnlUsd);
  });

  it('carries entry confidence from the GO bar onto the trade', () => {
    const bars = [
      bar({ time: 1, close: 100, side: 'long', go: true, confidence: 0.73, high: 100, low: 100, invalidation: 90, target: 110 }),
      bar({ time: 2, close: 110, high: 115, low: 105 }),
    ];
    const r = simulateBacktest(bars, CFG);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].entryConfidence).toBe(0.73);
  });
});

describe('simulateBacktest — trailing-stop exit', () => {
  it('lets a long winner RUN past the fixed target (no cap in trail mode)', () => {
    // Uptrend: entry 100, fixed target 110, but price runs to 140.
    const bars = [
      bar({ time: 1, close: 100, side: 'long', go: true, invalidation: 95, target: 110, atr: 4, high: 100, low: 100 }),
      bar({ time: 2, close: 120, high: 122, low: 110, atr: 4 }),
      bar({ time: 3, close: 140, high: 142, low: 130, atr: 4 }),
      bar({ time: 4, close: 132, high: 141, low: 131, atr: 4 }), // trail (≈142−1.5*4=136) hit at 136
    ];
    const fixed = simulateBacktest(bars, { ...CFG, exitMode: 'fixed' });
    const trail = simulateBacktest(bars, { ...CFG, exitMode: 'trail', trailAtrMult: 1.5 });
    expect(fixed.trades[0].reason).toBe('target');
    expect(fixed.trades[0].exitPx).toBe(110); // capped
    expect(trail.trades[0].reason).toBe('trail');
    expect(trail.trades[0].exitPx).toBeGreaterThan(110); // rode well past the cap
    expect(trail.trades[0].netPnlUsd).toBeGreaterThan(fixed.trades[0].netPnlUsd);
  });

  it('trailing stop ratchets up and never loosens (long)', () => {
    const bars = [
      bar({ time: 1, close: 100, side: 'long', go: true, invalidation: 96, target: 999, atr: 4, high: 100, low: 100 }),
      bar({ time: 2, close: 108, high: 110, low: 102, atr: 4 }), // stop ratchets to 110−6=104
      bar({ time: 3, close: 103, high: 106, low: 103.5, atr: 4 }), // low 103.5 < 104 → trail exit at 104
    ];
    const trail = simulateBacktest(bars, { ...CFG, exitMode: 'trail', trailAtrMult: 1.5 });
    expect(trail.trades).toHaveLength(1);
    expect(trail.trades[0].reason).toBe('trail');
    expect(trail.trades[0].exitPx).toBe(104); // ratcheted stop, locked in a gain (>100 entry)
    expect(trail.trades[0].netPnlUsd).toBeGreaterThan(0);
  });

  it('falls back to fixed behavior when bar.atr is absent in trail mode', () => {
    const bars = [
      bar({ time: 1, close: 100, side: 'long', go: true, invalidation: 95, target: 110, high: 100, low: 100 }),
      bar({ time: 2, close: 112, high: 115, low: 108 }),
    ];
    const trail = simulateBacktest(bars, { ...CFG, exitMode: 'trail' });
    expect(trail.trades[0].reason).toBe('target'); // no atr → fixed target still applies
  });
});

describe('bucketByConfidence', () => {
  const EDGES = [0.5, 0.6, 0.7, 0.8, 1.0];
  const t = (entryConfidence: number, netPnlUsd: number): BacktestTrade => ({
    side: 'long',
    entryTime: 0,
    exitTime: 1,
    entryPx: 100,
    exitPx: 100,
    barsHeld: 1,
    grossPnlUsd: netPnlUsd,
    fundingUsd: 0,
    netPnlUsd,
    reason: 'target',
    entryConfidence,
  });

  it('flags monotonic UP expectancy as CALIBRATED', () => {
    const trades = [t(0.55, -10), t(0.55, -20), t(0.65, 5), t(0.75, 20), t(0.85, 50)];
    const { monotonic, trend, buckets } = bucketByConfidence(trades, EDGES);
    expect(monotonic).toBe(true);
    expect(trend).toBe(1);
    expect(buckets[0].trades).toBe(2); // 0.50–0.60 band
    expect(buckets[0].avgNetUsd).toBe(-15);
  });

  it('flags inverted expectancy as trend −1 (do not size by it)', () => {
    const trades = [t(0.55, 50), t(0.65, 10), t(0.75, -10), t(0.85, -40)];
    const { trend } = bucketByConfidence(trades, EDGES);
    expect(trend).toBe(-1);
  });

  it('reports flat expectancy as non-calibrated (trend 0)', () => {
    const trades = [t(0.55, 10), t(0.65, 10), t(0.75, 10), t(0.85, 10)];
    const { trend, monotonic } = bucketByConfidence(trades, EDGES);
    expect(trend).toBe(0);
    expect(monotonic).toBe(true); // non-decreasing, but no upward signal
  });

  it('ignores empty bands when judging monotonicity', () => {
    const trades = [t(0.55, -5), t(0.85, 30)]; // 0.60–0.70 and 0.70–0.80 empty
    const { trend, buckets } = bucketByConfidence(trades, EDGES);
    expect(trend).toBe(1);
    expect(buckets[1].trades).toBe(0);
    expect(buckets[1].avgNetUsd).toBe(0);
  });
});
