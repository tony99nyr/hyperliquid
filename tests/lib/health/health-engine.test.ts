import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PriceCandle } from '@/types/trading-core';

vi.mock('@/lib/hyperliquid/candle-service', () => ({
  fetchMultiTimeframeCandles: vi.fn(),
}));
vi.mock('@/lib/cockpit/health-snapshot-service', () => ({
  writeHealthSnapshot: vi.fn(),
}));

import { fetchMultiTimeframeCandles } from '@/lib/hyperliquid/candle-service';
import { writeHealthSnapshot } from '@/lib/cockpit/health-snapshot-service';
import {
  assessHealth,
  assessAndPersistHealth,
  loadHealthWeights,
  _resetHealthWeights,
} from '@/lib/health/health-engine';

const mockedFetch = vi.mocked(fetchMultiTimeframeCandles);
const mockedWrite = vi.mocked(writeHealthSnapshot);

const HOUR = 60 * 60 * 1000;
function series(count: number, start: number, stepReturn: number): PriceCandle[] {
  const out: PriceCandle[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price * (1 + stepReturn);
    out.push({
      timestamp: i * HOUR,
      open,
      high: Math.max(open, close) * 1.001,
      low: Math.min(open, close) * 0.999,
      close,
      volume: 1000,
    });
    price = close;
  }
  return out;
}

beforeEach(() => {
  _resetHealthWeights();
  mockedFetch.mockReset();
  mockedWrite.mockReset();
  // candle-service is called once per timeframe ([tf]); return the matching set.
  mockedFetch.mockImplementation(async (_coin, intervals) => {
    const tf = intervals[0];
    return {
      [tf]: {
        coin: 'ETH',
        interval: tf,
        candles: series(220, 1000, 0.01),
        fetchedAt: 0,
        stale: false,
      },
    } as Awaited<ReturnType<typeof fetchMultiTimeframeCandles>>;
  });
});

describe('health-engine (I/O)', () => {
  it('loadHealthWeights reads the active versioned config', () => {
    const w = loadHealthWeights();
    expect(w.version).toBe('0.1.0');
    expect(w.timeframeWeights['1d']).toBeGreaterThan(0);
  });

  it('assessHealth fetches all four timeframes and composes a result', async () => {
    const result = await assessHealth('ETH', { side: 'long', entryPx: 1000 });
    // One fetch per timeframe.
    expect(mockedFetch).toHaveBeenCalledTimes(4);
    expect(result.score).toBeGreaterThan(50); // bull-aligned long
    expect(result.timeframeReads).toHaveLength(4);
  });

  it('assessAndPersistHealth writes the snapshot via the snapshot service', async () => {
    const result = await assessAndPersistHealth('sess-1', 'ETH', { side: 'long', entryPx: 1000 });
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    const arg = mockedWrite.mock.calls[0][0];
    expect(arg.sessionId).toBe('sess-1');
    expect(arg.score).toBe(result.score);
    expect(arg.alerts).toEqual(result.alerts);
  });
});
