import { describe, it, expect } from 'vitest';
import {
  buildLedger,
  computeKpis,
  maxDrawdown,
  buildEquitySeries,
  localDayStart,
  type EquityPoint,
} from '@/lib/cockpit/performance-business-logic';
import type { CanonicalFill } from '@/types/fill';

const DAY = 86_400_000;

function fill(
  partial: Partial<CanonicalFill> & Pick<CanonicalFill, 'side' | 'px' | 'sz' | 'filledAt'>,
): CanonicalFill {
  return {
    clientIntentId: partial.clientIntentId ?? `i-${partial.filledAt}-${partial.side}`,
    sessionId: 'sess-1',
    coin: partial.coin ?? 'ETH',
    side: partial.side,
    px: partial.px,
    sz: partial.sz,
    notionalUsd: partial.px * partial.sz,
    feeUsd: partial.feeUsd ?? 0,
    reduceOnly: partial.reduceOnly ?? false,
    partial: partial.partial ?? false,
    source: 'paper',
    hlOrderId: null,
    hlRaw: null,
    filledAt: partial.filledAt,
  };
}

describe('performance-business-logic', () => {
  describe('buildLedger', () => {
    it('folds a winning long round-trip into a WIN row with realized PnL', () => {
      const now = 10 * DAY;
      const fills = [
        fill({ side: 'buy', px: 100, sz: 2, feeUsd: 1, filledAt: 5 * DAY }),
        fill({ side: 'sell', px: 110, sz: 2, feeUsd: 1, filledAt: 5 * DAY + 3600_000 }),
      ];
      const ledger = buildLedger(fills, {}, now);
      expect(ledger).toHaveLength(1);
      const t = ledger[0];
      expect(t.status).toBe('win');
      expect(t.side).toBe('long');
      expect(t.coin).toBe('ETH');
      expect(t.entryPx).toBeCloseTo(100);
      expect(t.exitPx).toBeCloseTo(110);
      // realized gross = (110-100)*2 = 20; fees folded into realizedPnl? pnl is realized only.
      expect(t.pnlUsd).toBeCloseTo(20);
      expect(t.feesUsd).toBeCloseTo(2);
    });

    it('folds a losing short round-trip into a LOSS row', () => {
      const fills = [
        fill({ side: 'sell', px: 100, sz: 1, filledAt: 1 }),
        fill({ side: 'buy', px: 120, sz: 1, filledAt: 2 }),
      ];
      const ledger = buildLedger(fills, {}, DAY);
      expect(ledger).toHaveLength(1);
      expect(ledger[0].status).toBe('loss');
      expect(ledger[0].side).toBe('short');
      expect(ledger[0].pnlUsd).toBeCloseTo(-20);
    });

    it('marks a still-open position to market as an OPEN row', () => {
      const fills = [fill({ side: 'buy', px: 100, sz: 3, filledAt: 1, coin: 'BTC' })];
      const ledger = buildLedger(fills, { BTC: 105 }, DAY);
      expect(ledger).toHaveLength(1);
      expect(ledger[0].status).toBe('open');
      expect(ledger[0].pnlUsd).toBeCloseTo((105 - 100) * 3); // 15 unrealized
      expect(ledger[0].exitPx).toBe(105);
      expect(ledger[0].coin).toBe('BTC');
    });

    it('returns newest-first across coins', () => {
      const fills = [
        fill({ side: 'buy', px: 100, sz: 1, filledAt: 1 * DAY, coin: 'ETH' }),
        fill({ side: 'sell', px: 105, sz: 1, filledAt: 1 * DAY + 1, coin: 'ETH' }),
        fill({ side: 'buy', px: 50, sz: 1, filledAt: 3 * DAY, coin: 'SOL' }),
      ];
      const ledger = buildLedger(fills, { SOL: 55 }, 4 * DAY);
      expect(ledger[0].coin).toBe('SOL'); // opened day 3
      expect(ledger[1].coin).toBe('ETH'); // opened day 1
    });

    it('attaches open-row leverage from the leverageByCoin map', () => {
      const fills = [fill({ side: 'buy', px: 100, sz: 1, filledAt: 1, coin: 'ETH' })];
      const ledger = buildLedger(fills, { ETH: 100 }, DAY, { ETH: 8 });
      expect(ledger[0].leverage).toBe(8);
    });
  });

  describe('computeKpis', () => {
    it('computes net pnl, win rate, profit factor and counts', () => {
      const fills = [
        // win +20
        fill({ side: 'buy', px: 100, sz: 2, filledAt: 1 }),
        fill({ side: 'sell', px: 110, sz: 2, filledAt: 2 }),
        // loss -10
        fill({ side: 'buy', px: 100, sz: 1, filledAt: 3 }),
        fill({ side: 'sell', px: 90, sz: 1, filledAt: 4 }),
      ];
      const ledger = buildLedger(fills, {}, DAY);
      const kpis = computeKpis(ledger, {}, []);
      expect(kpis.closedCount).toBe(2);
      expect(kpis.winCount).toBe(1);
      expect(kpis.lossCount).toBe(1);
      expect(kpis.netPnlUsd).toBeCloseTo(10);
      expect(kpis.winRatePct).toBeCloseTo(50);
      expect(kpis.profitFactor).toBeCloseTo(20 / 10);
      expect(kpis.avgTradeUsd).toBeCloseTo(5);
    });

    it('profit factor is Infinity (sentinel) when there are wins but no losses', () => {
      const fills = [
        fill({ side: 'buy', px: 100, sz: 1, filledAt: 1 }),
        fill({ side: 'sell', px: 110, sz: 1, filledAt: 2 }),
      ];
      const kpis = computeKpis(buildLedger(fills, {}, DAY), {}, []);
      expect(kpis.profitFactor).toBe(Infinity);
    });

    it('profit factor is null when there are no closed trades', () => {
      const kpis = computeKpis([], {}, []);
      expect(kpis.profitFactor).toBeNull();
    });

    it('counts open exposure from marks', () => {
      const fills = [fill({ side: 'buy', px: 100, sz: 3, filledAt: 1, coin: 'ETH' })];
      const ledger = buildLedger(fills, { ETH: 110 }, DAY);
      const kpis = computeKpis(ledger, { ETH: 110 }, []);
      expect(kpis.openCount).toBe(1);
      expect(kpis.openExposureUsd).toBeCloseTo(330);
    });

    it('counts today PnL only for trades opened in today window', () => {
      const now = 10 * DAY + 1000;
      const fills = [
        // yesterday win
        fill({ side: 'buy', px: 100, sz: 1, filledAt: 8 * DAY }),
        fill({ side: 'sell', px: 110, sz: 1, filledAt: 8 * DAY + 1 }),
        // today win
        fill({ side: 'buy', px: 100, sz: 1, filledAt: 10 * DAY }),
        fill({ side: 'sell', px: 105, sz: 1, filledAt: 10 * DAY + 1 }),
      ];
      const kpis = computeKpis(buildLedger(fills, {}, now), {}, []);
      expect(kpis.netPnlUsd).toBeCloseTo(15);
      expect(kpis.todayPnlUsd).toBeCloseTo(5);
    });
  });

  describe('maxDrawdown', () => {
    it('finds the worst peak-to-trough drop as a positive percent', () => {
      const series: EquityPoint[] = [
        { t: 0, equity: 100 },
        { t: 1, equity: 120 }, // peak
        { t: 2, equity: 90 }, // -25% from 120
        { t: 3, equity: 110 },
      ];
      expect(maxDrawdown(series)).toBeCloseTo(25);
    });

    it('is zero for a monotonically rising series', () => {
      expect(maxDrawdown([{ t: 0, equity: 100 }, { t: 1, equity: 110 }])).toBe(0);
    });

    it('returns 0 for a degenerate zero-crossing baseline (the -10149% bug)', () => {
      // A cumulative-P&L curve anchored at ~0: a tiny early positive peak then a
      // dip below zero would otherwise yield a 10000%+ drawdown. The baseline is
      // degenerate (not real equity) → report 0, not a fabricated huge percent.
      const series: EquityPoint[] = [
        { t: 0, equity: 0.13 }, // tiny positive peak
        { t: 1, equity: -13.06 }, // dips below zero
        { t: 2, equity: 5 },
      ];
      expect(maxDrawdown(series)).toBe(0);
    });

    it('computes a REAL drawdown on a positive (real-equity-anchored) curve', () => {
      // Anchored at real equity ~$200: a dip to $188 off a $201 peak ≈ 6.5%.
      const series: EquityPoint[] = [
        { t: 0, equity: 195 },
        { t: 1, equity: 201 }, // peak
        { t: 2, equity: 188 }, // -6.47%
        { t: 3, equity: 200 },
      ];
      expect(maxDrawdown(series)).toBeCloseTo(6.4677, 3);
    });
  });

  describe('direct flip (no flat boundary)', () => {
    it('captures the closed leg of a long→short flip as a realized LedgerTrade', () => {
      // Open long 1 @100, then SELL 3 @110 → closes the +10 long AND opens a
      // short 2 @110 (overshoot). The realized +10 must NOT be silently dropped.
      const fills = [
        fill({ side: 'buy', px: 100, sz: 1, filledAt: 1 * DAY }),
        fill({ side: 'sell', px: 110, sz: 3, filledAt: 2 * DAY }),
      ];
      const ledger = buildLedger(fills, { ETH: 108 }, 3 * DAY);
      const closed = ledger.filter((t) => t.status !== 'open');
      const open = ledger.filter((t) => t.status === 'open');
      expect(closed).toHaveLength(1);
      expect(closed[0].side).toBe('long');
      expect(closed[0].pnlUsd).toBeCloseTo(10); // (110-100)*1 — captured, not dropped
      expect(closed[0].closedAt).toBe(2 * DAY);
      // The overshoot opened a short 2 @110, marked at 108 → +4 unrealized.
      expect(open).toHaveLength(1);
      expect(open[0].side).toBe('short');
      expect(open[0].sz).toBeCloseTo(2);
      expect(open[0].entryPx).toBeCloseTo(110);
      expect(open[0].pnlUsd).toBeCloseTo((110 - 108) * 2);
    });

    it('counts the flipped realized leg in Net PnL / win / profit factor', () => {
      const fills = [
        fill({ side: 'buy', px: 100, sz: 1, filledAt: 1 }),
        fill({ side: 'sell', px: 120, sz: 2, filledAt: 2 }), // close +20, open short 1
        fill({ side: 'buy', px: 110, sz: 1, filledAt: 3, reduceOnly: true }), // close short +10
      ];
      const kpis = computeKpis(buildLedger(fills, {}, DAY), {}, []);
      expect(kpis.closedCount).toBe(2);
      expect(kpis.winCount).toBe(2);
      expect(kpis.netPnlUsd).toBeCloseTo(30); // 20 + 10 — neither dropped
      expect(kpis.profitFactor).toBe(Infinity); // wins, no losses
    });
  });

  describe('close-time bucketing (equity curve shape)', () => {
    it('buckets realized PnL on the CLOSE day, not the open day', () => {
      // Opened day 1, closed day 20. The realized step must land on day 20.
      const fills = [
        fill({ side: 'buy', px: 100, sz: 1, filledAt: 1 * DAY }),
        fill({ side: 'sell', px: 150, sz: 1, filledAt: 20 * DAY }),
      ];
      const ledger = buildLedger(fills, {}, 20 * DAY);
      expect(ledger[0].closedAt).toBe(20 * DAY);
      const series = buildEquitySeries(ledger, 50_050, 20 * DAY, 30);
      // The equity should be flat (pre-realization) right up until day 19, then
      // step up on day 20 — i.e. day 19's point is BELOW the final equity.
      const day19 = series.find((p) => p.t === 19 * DAY);
      const day20 = series.find((p) => p.t === 20 * DAY);
      expect(day19).toBeDefined();
      expect(day20).toBeDefined();
      expect(day19!.equity).toBeLessThan(day20!.equity);
      expect(day20!.equity).toBeCloseTo(50_050);
      // And an EARLY day (day 5) is also still at the pre-realization level.
      const day5 = series.find((p) => p.t === 5 * DAY);
      expect(day5!.equity).toBeCloseTo(day19!.equity);
    });
  });

  describe('localDayStart (operator-local Today boundary)', () => {
    it('UTC tz floors to UTC midnight', () => {
      const ms = Date.UTC(2026, 0, 15, 18, 30); // 18:30 UTC
      expect(localDayStart(ms, 'UTC')).toBe(Date.UTC(2026, 0, 15));
    });

    it('America/New_York floors to local midnight, not UTC midnight', () => {
      // 2026-01-15 02:00 UTC = 2026-01-14 21:00 EST. Local day = Jan 14.
      const ms = Date.UTC(2026, 0, 15, 2, 0);
      const localMidnight = localDayStart(ms, 'America/New_York');
      // EST is UTC-5 → local midnight Jan 14 = 2026-01-14 05:00 UTC.
      expect(localMidnight).toBe(Date.UTC(2026, 0, 14, 5, 0));
      // The same instant under UTC would (wrongly) bucket into Jan 15.
      expect(localDayStart(ms, 'UTC')).toBe(Date.UTC(2026, 0, 15));
    });

    it('drives the Today window through buildLedger (tz arg)', () => {
      // An instant that is "yesterday" in NY but "today" in UTC.
      const now = Date.UTC(2026, 0, 15, 2, 0); // Jan 14 21:00 EST
      // A trade closed at Jan 15 00:30 UTC = Jan 14 19:30 EST → SAME NY day as now.
      const closeUtc = Date.UTC(2026, 0, 15, 0, 30);
      const fills = [
        fill({ side: 'buy', px: 100, sz: 1, filledAt: closeUtc - 600_000 }),
        fill({ side: 'sell', px: 110, sz: 1, filledAt: closeUtc }),
      ];
      const nyLedger = buildLedger(fills, {}, now, {}, 'America/New_York');
      expect(nyLedger[0].today).toBe(true); // same NY day
      const utcLedger = buildLedger(fills, {}, now, {}, 'UTC');
      // Under UTC, the close (Jan 15) is "today" too here — assert the NY path
      // does not regress the obviously-same-day case.
      expect(utcLedger[0].today).toBe(true);
    });
  });

  describe('buildEquitySeries', () => {
    it('ends exactly at the current equity and spans `days` points', () => {
      const fills = [
        fill({ side: 'buy', px: 100, sz: 1, filledAt: 5 * DAY }),
        fill({ side: 'sell', px: 110, sz: 1, filledAt: 5 * DAY + 1 }),
      ];
      const ledger = buildLedger(fills, {}, 10 * DAY);
      const series = buildEquitySeries(ledger, 50_010, 10 * DAY, 30);
      expect(series).toHaveLength(30);
      expect(series[series.length - 1].equity).toBeCloseTo(50_010);
      // before the win landed, equity should be lower by the realized net.
      expect(series[0].equity).toBeLessThan(50_010);
    });
  });
});
