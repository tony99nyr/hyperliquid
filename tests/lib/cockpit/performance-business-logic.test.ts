import { describe, it, expect } from 'vitest';
import {
  buildLedger,
  computeKpis,
  maxDrawdown,
  buildEquitySeries,
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

    it('profit factor falls back to gross win when there are no losses', () => {
      const fills = [
        fill({ side: 'buy', px: 100, sz: 1, filledAt: 1 }),
        fill({ side: 'sell', px: 110, sz: 1, filledAt: 2 }),
      ];
      const kpis = computeKpis(buildLedger(fills, {}, DAY), {}, []);
      expect(kpis.profitFactor).toBeCloseTo(10);
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
