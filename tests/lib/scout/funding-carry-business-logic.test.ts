import { describe, it, expect } from 'vitest';
import { fundingCarryBenchmark } from '@/lib/scout/funding-carry-business-logic';

const H = 3_600_000;
const T0 = Date.UTC(2026, 5, 1);
// Build an hourly funding series with a constant rate.
const series = (rateHourly: number, hours: number) =>
  Array.from({ length: hours + 1 }, (_, i) => ({ time: T0 + i * H, fundingHourly: rateHourly }));

describe('fundingCarryBenchmark', () => {
  it('short earns positive funding: carry = rate × hours, delta-neutral', () => {
    const b = fundingCarryBenchmark(series(0.0001, 10)); // +0.01%/h for 10h
    expect(b.side).toBe('short');
    expect(b.carryReturnFrac).toBeCloseTo(0.0001 * 10, 9); // 0.1%
    expect(b.heldHours).toBeCloseTo(10, 6);
    expect(b.exitedEarly).toBe(false);
  });

  it('long earns negative funding (shorts pay longs)', () => {
    const b = fundingCarryBenchmark(series(-0.00005, 8));
    expect(b.side).toBe('long');
    expect(b.carryReturnFrac).toBeCloseTo(0.00005 * 8, 9); // positive carry on the long side
  });

  it('negative-funding guard: exits at the flip, keeping only the favorable intervals', () => {
    // series(0.0002,5) = 6 points (hrs 0–5, all +); then hrs 6,7 negative. The +rate at
    // hr5 governs the [5,6] interval (favorable), so 6 intervals accrue; the flip is
    // detected at hr6 → exit. Carry = 0.0002 × 6.
    const flip = [
      ...series(0.0002, 5),
      { time: T0 + 6 * H, fundingHourly: -0.0002 },
      { time: T0 + 7 * H, fundingHourly: -0.0002 },
    ];
    const b = fundingCarryBenchmark(flip);
    expect(b.exitedEarly).toBe(true);
    expect(b.carryReturnFrac).toBeCloseTo(0.0002 * 6, 9);
    expect(b.heldHours).toBeCloseTo(6, 6);
  });

  it('thin / flat series → zero carry, no side', () => {
    expect(fundingCarryBenchmark([]).side).toBeNull();
    expect(fundingCarryBenchmark(series(0, 10)).carryReturnFrac).toBe(0);
  });
});
