import { describe, it, expect } from 'vitest';
import {
  modelFeeUsd,
  HL_TAKER_FEE_BPS,
  HL_MAKER_FEE_BPS,
} from '@/lib/trading/paper-fee-model';

describe('paper-fee-model (pure)', () => {
  it('documents the assumed HL base-tier schedule', () => {
    expect(HL_TAKER_FEE_BPS).toBe(4.5);
    expect(HL_MAKER_FEE_BPS).toBe(1.5);
  });

  it('taker fee = 4.5 bps of notional', () => {
    // $10,000 * 0.045% = $4.50
    expect(modelFeeUsd(10_000, 'taker')).toBeCloseTo(4.5, 9);
  });

  it('maker fee = 1.5 bps of notional', () => {
    expect(modelFeeUsd(10_000, 'maker')).toBeCloseTo(1.5, 9);
  });

  it('defaults to taker', () => {
    expect(modelFeeUsd(10_000)).toBe(modelFeeUsd(10_000, 'taker'));
  });

  it('returns 0 for non-positive notional', () => {
    expect(modelFeeUsd(0)).toBe(0);
    expect(modelFeeUsd(-5)).toBe(0);
  });
});
