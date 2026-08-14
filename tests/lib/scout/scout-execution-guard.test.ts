import { describe, it, expect, afterEach } from 'vitest';
import {
  assertScoutPaperMode,
  ScoutLiveExecutionError,
  assertLaneAlive,
  ScoutKilledLaneError,
  KILLED_LANES,
} from '@/lib/scout/scout-execution-guard';
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

describe('assertLaneAlive — deterministic kill-bar enforcement (08-13 review)', () => {
  it('refuses every killed lane (directional, reversion, trend-follow)', () => {
    for (const lane of ['directional', 'reversion', 'trend-follow']) {
      expect(KILLED_LANES.has(lane)).toBe(true);
      expect(() => assertLaneAlive(lane)).toThrow(ScoutKilledLaneError);
    }
  });

  it('is case/whitespace-insensitive (a sloppy tag cannot dodge the kill)', () => {
    expect(() => assertLaneAlive(' Trend-Follow ')).toThrow(ScoutKilledLaneError);
    expect(() => assertLaneAlive('REVERSION')).toThrow(ScoutKilledLaneError);
  });

  it('kills variant/alias tags of a killed lane (prefix rule — no resurrection by rename)', () => {
    expect(() => assertLaneAlive('reversion-extreme')).toThrow(ScoutKilledLaneError); // the daemon trigger's own wording
    expect(() => assertLaneAlive('trend-follow-v2')).toThrow(ScoutKilledLaneError);
    // But a genuinely NEW lane whose name merely contains a killed word survives:
    expect(() => assertLaneAlive('htf-trend')).not.toThrow();
  });

  it('permits the live lanes', () => {
    for (const lane of ['htf-trend', 'rubric-crossing', 'leader-follow', 'vault', 'carry']) {
      expect(() => assertLaneAlive(lane)).not.toThrow();
    }
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
