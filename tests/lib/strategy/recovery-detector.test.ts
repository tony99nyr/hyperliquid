/**
 * Smoke test for the vendored recovery-detector (arrived without a test from
 * iamrossi). Confirms the pure function runs over candle fixtures and returns a
 * bounded score / well-formed signal. Signature:
 *   detectRecoverySignal(candles, currentIndex, crashPrice, config?)
 */
import { describe, it, expect } from 'vitest';
import { detectRecoverySignal } from '@/lib/strategy/analysis/recovery-detector';
import { generatePriceCandles } from '../../mocks/trading-data.mock';

describe('recovery-detector (vendored, pure)', () => {
  it('returns a bounded score + well-formed signal for a recovering series', () => {
    const candles = generatePriceCandles('trending-up', 120, 2000);
    // Treat the start price as the crash reference; price has recovered above it.
    const crashPrice = candles[0].close;
    const signal = detectRecoverySignal(candles, candles.length - 1, crashPrice, { enabled: true });
    expect(Number.isFinite(signal.score)).toBe(true);
    expect(signal.score).toBeGreaterThanOrEqual(0);
    expect(signal.score).toBeLessThanOrEqual(1);
    expect(typeof signal.triggered).toBe('boolean');
    expect(signal.indicators).toBeDefined();
  });

  it('returns the empty signal when there is not enough history', () => {
    const candles = generatePriceCandles('trending-up', 10, 2000);
    const signal = detectRecoverySignal(candles, 5, 2000, { enabled: true });
    expect(signal.score).toBe(0);
    expect(signal.triggered).toBe(false);
  });
});
