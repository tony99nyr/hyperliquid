import { describe, it, expect, afterEach } from 'vitest';
import {
  assertScoutPaperMode,
  ScoutLiveExecutionError,
  assertLaneAlive,
  ScoutKilledLaneError,
  ScoutUnregisteredLaneError,
  KILLED_LANES,
  assertPortfolioCap,
  ScoutPortfolioCapError,
  assertEventClear,
  ScoutEventBlackoutError,
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

  it('permits every REGISTERED lane', () => {
    for (const lane of ['htf-trend', 'compression-straddle', 'breakdown-short', 'reclaim-long', 'leader-follow', 'vault', 'carry']) {
      expect(() => assertLaneAlive(lane)).not.toThrow();
    }
  });

  it('REFUSES unregistered lanes (allowlist — no lane trades without a pre-registration)', () => {
    for (const lane of ['rubric-crossing', 'my-new-idea', 'reversion2', 'scalp', '']) {
      expect(() => assertLaneAlive(lane)).toThrow(ScoutUnregisteredLaneError);
    }
  });
});

describe('assertPortfolioCap — correlated majors are ONE bet (Tier-1, 08-20)', () => {
  it('refuses a 3rd same-direction major (the 4-long stack of 08-19)', () => {
    expect(() => assertPortfolioCap('htf-trend', 'BTC', 2)).toThrow(ScoutPortfolioCapError);
    expect(() => assertPortfolioCap('htf-trend', 'BTC', 4)).toThrow(ScoutPortfolioCapError);
  });

  it('permits up to the cap, passive lanes, and non-major coins', () => {
    expect(() => assertPortfolioCap('htf-trend', 'BTC', 1)).not.toThrow();
    expect(() => assertPortfolioCap('vault', 'BTC', 4)).not.toThrow(); // passive exempt
    expect(() => assertPortfolioCap('leader-follow', 'DOGE', 4)).not.toThrow(); // non-major exempt
  });
});

describe('assertEventClear — the pre-print entry blackout (Tier-1, 08-20)', () => {
  const H = 3_600_000;
  it('refuses a directional open inside 48h of a print', () => {
    expect(() => assertEventClear('htf-trend', 'Jackson Hole', 47 * H)).toThrow(ScoutEventBlackoutError);
    expect(() => assertEventClear('htf-trend', 'FOMC', 1 * H)).toThrow(ScoutEventBlackoutError);
  });

  it('permits beyond the window, with no event, and for passive lanes', () => {
    expect(() => assertEventClear('htf-trend', 'Jackson Hole', 49 * H)).not.toThrow();
    expect(() => assertEventClear('htf-trend', null, null)).not.toThrow();
    expect(() => assertEventClear('carry', 'FOMC', 1 * H)).not.toThrow(); // passive exempt
  });

  it('refuses AT the exact 48h boundary (<= semantics) and in the post-print window', () => {
    expect(() => assertEventClear('htf-trend', 'FOMC', 48 * H)).toThrow(ScoutEventBlackoutError); // boundary
    expect(() => assertEventClear('htf-trend', 'FOMC', -2 * H)).toThrow(ScoutEventBlackoutError); // printed 2h ago
    expect(() => assertEventClear('htf-trend', 'FOMC', -2 * H)).toThrow(/printed .*ago/); // post-print message
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
