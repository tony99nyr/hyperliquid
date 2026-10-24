import { describe, expect, it } from 'vitest';
import { assessOiDirection, type OiSnapshot } from '@/lib/backtest/oi-direction-filter-business-logic';
import type { ReplayTrade } from '@/lib/backtest/htf-replay-business-logic';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const entry = Date.UTC(2025, 1, 2);

function trade(at: number, netR: number, coin = 'BTC'): ReplayTrade {
  return { coin, side: 'long', entryTime: at, exitTime: at + DAY, entryPx: 100,
    exitPx: 101, stopPx: 99, fundingFraction: 0, netR, exitReason: 'channel' };
}

function pair(at: number, older: number, newer: number, coin = 'BTC'): OiSnapshot[] {
  return [{ coin, time: at - DAY - HOUR, openInterest: older },
    { coin, time: at - HOUR, openInterest: newer }];
}

describe('OI direction preregistration', () => {
  it('joins only snapshots before the signal close and at least 24 hours apart', () => {
    const snapshots = [...pair(entry, 100, 110),
      { coin: 'BTC', time: entry, openInterest: 1 },
      { coin: 'BTC', time: entry - 2 * HOUR, openInterest: 50 }];
    const result = assessOiDirection([trade(entry, 0.4)], snapshots);
    expect(result.coverage.rising).toBe(1);
    expect(result.rising.meanNetR).toBe(0.4);
  });

  it('excludes stale, absent and flat pairs without treating null OI as zero', () => {
    const trades = [trade(entry, 1), trade(entry + 7 * DAY, 1),
      trade(entry + 14 * DAY, 1), trade(entry + 21 * DAY, 1)];
    const snapshots = [
      ...pair(entry, 100, 100),
      ...pair(entry + 7 * DAY, 100, 110).map((p) => ({ ...p, time: p.time - 6 * HOUR })),
      { coin: 'BTC', time: entry + 14 * DAY - HOUR, openInterest: null },
    ];
    const result = assessOiDirection(trades, snapshots);
    expect(result.coverage).toEqual({ total: 4, eligible: 0, rising: 0, falling: 0,
      flat: 1, stale: 1, missing: 2 });
    expect(result.verdict).toBe('insufficient_evidence');
  });

  it('uses eligible winners for retention and applies both kill conditions at n=20', () => {
    const times = Array.from({ length: 30 }, (_, i) => entry + i * 6 * DAY);
    const trades = times.map((at, i) => trade(at, i < 20 ? 0.3 : 1));
    const snapshots = times.flatMap((at, i) => pair(at, 100, i < 20 ? 110 : 90));
    const result = assessOiDirection(trades, snapshots);
    expect(result.rising.n).toBe(20);
    expect(result.rising.episodes).toBe(20);
    expect(result.winnerRetention).toBeCloseTo(20 / 30);
    expect(result.verdict).toBe('keep_for_research');
    const weak = assessOiDirection(trades.map((t, i) => ({ ...t, netR: i < 20 ? 0.1 : 1 })), snapshots);
    expect(weak.verdict).toBe('kill');
    const lost = assessOiDirection(trades.map((t, i) => ({ ...t, netR: i < 20 && i >= 15 ? -1 : 1 })), snapshots);
    expect(lost.winnerRetention).toBeCloseTo(15 / 25);
  });

  it('kills when the filter removes more than half of eligible winners', () => {
    const times = Array.from({ length: 50 }, (_, i) => entry + i * 6 * DAY);
    const trades = times.map((at, i) => trade(at, i < 20 ? 0.5 : 1));
    const snapshots = times.flatMap((at, i) => pair(at, 100, i < 20 ? 110 : 90));
    expect(assessOiDirection(trades, snapshots).verdict).toBe('kill');
  });
});
