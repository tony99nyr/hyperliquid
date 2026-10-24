import { expect, it } from 'vitest';
import { forecastLanes, stableInputsHash } from '@/lib/performance/lane-performance-forecast-business-logic';
import type { LaneResult } from '@/lib/performance/lane-performance-business-logic';

const fig = (value: number, n: number, unit: 'usd' | 'per_day') => ({ value, n, unit, source: 'fixture' });

it('hashes the same structured inputs identically', () => {
  expect(stableInputsHash({ a: 1, b: [2] })).toBe(stableInputsHash({ a: 1, b: [2] }));
  expect(stableInputsHash({ a: 1 })).not.toBe(stableInputsHash({ a: 2 }));
});

it('forecasts only active recent live episodes with a fixed seed', () => {
  const lane = (id: string, kind: 'live' | 'scout', verdict: string, rate = .2) => ({
    id, kind, verdict, plannedRiskUsd: fig(10, 3, 'usd'), signalRatePerDay: fig(rate, rate ? 3 : 0, 'per_day'),
    episodes: 3, bar: { minCloses: 10, minMeanR: .15, source: 'fixture' },
  }) as LaneResult;
  const lanes = [lane('active', 'live', 'HOLD'), lane('killed', 'live', 'KILL'),
    lane('stale', 'live', 'COLLECT', 0), lane('paper', 'scout', 'CONTINUE')];
  const rs = new Map([['active', [.5, -.2]], ['killed', [-1]], ['stale', [1]], ['paper', [2]]]);
  const args = [lanes, rs, '2026-10-24T00:00:00Z', '2026-11-23', 17] as const;
  const first = forecastLanes(...args);
  expect(first).toEqual(forecastLanes(...args));
  expect(first.includedLanes).toEqual(['active']);
  expect(first.p5.value).toBeLessThanOrEqual(first.p50.value ?? 0);
  expect(first.p50.value).toBeLessThanOrEqual(first.p95.value ?? 0);
  expect(first.p95Drawdown30d.value).toBeGreaterThanOrEqual(0);
});

it('calibrates monthly dollars to realised episodes and retains the loss tail', () => {
  const lane = {
    id: 'live', kind: 'live', verdict: 'HOLD', episodes: 6,
    plannedRiskUsd: fig(100, 6, 'usd'), signalRatePerDay: fig(6 / 90, 6, 'per_day'),
    bar: { minCloses: 10, minMeanR: .15, source: 'fixture' },
  } as LaneResult;
  const outcomes = [-10, 20, -10, 20, -10, 20];
  const result = forecastLanes([lane], new Map([['live', outcomes]]),
    '2026-10-24T00:00:00Z', '2026-11-23', 17);

  expect(result.realisedMonthly.value).toBe(10);
  expect(result.expectedMonthly.value).toBeCloseTo(10, 1);
  expect(result.p5.value).toBeLessThan(0);
  expect(result.p95Drawdown30d.value).toBeGreaterThan(0);
});

it('uses a full 30-day window for drawdown near the horizon end', () => {
  const lane = {
    id: 'live', kind: 'live', verdict: 'HOLD', episodes: 3,
    plannedRiskUsd: fig(100, 3, 'usd'), signalRatePerDay: fig(3 / 90, 3, 'per_day'),
    bar: { minCloses: 10, minMeanR: .15, source: 'fixture' },
  } as LaneResult;
  const result = forecastLanes([lane], new Map([['live', [-10, 20, 20]]]),
    '2026-10-24T00:00:00Z', '2026-10-26', 17);

  expect(result.p95Drawdown30d.value).toBeGreaterThan(0);
});
