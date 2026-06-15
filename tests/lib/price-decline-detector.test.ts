/**
 * Unit tests for Price Decline Detector
 *
 * Tests pure functions for detecting rapid price declines.
 */

import { describe, it, expect } from 'vitest';
import {
  detectPriceDecline,
  calculatePriceChanges,
  DEFAULT_DECLINE_THRESHOLDS,
  type PriceDeclineThresholds,
} from '@/lib/strategy/analysis/price-decline-detector';

describe('detectPriceDecline', () => {
  const thresholds: PriceDeclineThresholds = {
    singlePeriod: 0.04, // 4%
    shortTerm: 0.025, // 2.5%
    mediumTerm: 0.03, // 3%
  };

  describe('single-period crash detection', () => {
    it('should detect 5% single-period drop', () => {
      const result = detectPriceDecline(
        950, // current price
        { onePeriodAgo: 1000 }, // 5% drop
        thresholds
      );

      expect(result.isDecline).toBe(true);
      expect(result.severity).toBe('single');
      expect(result.percentChange).toBeCloseTo(-5, 1);
      expect(result.periodsAnalyzed).toBe(1);
    });

    it('should NOT detect 3% single-period drop (below threshold)', () => {
      const result = detectPriceDecline(
        970, // current price
        { onePeriodAgo: 1000 }, // 3% drop
        thresholds
      );

      expect(result.isDecline).toBe(false);
      expect(result.severity).toBe('none');
    });

    it('should NOT detect price increase', () => {
      const result = detectPriceDecline(
        1050, // current price
        { onePeriodAgo: 1000 }, // 5% increase
        thresholds
      );

      expect(result.isDecline).toBe(false);
      expect(result.severity).toBe('none');
    });
  });

  describe('short-term decline detection', () => {
    it('should detect 3% short-term drop over 10 periods', () => {
      const result = detectPriceDecline(
        970, // current price
        { tenPeriodsAgo: 1000 }, // 3% drop
        thresholds
      );

      expect(result.isDecline).toBe(true);
      expect(result.severity).toBe('short');
      expect(result.percentChange).toBeCloseTo(-3, 1);
      expect(result.periodsAnalyzed).toBe(10);
    });

    it('should NOT detect 2% short-term drop (below threshold)', () => {
      const result = detectPriceDecline(
        980, // current price
        { tenPeriodsAgo: 1000 }, // 2% drop
        thresholds
      );

      expect(result.isDecline).toBe(false);
    });
  });

  describe('medium-term decline detection', () => {
    it('should detect 4% medium-term drop over 20 periods', () => {
      const result = detectPriceDecline(
        960, // current price
        { twentyPeriodsAgo: 1000 }, // 4% drop
        thresholds
      );

      expect(result.isDecline).toBe(true);
      expect(result.severity).toBe('medium');
      expect(result.percentChange).toBeCloseTo(-4, 1);
      expect(result.periodsAnalyzed).toBe(20);
    });

    it('should NOT detect 2.5% medium-term drop (below threshold)', () => {
      const result = detectPriceDecline(
        975, // current price
        { twentyPeriodsAgo: 1000 }, // 2.5% drop
        thresholds
      );

      expect(result.isDecline).toBe(false);
    });
  });

  describe('priority order (most immediate first)', () => {
    it('should prioritize single-period over short-term', () => {
      const result = detectPriceDecline(
        950, // current price
        {
          onePeriodAgo: 1000, // 5% drop (triggers single)
          tenPeriodsAgo: 1000, // 5% drop (would trigger short)
        },
        thresholds
      );

      expect(result.severity).toBe('single');
      expect(result.periodsAnalyzed).toBe(1);
    });

    it('should prioritize short-term over medium-term', () => {
      const result = detectPriceDecline(
        970, // current price
        {
          tenPeriodsAgo: 1000, // 3% drop (triggers short)
          twentyPeriodsAgo: 1000, // 3% drop (would trigger medium)
        },
        thresholds
      );

      expect(result.severity).toBe('short');
      expect(result.periodsAnalyzed).toBe(10);
    });
  });

  describe('missing data handling', () => {
    it('should handle missing single-period data', () => {
      const result = detectPriceDecline(
        950,
        { tenPeriodsAgo: 1000 }, // only short-term available
        thresholds
      );

      expect(result.isDecline).toBe(true);
      expect(result.severity).toBe('short');
    });

    it('should handle no historical data', () => {
      const result = detectPriceDecline(
        950,
        {}, // no historical data
        thresholds
      );

      expect(result.isDecline).toBe(false);
      expect(result.severity).toBe('none');
    });
  });

  describe('custom thresholds', () => {
    it('should respect custom thresholds', () => {
      const customThresholds: PriceDeclineThresholds = {
        singlePeriod: 0.10, // 10% (much higher)
        shortTerm: 0.05, // 5%
        mediumTerm: 0.05, // 5%
      };

      const result = detectPriceDecline(
        950, // 5% drop
        { onePeriodAgo: 1000 },
        customThresholds
      );

      expect(result.isDecline).toBe(false); // 5% < 10% threshold
    });
  });
});

describe('calculatePriceChanges', () => {
  const candles = [
    { close: 1000 }, // index 0
    { close: 1010 }, // index 1
    { close: 1020 }, // index 2
    { close: 1030 }, // index 3
    { close: 1040 }, // index 4
    { close: 1050 }, // index 5
    { close: 1060 }, // index 6
    { close: 1070 }, // index 7
    { close: 1080 }, // index 8
    { close: 1090 }, // index 9
    { close: 1100 }, // index 10
    { close: 1110 }, // index 11
    { close: 1120 }, // index 12
    { close: 1130 }, // index 13
    { close: 1140 }, // index 14
    { close: 1150 }, // index 15
    { close: 1160 }, // index 16
    { close: 1170 }, // index 17
    { close: 1180 }, // index 18
    { close: 1190 }, // index 19
    { close: 1200 }, // index 20
    { close: 1150 }, // index 21 (drop)
  ];

  it('should calculate all changes when sufficient data', () => {
    const changes = calculatePriceChanges(candles, 21);

    expect(changes.singlePeriod).toBeCloseTo(-0.0417, 4); // (1150 - 1200) / 1200
    expect(changes.shortTerm).toBeCloseTo(0.036, 3); // (1150 - 1110) / 1110 [index 21 - index 11]
    expect(changes.mediumTerm).toBeCloseTo(0.1386, 3); // (1150 - 1010) / 1010 [index 21 - index 1]
  });

  it('should only calculate single-period when index < 10', () => {
    const changes = calculatePriceChanges(candles, 5);

    expect(changes.singlePeriod).toBeDefined();
    expect(changes.shortTerm).toBeUndefined();
    expect(changes.mediumTerm).toBeUndefined();
  });

  it('should calculate single and short-term when 10 <= index < 20', () => {
    const changes = calculatePriceChanges(candles, 15);

    expect(changes.singlePeriod).toBeDefined();
    expect(changes.shortTerm).toBeDefined();
    expect(changes.mediumTerm).toBeUndefined();
  });

  it('should handle first candle (index 0)', () => {
    const changes = calculatePriceChanges(candles, 0);

    expect(changes.singlePeriod).toBeUndefined();
    expect(changes.shortTerm).toBeUndefined();
    expect(changes.mediumTerm).toBeUndefined();
  });

  it('should handle invalid index', () => {
    const changes = calculatePriceChanges(candles, 999);

    expect(changes.singlePeriod).toBeUndefined();
    expect(changes.shortTerm).toBeUndefined();
    expect(changes.mediumTerm).toBeUndefined();
  });
});

describe('DEFAULT_DECLINE_THRESHOLDS', () => {
  it('should have reasonable default values', () => {
    expect(DEFAULT_DECLINE_THRESHOLDS.singlePeriod).toBe(0.04); // 4%
    expect(DEFAULT_DECLINE_THRESHOLDS.shortTerm).toBe(0.025); // 2.5%
    expect(DEFAULT_DECLINE_THRESHOLDS.mediumTerm).toBe(0.03); // 3%
  });

  it('should be progressively more lenient for longer periods', () => {
    // Longer periods should allow larger declines before triggering
    expect(DEFAULT_DECLINE_THRESHOLDS.singlePeriod).toBeGreaterThan(
      DEFAULT_DECLINE_THRESHOLDS.mediumTerm
    );
  });
});
