import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DailyCandle } from '@/lib/ladder/ladder-htf-exit-business-logic';

const mocks = vi.hoisted(() => ({ fetchCandles: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/hyperliquid/candle-service', () => ({ fetchCandles: (...args: unknown[]) => mocks.fetchCandles(...args) }));

import { __resetHtfDailyMemo, computeHtfExitIndicators, readHtfDaily } from '@/lib/ladder/ladder-htf-exit-service';
import { DAY_MS, utcDayStart } from '@/lib/ladder/ladder-htf-exit-business-logic';

const DAY = Date.UTC(2026, 10, 14);
const candles = (now: number, count = 25): DailyCandle[] => Array.from({ length: count }, (_, i) => ({
  timestamp: utcDayStart(now) - (count - i) * DAY_MS,
  high: 102 + i,
  low: 98 + i,
  close: 100 + i,
}));
const goodResult = (now: number) => ({ stale: false, error: null, candles: candles(now) });

beforeEach(() => {
  vi.clearAllMocks();
  __resetHtfDailyMemo();
  mocks.fetchCandles.mockImplementation(async (_coin: string, _interval: string, _start: number, end: number) => goodResult(end));
});

describe('readHtfDaily', () => {
  it('returns null during the first 60 seconds without fetching candles', async () => {
    expect(await readHtfDaily('BTC', DAY + 59_999)).toBeNull();
    expect(mocks.fetchCandles).not.toHaveBeenCalled();
  });

  it('returns a read at 61 seconds and fetches again on the next call', async () => {
    expect(await readHtfDaily('BTC', DAY + 61_000)).not.toBeNull();
    expect(await readHtfDaily('BTC', DAY + 62_000)).not.toBeNull();
    expect(mocks.fetchCandles).toHaveBeenCalledTimes(2);
  });

  it('memoises a good read from five minutes after the UTC day starts', async () => {
    expect(await readHtfDaily('BTC', DAY + 6 * 60_000)).not.toBeNull();
    expect(await readHtfDaily('BTC', DAY + 7 * 60_000)).not.toBeNull();
    expect(mocks.fetchCandles).toHaveBeenCalledOnce();
  });

  it.each([
    ['stale', { stale: true, error: null, candles: candles(DAY + 6 * 60_000) }],
    ['errored', { stale: false, error: 'feed failed', candles: candles(DAY + 6 * 60_000) }],
    ['invalid series', { stale: false, error: null, candles: candles(DAY + 6 * 60_000).slice(0, 10) }],
  ])('returns null for a %s candle result', async (_label, result) => {
    mocks.fetchCandles.mockResolvedValue(result);
    expect(await readHtfDaily('BTC', DAY + 6 * 60_000)).toBeNull();
  });
});

describe('computeHtfExitIndicators', () => {
  it('returns null when fetchCandles throws', async () => {
    mocks.fetchCandles.mockRejectedValue(new Error('network failure'));
    expect(await computeHtfExitIndicators('BTC', DAY + 6 * 60_000)).toBeNull();
  });
});
