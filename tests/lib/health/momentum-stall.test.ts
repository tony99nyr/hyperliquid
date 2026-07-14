/**
 * Momentum-stall composite — the deterministic "is the move out of participants?"
 * math behind indicator exit rungs. Missing data must NEVER vote for a stall.
 */
import { describe, it, expect } from 'vitest';
import {
  MOMENTUM_STALL_LONG,
  MOMENTUM_STALL_SHORT,
  SUPPORTED_INDICATOR_NAMES,
  momentumStallIndicatorName,
} from '@/lib/ladder/ladder-types';
import {
  momentumStallVerdict,
  volumeFade,
  cvdNonConfirmation,
  bookAgainst,
  CANDLES_REQUIRED,
  type MomentumCandle,
  type MomentumSeriesPoint,
} from '@/lib/health/momentum-stall-business-logic';

/** Build a candle: up/down decides open/close order; extreme via high/low. */
function bar(up: boolean, volume: number, base = 100, range = 1): MomentumCandle {
  return up
    ? { openPx: base, closePx: base + range, highPx: base + range, lowPx: base, volume }
    : { openPx: base + range, closePx: base, highPx: base + range, lowPx: base, volume };
}

/** N candles trending up with fixed volume (fresh extreme on the last bar). */
function upTrend(n: number, vol = 100): MomentumCandle[] {
  return Array.from({ length: n }, (_, i) => ({
    openPx: 100 + i,
    closePx: 101 + i,
    highPx: 101.2 + i,
    lowPx: 99.8 + i,
    volume: vol,
  }));
}

const pt = (takerFlow: number | null, bookImbalance: number | null): MomentumSeriesPoint => ({ takerFlow, bookImbalance });

describe('volumeFade', () => {
  it('flips when counter-trend bars out-volume with-trend bars', () => {
    // Long: 4 up-bars @50 vol, 4 down-bars @200 vol → sellers doing the volume.
    const candles = [...upTrend(CANDLES_REQUIRED - 8), ...Array.from({ length: 4 }, () => bar(true, 50)), ...Array.from({ length: 4 }, () => bar(false, 200))];
    expect(volumeFade('long', candles)).toBe(true);
  });

  it('does NOT flip on an all-one-way window (trend, not fade) or thin data', () => {
    expect(volumeFade('long', upTrend(CANDLES_REQUIRED))).toBe(false); // all up-bars
    expect(volumeFade('long', upTrend(CANDLES_REQUIRED - 1))).toBe(false); // too few bars
  });

  it('mirrors for shorts (up-bars out-volume = against the short)', () => {
    const candles = [...upTrend(CANDLES_REQUIRED - 8), ...Array.from({ length: 4 }, () => bar(false, 50)), ...Array.from({ length: 4 }, () => bar(true, 200))];
    expect(volumeFade('short', candles)).toBe(true);
  });
});

describe('cvdNonConfirmation', () => {
  const freshHighCandles = upTrend(CANDLES_REQUIRED); // last bar = fresh 12-bar high

  it('flips when a fresh high prints but taker flow is fading', () => {
    const series = [pt(0.6, 0), pt(0.5, 0), pt(0.5, 0), pt(0.2, 0), pt(0.1, 0), pt(0.0, 0)];
    expect(cvdNonConfirmation('long', freshHighCandles, series)).toBe(true);
  });

  it('does NOT flip when flow is strengthening with the high', () => {
    const series = [pt(0.1, 0), pt(0.1, 0), pt(0.2, 0), pt(0.5, 0), pt(0.6, 0), pt(0.7, 0)];
    expect(cvdNonConfirmation('long', freshHighCandles, series)).toBe(false);
  });

  it('does NOT flip on a mere tick-down while flow is still strongly with-trend (F3)', () => {
    const series = [pt(0.7, 0), pt(0.7, 0), pt(0.7, 0), pt(0.6, 0), pt(0.6, 0), pt(0.6, 0)];
    expect(cvdNonConfirmation('long', freshHighCandles, series)).toBe(false); // 0.6 > half of 0.7
  });

  it('does NOT flip without a fresh extreme, and never on a thin/null series', () => {
    // No fresh high: last 3 bars below the 12-bar high.
    const noExtreme = [...upTrend(CANDLES_REQUIRED - 3, 100), bar(false, 100, 90), bar(false, 100, 89), bar(false, 100, 88)];
    expect(cvdNonConfirmation('long', noExtreme, [pt(0.9, 0), pt(0.1, 0), pt(0, 0), pt(0, 0), pt(0, 0), pt(0, 0)])).toBe(false);
    // Thin series (nulls filtered → < 6 points) must not page.
    const thin = [pt(null, 0), pt(null, 0), pt(0.1, 0), pt(0.1, 0), pt(0.1, 0), pt(null, 0)];
    expect(cvdNonConfirmation('long', freshHighCandles, thin)).toBe(false);
  });

  it('mirrors for shorts: fresh low + selling pressure fading = non-confirmation', () => {
    const downTrend: MomentumCandle[] = Array.from({ length: CANDLES_REQUIRED }, (_, i) => ({
      openPx: 200 - i,
      closePx: 199 - i,
      highPx: 200.2 - i,
      lowPx: 198.8 - i,
      volume: 100,
    }));
    const fadingSells = [pt(-0.6, 0), pt(-0.5, 0), pt(-0.5, 0), pt(-0.1, 0), pt(0.0, 0), pt(0.1, 0)];
    expect(cvdNonConfirmation('short', downTrend, fadingSells)).toBe(true);
  });
});

describe('bookAgainst', () => {
  it('flips only on PERSISTENT lean against the position', () => {
    expect(bookAgainst('long', [pt(0, -0.2), pt(0, -0.3), pt(0, -0.16)])).toBe(true);
    expect(bookAgainst('long', [pt(0, -0.2), pt(0, 0.1), pt(0, -0.3)])).toBe(false); // one flip breaks persistence
    expect(bookAgainst('short', [pt(0, 0.2), pt(0, 0.25), pt(0, 0.3)])).toBe(true);
  });

  it('never flips on thin/null series', () => {
    expect(bookAgainst('long', [pt(0, -0.5), pt(0, null), pt(0, null)])).toBe(false);
    expect(bookAgainst('long', [])).toBe(false);
  });
});

describe('momentumStallVerdict — 2-of-3 composite', () => {
  it('stalls at 2 flips, not at 1', () => {
    // volume fade + cvd non-confirmation, book neutral.
    const candles = [
      ...upTrend(CANDLES_REQUIRED - 8, 100),
      ...Array.from({ length: 4 }, (_, i) => ({ openPx: 108 + i, closePx: 109 + i, highPx: 109.2 + i, lowPx: 107.8 + i, volume: 50 })),
      ...Array.from({ length: 4 }, (_, i) => ({ openPx: 113 - i * 0.1, closePx: 112 - i * 0.1, highPx: 113.5 + (i === 3 ? 1 : 0), lowPx: 111.8, volume: 200 })),
    ];
    const series = [pt(0.6, 0), pt(0.5, 0), pt(0.5, 0), pt(0.1, 0), pt(0.0, 0), pt(-0.1, 0)];
    const v = momentumStallVerdict({ side: 'long', candles, series });
    expect(v.flipped.length).toBeGreaterThanOrEqual(2);
    expect(v.stalled).toBe(true);

    const oneFlip = momentumStallVerdict({ side: 'long', candles: upTrend(CANDLES_REQUIRED), series });
    expect(oneFlip.stalled).toBe(false);
  });

  it('empty inputs → zero flips, never a stall', () => {
    const v = momentumStallVerdict({ side: 'long', candles: [], series: [] });
    expect(v.stalled).toBe(false);
    expect(v.flipped).toEqual([]);
  });
});

describe('indicator-name SSOT (ladder-types) — producer/consumer sync pin', () => {
  it('the helper, the constants, and the supported list all agree', () => {
    expect(momentumStallIndicatorName('long')).toBe(MOMENTUM_STALL_LONG);
    expect(momentumStallIndicatorName('short')).toBe(MOMENTUM_STALL_SHORT);
    expect(SUPPORTED_INDICATOR_NAMES).toEqual([MOMENTUM_STALL_LONG, MOMENTUM_STALL_SHORT]);
    // The literal wire format is part of the persisted rung contract (triggerMeta
    // .indicatorName in armed ladders) — a rename is a MIGRATION, not a refactor.
    expect(MOMENTUM_STALL_LONG).toBe('momentum-stall-long');
    expect(MOMENTUM_STALL_SHORT).toBe('momentum-stall-short');
  });
});
