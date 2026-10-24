import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/hyperliquid/candle-service', () => ({ fetchCandles: vi.fn(), fetchFundingHistory: vi.fn(async () => []), fundingRateAt: vi.fn(() => 0) }));
vi.mock('@/lib/strategy/analysis/market-regime-detector', () => ({ detectMarketRegime: vi.fn(() => ({ regime: 'bullish', confidence: 1, indicators: { trend: 1, momentum: 1, volatility: 1 } })) }));
vi.mock('@/lib/strategy/indicators/indicators', () => ({ calculateATR: vi.fn((candles: unknown[]) => candles.map(() => 1)), calculateBollingerBands: vi.fn() }));
vi.mock('@/lib/rubric/rubric-gates-business-logic', () => ({ deriveLevels: vi.fn((price: number) => ({ invalidation: price - 10, target: price + 10 })) }));

import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { runBacktest } from '@/lib/backtest/backtest-replay-service';
import type { PriceCandle } from '@/types/trading-core';

describe('runBacktest orchestration', () => {
  it('replay_applies_only_completed_htf_veto', async () => {
    const hour = 3_600_000;
    const lower = Array.from({ length: 65 }, (_, index): PriceCandle => ({ timestamp: index * hour, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
    const higher = Array.from({ length: 61 }, (_, index): PriceCandle => ({ timestamp: index === 60 ? 40 * hour : index * hour, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
    vi.mocked(fetchCandles).mockImplementation(async (_coin, interval) => ({ candles: interval === '1d' ? higher : lower, coin: 'ETH', interval, fetchedAt: 0, stale: false }));
    const result = await runBacktest({ coin: 'ETH', days: 10, interval: '1h', endMs: 100 * hour, htfFilter: true, htfInterval: '1d' });
    expect(result.result.trades).toHaveLength(1);
    expect(result.result.trades[0].entryTime).toBe(64 * hour);
  });
});
