import { describe, expect, it } from 'vitest';
import { evaluateDvolStraddles, realisedVolatility, type DvolObservation, type DailyClose, type StraddleLeg } from '@/lib/backtest/dvol-straddle-filter-business-logic';

const DAY = 86_400_000;
const printAtMs = 40 * DAY;
const closes: DailyClose[] = Array.from({ length: 35 }, (_, index) => ({
  timestamp: (index + 7) * DAY,
  close: 100 * Math.exp(index * 0.01 + (index % 2) * 0.005),
}));
const leg = (eventId: string, netR: number, at = printAtMs): StraddleLeg => ({ eventId, coin: 'BTC', printAtMs: at, netR, riskUsd: 10 });
const dvol = (value: number, at = printAtMs): DvolObservation => ({ timestamp: at, value });

describe('DVOL straddle filter', () => {
  it('uses 30 completed UTC closes and rejects missing or stale observations', () => {
    expect(realisedVolatility(closes, printAtMs)).toBeGreaterThan(0);
    expect(realisedVolatility(closes.slice(7), printAtMs)).toBeNull();
    const result = evaluateDvolStraddles([leg('fresh', 1), leg('stale', -1, printAtMs + 2 * 3_600_000)],
      { BTC: { closes, dvol: [dvol(50)] } });
    expect(result.coverage).toEqual({ inputLegs: 2, prints: 2, eligible: 1, excluded: 1 });
    expect(result.verdict).toBe('insufficient evidence');
  });

  it('combines same-print legs by risk and applies fixed terciles and kill bar', () => {
    const legs: StraddleLeg[] = [];
    const observations: DvolObservation[] = [];
    for (let index = 0; index < 45; index++) {
      const at = printAtMs + index * 3_600_000;
      legs.push(leg(`event-${index}`, index < 15 ? 1 : index >= 30 ? 0 : 0.4, at));
      observations.push(dvol(index + 1, at));
    }
    legs.push(leg('event-0-other-leg', -1, printAtMs));
    const result = evaluateDvolStraddles(legs, { BTC: { closes, dvol: observations } });
    expect(result.coverage).toEqual({ inputLegs: 46, prints: 45, eligible: 45, excluded: 0 });
    expect(result.cheap).toEqual({ n: 15, meanNetR: 14 / 15 });
    expect(result.rich).toEqual({ n: 15, meanNetR: 0 });
    expect(result.verdict).toBe('survives');
  });

  it('kills when the fixed difference misses 0.3R at sufficient n', () => {
    const legs = Array.from({ length: 45 }, (_, index) => leg(`event-${index}`, 0.1, printAtMs + index * 3_600_000));
    const observations = legs.map((item, index) => dvol(index + 1, item.printAtMs));
    expect(evaluateDvolStraddles(legs, { BTC: { closes, dvol: observations } }).verdict).toBe('kill');
  });

  it('counts a BTC and ETH straddle at the same print as one event', () => {
    const result = evaluateDvolStraddles([
      leg('print', 1),
      { eventId: 'print', coin: 'ETH', printAtMs, netR: -1, riskUsd: 10 },
    ], { BTC: { closes, dvol: [dvol(50)] }, ETH: { closes, dvol: [dvol(60)] } });
    expect(result.coverage.prints).toBe(1);
    expect(result.eligible[0]).toMatchObject({ coin: 'BTC+ETH', netR: 0 });
  });
});
