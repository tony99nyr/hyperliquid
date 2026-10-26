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

  it('a brief flip inside the trailing window: stays in and pays the adverse hour', () => {
    // 6 points at +0.0002 then 2 at -0.0002. The 24-point trailing mean stays positive,
    // so the position holds and the [6,7] interval costs 0.0002.
    const flip = [
      ...series(0.0002, 5),
      { time: T0 + 6 * H, fundingHourly: -0.0002 },
      { time: T0 + 7 * H, fundingHourly: -0.0002 },
    ];
    const b = fundingCarryBenchmark(flip);
    expect(b.exitedEarly).toBe(false);
    expect(b.entries).toBe(1);
    expect(b.carryReturnFrac).toBeCloseTo(0.0002 * 6 - 0.0002, 9);
    expect(b.heldHours).toBeCloseTo(7, 6);
    expect(b.spanHours).toBeCloseTo(7, 6);
  });

  it('a sustained flip exits, then re-enters when funding recovers (the old benchmark never re-entered)', () => {
    // 10h at +0.0001, 30h at -0.0001, 40h at +0.0001 (hourly points).
    const pts = Array.from({ length: 81 }, (_, i) => ({
      time: T0 + i * H,
      fundingHourly: i < 10 ? 0.0001 : i < 40 ? -0.0001 : 0.0001,
    }));
    const b = fundingCarryBenchmark(pts);
    expect(b.side).toBe('short');
    expect(b.exitedEarly).toBe(true);
    expect(b.entries).toBe(2);
    expect(b.spanHours).toBeCloseTo(80, 6);
    expect(b.heldHours).toBeLessThan(80);
    // Second entry is after the trailing mean turns positive again, so the late
    // positive stretch adds carry after the exit.
    expect(b.carryReturnFrac).toBeGreaterThan(0);
  });

  it('thin / flat series → zero carry, no side', () => {
    expect(fundingCarryBenchmark([]).side).toBeNull();
    expect(fundingCarryBenchmark(series(0, 10)).carryReturnFrac).toBe(0);
  });
});
