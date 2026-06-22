import { describe, it, expect, afterEach } from 'vitest';
import { assertScoutPaperMode, ScoutLiveExecutionError } from '@/lib/scout/scout-execution-guard';
import { executeIntent } from '@/lib/trading/fill-source';
import type { TradeIntent } from '@/types/fill';

describe('assertScoutPaperMode — no-auto-fire-for-real-money guarantee', () => {
  it('permits paper mode', () => {
    expect(() => assertScoutPaperMode('paper')).not.toThrow();
  });

  it('REFUSES live mode (scout never auto-fires real funds)', () => {
    expect(() => assertScoutPaperMode('live')).toThrow(ScoutLiveExecutionError);
  });
});

describe('executeIntent seam guard — scout intents can never fire live', () => {
  const prev = process.env.TRADING_MODE;
  afterEach(() => {
    if (prev === undefined) delete process.env.TRADING_MODE;
    else process.env.TRADING_MODE = prev;
  });

  const scoutIntent: TradeIntent = {
    clientIntentId: 'test', sessionId: 's', coin: 'ETH', side: 'buy', sz: 1,
    reduceOnly: false, origin: 'scout', createdAt: 0,
  };

  it('throws (before any fill) for a scout-origin intent in live mode', async () => {
    process.env.TRADING_MODE = 'live';
    await expect(executeIntent(scoutIntent)).rejects.toThrow(ScoutLiveExecutionError);
  });
});
