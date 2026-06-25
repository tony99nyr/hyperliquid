import { describe, it, expect } from 'vitest';
import { computeTraderFingerprint, reconstructRoundTrips, MIN_FILLS } from '@/lib/hyperliquid/trader-fingerprint-business-logic';
import type { HlFill, HlClearinghouseState } from '@/lib/hyperliquid/hyperliquid-info-service';

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

function fill(over: Partial<HlFill>): HlFill {
  return { coin: 'ETH', px: 1000, sz: 1, side: 'buy', time: T0, closedPnl: 0, dir: 'Open Long', fee: 0, oid: 0, hash: '', startPosition: '0', ...over } as unknown as HlFill;
}
function state(over: Partial<HlClearinghouseState> = {}): HlClearinghouseState {
  return { address: '0xabc', accountValueUsd: 10000, totalMarginUsed: 0, totalNotionalPosition: 0, withdrawableUsd: 0, positions: [], fetchedAt: T0, stale: false, ...over } as HlClearinghouseState;
}

/** Build N clean intraday round-trips (open buy → close sell +pnl) across a few coins. */
function cleanFills(n: number): HlFill[] {
  const out: HlFill[] = [];
  for (let i = 0; i < n; i++) {
    const coin = ['ETH', 'BTC', 'SOL'][i % 3];
    const t = T0 + i * 6 * HOUR;
    out.push(fill({ coin, side: 'buy', sz: 1, time: t, closedPnl: 0, dir: 'Open Long' }));
    out.push(fill({ coin, side: 'sell', sz: 1, time: t + 2 * HOUR, closedPnl: 20, dir: 'Close Long' }));
  }
  return out;
}

describe('reconstructRoundTrips', () => {
  it('pairs an open + close into one trip with the right hold + pnl', () => {
    const trips = reconstructRoundTrips([
      fill({ side: 'buy', sz: 2, time: T0 }),
      fill({ side: 'sell', sz: 2, time: T0 + 3 * HOUR, closedPnl: 50 }),
    ]);
    expect(trips).toHaveLength(1);
    expect(trips[0].holdMs).toBe(3 * HOUR);
    expect(trips[0].pnl).toBe(50);
  });
});

describe('computeTraderFingerprint', () => {
  it('thin history (< MIN_FILLS) → caution / insufficient', () => {
    const fp = computeTraderFingerprint(cleanFills(5), state(), 30); // 10 fills < 50
    expect(fp.metrics.nFills).toBeLessThan(MIN_FILLS);
    expect(fp.verdict).toBe('caution');
    expect(fp.persistenceConfidence).toBe('insufficient');
  });

  it('clean intraday concentrated winner → follow (single-window)', () => {
    const fp = computeTraderFingerprint(cleanFills(40), state(), 30); // 80 fills, 40 trips
    expect(fp.verdict).toBe('follow');
    expect(fp.persistenceConfidence).toBe('single-window');
    expect(fp.metrics.winRate).toBe(1);
    expect(fp.holdDistribution).not.toBeNull();
    expect(fp.roundTripSeries.length).toBeGreaterThan(0);
  });

  it('a liquidation fill forces AVOID', () => {
    const fills = [...cleanFills(40), fill({ coin: 'ETH', side: 'sell', sz: 5, time: T0 + 999 * HOUR, dir: 'Liquidated Long', closedPnl: -500 })];
    const fp = computeTraderFingerprint(fills, state(), 30);
    expect(fp.verdict).toBe('avoid');
    expect(fp.metrics.liquidations).toBe(1);
    expect(fp.why).toMatch(/liquidation/i);
  });
});
