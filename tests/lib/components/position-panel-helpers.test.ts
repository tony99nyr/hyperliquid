import { describe, it, expect } from 'vitest';
import {
  userPositionDisplay,
  leaderPositionDisplay,
  activePositionStats,
} from '@/app/cockpit/components/position-panel-helpers';
import type { PositionRow, PnlSnapshot } from '@/hooks/realtime-row-mappers';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';

const pos: PositionRow = {
  id: 'p', sessionId: 's', coin: 'ETH', side: 'long', sz: 2, avgEntryPx: 2900, realizedPnlUsd: 0, feesPaidUsd: 0, leverage: null, updatedAt: 0,
};

describe('position-panel-helpers', () => {
  it('uses the pnl snapshot mark + unrealized when present', () => {
    const pnl: PnlSnapshot = { id: 'x', sessionId: 's', coin: 'ETH', realizedPnlUsd: 0, unrealizedPnlUsd: 200, feesPaidUsd: 0, markPx: 3000, createdAt: 0 };
    const d = userPositionDisplay(pos, pnl);
    expect(d.side).toBe('long');
    expect(d.markPx).toBe(3000);
    expect(d.unrealizedPnlUsd).toBe(200);
    expect(d.entryPx).toBe(2900);
  });

  it('recomputes unrealized from mark when snapshot uPnL is 0/absent', () => {
    const pnl: PnlSnapshot = { id: 'x', sessionId: 's', coin: 'ETH', realizedPnlUsd: 0, unrealizedPnlUsd: 0, feesPaidUsd: 0, markPx: 3000, createdAt: 0 };
    const d = userPositionDisplay(pos, pnl);
    // long 2 @ 2900, mark 3000 → +200
    expect(d.unrealizedPnlUsd).toBe(200);
  });

  it('leaves uPnL null when no pnl snapshot', () => {
    const d = userPositionDisplay(pos, undefined);
    expect(d.unrealizedPnlUsd).toBeNull();
    expect(d.markPx).toBeNull();
  });

  it('maps a leader HL position', () => {
    const leader: HlPosition = {
      coin: 'BTC', side: 'short', szi: -0.5, size: 0.5, entryPx: 60000, positionValue: 30000,
      unrealizedPnl: -500, returnOnEquity: -0.1, leverage: 5, leverageType: 'cross', liquidationPx: 70000, marginUsed: 6000, maxLeverage: 50,
    };
    const d = leaderPositionDisplay(leader);
    expect(d.side).toBe('short');
    expect(d.sz).toBe(0.5);
    expect(d.entryPx).toBe(60000);
    expect(d.liqPx).toBe(70000);
    expect(d.leverage).toBe(5);
    expect(d.unrealizedPnlUsd).toBe(-500);
  });
});

describe('activePositionStats', () => {
  const longPos: PositionRow = {
    id: 'p', sessionId: 's', coin: 'ETH', side: 'long', sz: 2, avgEntryPx: 2000, realizedPnlUsd: 0, feesPaidUsd: 1.5, leverage: null, updatedAt: 1_000,
  };

  it('computes notional, pnlPct, and time-in-trade', () => {
    const pnl: PnlSnapshot = { id: 'x', sessionId: 's', coin: 'ETH', realizedPnlUsd: 0, unrealizedPnlUsd: 200, feesPaidUsd: 1.5, markPx: 2100, createdAt: 0 };
    const s = activePositionStats(longPos, pnl, 61_000);
    expect(s.markPx).toBe(2100);
    expect(s.notionalUsd).toBe(4200); // 2 * 2100
    expect(s.pnlPct).toBeCloseTo(5, 5); // 200 / (2*2000) = 5%
    expect(s.feesPaidUsd).toBe(1.5);
    expect(s.timeInTradeMs).toBe(60_000);
  });

  it('falls back to entry notional when no mark, and null pnlPct', () => {
    const s = activePositionStats(longPos, undefined, 1_000);
    expect(s.markPx).toBeNull();
    expect(s.notionalUsd).toBe(4000); // 2 * entry 2000
    expect(s.pnlPct).toBeNull();
    expect(s.timeInTradeMs).toBe(0);
  });

  it('computes ROE = pnlPct × leverage when leverage is known', () => {
    const levPos: PositionRow = { ...longPos, leverage: 5 };
    const pnl: PnlSnapshot = { id: 'x', sessionId: 's', coin: 'ETH', realizedPnlUsd: 0, unrealizedPnlUsd: 200, feesPaidUsd: 1.5, markPx: 2100, createdAt: 0 };
    const s = activePositionStats(levPos, pnl, 61_000);
    expect(s.leverage).toBe(5);
    // ROE = uPnl / margin, margin = entryNotional/lev = 4000/5 = 800 → 200/800 = 25%
    expect(s.roePct).toBeCloseTo(25, 5);
  });

  it('leaves ROE null when leverage is unknown', () => {
    const pnl: PnlSnapshot = { id: 'x', sessionId: 's', coin: 'ETH', realizedPnlUsd: 0, unrealizedPnlUsd: 200, feesPaidUsd: 1.5, markPx: 2100, createdAt: 0 };
    const s = activePositionStats(longPos, pnl, 61_000);
    expect(s.leverage).toBeNull();
    expect(s.roePct).toBeNull();
  });
});
