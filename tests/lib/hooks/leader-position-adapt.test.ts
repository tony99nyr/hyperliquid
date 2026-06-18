/**
 * Pins the leader_positions → HlPosition adapter: a near-1:1 field copy with
 * marginUsed derived (notional / leverage) and maxLeverage nulled, so the
 * watcher's book drops into the existing cockpit position panels.
 */

import { describe, it, expect } from 'vitest';
import {
  leaderPositionRowToHlPosition,
  leaderPositionRowsToHlPositions,
  accountValueFromRows,
} from '@/hooks/leader-position-adapt';
import type { LeaderPositionRow } from '@/hooks/realtime-row-mappers';

function row(over: Partial<LeaderPositionRow> = {}): LeaderPositionRow {
  return {
    id: '0xa:ETH',
    leaderAddress: '0xA',
    coin: 'ETH',
    side: 'long',
    szi: 2,
    size: 2,
    entryPx: 1700,
    positionValue: 3400,
    unrealizedPnl: 120,
    returnOnEquity: 0.05,
    leverage: 5,
    leverageType: 'cross',
    liquidationPx: 1500,
    accountValueUsd: 50000,
    fetchedAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('leaderPositionRowToHlPosition', () => {
  it('copies fields 1:1, derives marginUsed = notional/leverage, nulls maxLeverage', () => {
    const p = leaderPositionRowToHlPosition(row());
    expect(p.coin).toBe('ETH');
    expect(p.side).toBe('long');
    expect(p.szi).toBe(2);
    expect(p.size).toBe(2);
    expect(p.entryPx).toBe(1700);
    expect(p.positionValue).toBe(3400);
    expect(p.unrealizedPnl).toBe(120);
    expect(p.returnOnEquity).toBe(0.05);
    expect(p.leverage).toBe(5);
    expect(p.leverageType).toBe('cross');
    expect(p.liquidationPx).toBe(1500);
    expect(p.marginUsed).toBe(680); // 3400 / 5
    expect(p.maxLeverage).toBeNull();
  });

  it('falls marginUsed back to notional when leverage is missing/zero', () => {
    expect(leaderPositionRowToHlPosition(row({ leverage: null })).marginUsed).toBe(3400);
    expect(leaderPositionRowToHlPosition(row({ leverage: 0 })).marginUsed).toBe(3400);
  });
});

describe('leaderPositionRowsToHlPositions', () => {
  it('drops flat (size <= 0) rows', () => {
    const out = leaderPositionRowsToHlPositions([row(), row({ id: '0xa:BTC', coin: 'BTC', size: 0 })]);
    expect(out).toHaveLength(1);
    expect(out[0].coin).toBe('ETH');
  });
});

describe('accountValueFromRows', () => {
  it('returns the first finite account value', () => {
    expect(accountValueFromRows([row({ accountValueUsd: null }), row({ accountValueUsd: 42 })])).toBe(42);
  });
  it('returns null when none present', () => {
    expect(accountValueFromRows([row({ accountValueUsd: null })])).toBeNull();
  });
});
