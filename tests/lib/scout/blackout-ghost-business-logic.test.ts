import { describe, expect, it } from 'vitest';
import { resolveBlackoutGhost } from '@/lib/scout/blackout-ghost-business-logic';

describe('resolveBlackoutGhost', () => {
  it('closes at the planned stop and reports R and dollars', () => {
    const result = resolveBlackoutGhost({
      lane: 'htf-trend', coin: 'BTC', side: 'long', entryPx: 100, stopPx: 90,
      riskUsd: 20, createdAtMs: 0, exitHorizonMs: 120_000,
    }, [
      { timestamp: 0, open: 100, high: 102, low: 95, close: 101, volume: 0, source: 'hyperliquid' },
      { timestamp: 60_000, open: 101, high: 102, low: 89, close: 91, volume: 0, source: 'hyperliquid' },
    ], '1m', 120_000);
    expect(result).toEqual({ status: 'resolved', exitPx: 90, exitAtMs: 120_000, r: -1, pnlUsd: -20, reason: 'stop-hit' });
  });

  it('waits for the horizon when the lane exit does not trigger', () => {
    const result = resolveBlackoutGhost({
      lane: 'reclaim-long', coin: 'ETH', side: 'long', entryPx: 100, stopPx: 90,
      riskUsd: 10, createdAtMs: 0, exitHorizonMs: 60_000,
    }, [{ timestamp: 0, open: 100, high: 110, low: 99, close: 108, volume: 0, source: 'hyperliquid' }], '1m', 60_000);
    expect(result).toMatchObject({ status: 'resolved', exitPx: 108, r: 0.8, pnlUsd: 8, reason: 'horizon' });
  });
});
