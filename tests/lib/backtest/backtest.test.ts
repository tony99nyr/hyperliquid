import { describe, it, expect } from 'vitest';
import { simulateBacktest, type BacktestBar, type BacktestSimConfig } from '@/lib/backtest/backtest-business-logic';

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

  it('slippage worsens both legs (a clean target win nets less than gross move)', () => {
    const bars: BacktestBar[] = [
      bar({ time: 1, close: 100, go: true, side: 'long', invalidation: 95, target: 110 }),
      bar({ time: 2, close: 110, high: 110, low: 100 }),
    ];
    const noSlip = simulateBacktest(bars, { ...CFG, slippageBps: 0 });
    const withSlip = simulateBacktest(bars, { ...CFG, slippageBps: 20 });
    expect(withSlip.trades[0].netPnlUsd).toBeLessThan(noSlip.trades[0].netPnlUsd);
  });
});
