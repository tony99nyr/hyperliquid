import { describe, it, expect } from 'vitest';
import { computeHouseholdExposure, stackingUsd } from '@/lib/household/household-exposure-business-logic';

const marks = { ethUsd: 2000, btcUsd: 60000 };

describe('computeHouseholdExposure', () => {
  it('values collateral balances at mark and picks the dominant leg', () => {
    const e = computeHouseholdExposure({ weEth: 7, wBtc: 0.01, usdc: 500 }, marks);
    expect(e.ethExposureUsd).toBe(14000);
    expect(e.btcExposureUsd).toBe(600);
    expect(e.stablesUsd).toBe(500);
    expect(e.netCryptoBetaUsd).toBe(14600);
    expect(e.dominant).toBe('ETH');
  });

  it('BTC-dominant when wBtc value exceeds weETH value', () => {
    const e = computeHouseholdExposure({ weEth: 0.1, wBtc: 0.5, usdc: 0 }, marks);
    expect(e.dominant).toBe('BTC');
  });

  it('dominant none when both legs are dust', () => {
    const e = computeHouseholdExposure({ weEth: 0, wBtc: 0, usdc: 1000 }, marks);
    expect(e.dominant).toBe('none');
    expect(e.netCryptoBetaUsd).toBe(0);
  });

  it('never negative or NaN on garbage balances / zero / NaN marks', () => {
    const e = computeHouseholdExposure({ weEth: -5, wBtc: NaN, usdc: -10 }, { ethUsd: 0, btcUsd: NaN });
    expect(e.ethExposureUsd).toBe(0);
    expect(e.btcExposureUsd).toBe(0);
    expect(e.stablesUsd).toBe(0);
    expect(e.netCryptoBetaUsd).toBe(0);
    expect(e.dominant).toBe('none'); // NaN must not mis-resolve to a leg
  });
});

describe('stackingUsd', () => {
  const exposure = computeHouseholdExposure({ weEth: 7, wBtc: 0, usdc: 0 }, marks); // $14k long ETH

  it('a cockpit LONG on the same coin ADDS correlated beta', () => {
    const s = stackingUsd(exposure, 'ETH', +200); // cockpit +$200 long ETH
    expect(s.householdLegUsd).toBe(14000);
    expect(s.combinedUsd).toBe(14200);
    expect(s.addsCorrelation).toBe(true);
  });

  it('a cockpit SHORT on the household-long coin REDUCES net delta (partial hedge)', () => {
    const s = stackingUsd(exposure, 'ETH', -200); // cockpit -$200 short ETH
    expect(s.combinedUsd).toBe(13800);
    expect(s.addsCorrelation).toBe(false); // opposite direction is not stacking
  });

  it('a coin the household is flat on never reads as stacking', () => {
    const s = stackingUsd(exposure, 'BTC', +200);
    expect(s.householdLegUsd).toBe(0);
    expect(s.addsCorrelation).toBe(false);
  });
});
