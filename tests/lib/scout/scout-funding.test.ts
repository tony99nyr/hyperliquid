import { describe, expect, it } from 'vitest';
import { estimateScoutFunding, type ScoutFill } from '@/lib/scout/scout-funding-business-logic';
import { lanePeriodDays, registeredLaneBar } from '@/lib/scout/scout-lane-bars-business-logic';
import { buildLaneScorecards } from '@/lib/scout/scout-review-business-logic';

const base = Date.parse('2026-10-01T00:00:00Z');
const hour = 3_600_000;
const fill = (session_id: string, side: string, sz: number, px: number, at: number): ScoutFill => ({
  session_id, coin: 'BTC', side, sz, px, filled_at: new Date(base + (at + 0.5) * hour).toISOString(),
});
const rates = (values: number[]) => ({ BTC: values.map((fundingHourly, index) => ({ time: base + (index + 1) * hour, fundingHourly })) });

describe('scout funding reconstruction', () => {
  it('keeps same-coin sessions separate, so both flat sessions stay flat', () => {
    const result = estimateScoutFunding([
      fill('one', 'buy', 1, 100, 0), fill('one', 'sell', 1, 110, 2),
      fill('two', 'sell', 1, 120, 3), fill('two', 'buy', 1, 90, 5),
    ], { 'one\u0000BTC': 'first', 'two\u0000BTC': 'second' }, rates([0.01, 0.01, 0.01, 0.01, 0.01, 0.01]), base + 8 * hour);
    expect(result.byLane.first).toBeCloseTo(2);
    expect(result.byLane.second).toBeCloseTo(-2.4);
    expect(result.missingHoursByLane).toEqual({});
  });

  it('nets coin quantities through partial exits at different prices', () => {
    const result = estimateScoutFunding([
      fill('one', 'buy', 2, 100, 0), fill('one', 'sell', 1, 120, 2),
      fill('one', 'sell', 1, 80, 4),
    ], { 'one\u0000BTC': 'first' }, rates([0.01, 0.01, 0.01, 0.01, 0.01, 0.01]), base + 7 * hour);
    expect(result.byLane.first).toBeCloseTo(6.4);
    expect(result.missingHoursByLane.first).toBeUndefined();
  });

  it('charges two BTC lanes for their own hours across a rate change', () => {
    const result = estimateScoutFunding([
      fill('one', 'buy', 1, 100, 0), fill('one', 'sell', 1, 100, 3),
      fill('two', 'buy', 1, 100, 2), fill('two', 'sell', 1, 100, 4),
    ], { 'one\u0000BTC': 'first', 'two\u0000BTC': 'second' }, rates([0.01, 0.02, 0.03, 0.04]), base + 5 * hour);
    expect(result.byLane.first).toBeCloseTo(6);
    expect(result.byLane.second).toBeCloseTo(7);
  });

  it('matches HL funding timestamps that land a few ms after the hour', () => {
    const jittered = { BTC: [1, 2, 3].map((index) => ({ time: base + index * hour + 37, fundingHourly: 0.01 })) };
    const result = estimateScoutFunding([
      fill('one', 'buy', 1, 100, 0), fill('one', 'sell', 1, 100, 3),
    ], { 'one\u0000BTC': 'first' }, jittered, base + 4 * hour);
    expect(result.byLane.first).toBeCloseTo(3);
    expect(result.missingHoursByLane.first).toBeUndefined();
  });

  it('marks missing historical observations instead of using the current rate', () => {
    const result = estimateScoutFunding([
      fill('one', 'buy', 1, 100, 0), fill('one', 'sell', 1, 100, 3),
    ], { 'one\u0000BTC': 'first' }, { BTC: [{ time: base + hour, fundingHourly: 0.01 }] }, base + 4 * hour);
    expect(result.byLane.first).toBeCloseTo(1);
    expect(result.missingHoursByLane.first).toBe(2);
  });
});

describe('registered bars', () => {
  it('uses the compression window and registration date', () => {
    expect(registeredLaneBar('compression-straddle')?.config.slowBleedDays).toBe(45);
    expect(registeredLaneBar('compression-straddle')?.config.slowBleedMinTrades).toBe(6);
    expect(lanePeriodDays('compression-straddle', Date.parse('2026-10-13T00:00:00Z'), 1)).toBe(61);
  });

  it('fires the compression kill bar at six closes after 45 days', () => {
    const bar = registeredLaneBar('compression-straddle');
    expect(bar).not.toBeNull();
    const cards = buildLaneScorecards({
      positions: [{ lane: 'compression-straddle', coin: 'BTC', side: 'flat', realizedPnlUsd: -12.3, feesPaidUsd: 0 }],
      hypotheses: Array.from({ length: 6 }, () => ({ lane: 'compression-straddle', status: 'invalidated', realizedR: -0.1 })),
      fundingByLane: {}, periodDays: 1,
      periodDaysFor: (lane) => lanePeriodDays(lane, Date.parse('2026-10-13T00:00:00Z'), 1),
      configFor: () => bar!.config,
      minExpectancyRFor: () => bar!.minExpectancyR,
    });
    expect(cards[0].card.verdict).toBe('kill');
  });
});
