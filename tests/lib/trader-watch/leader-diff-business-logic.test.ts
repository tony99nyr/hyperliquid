import { describe, it, expect } from 'vitest';
import {
  diffLeaderPositions,
  buildLeaderPositionRow,
  buildLeaderActionRow,
  formatLeaderAction,
  MIN_REL_SIZE_DELTA,
  type LeaderPositionSnapshot,
} from '@/lib/trader-watch/leader-diff-business-logic';

const LEADER = '0xecb6000000000000000000000000000000001234';

/** Build a snapshot with sensible defaults; override what a case needs. */
function snap(
  coin: string,
  side: 'long' | 'short',
  size: number,
  over: Partial<LeaderPositionSnapshot> = {},
): LeaderPositionSnapshot {
  return {
    coin,
    side,
    szi: side === 'short' ? -size : size,
    size,
    entryPx: 1000,
    positionValue: size * 1000,
    unrealizedPnl: 0,
    returnOnEquity: null,
    leverage: 5,
    leverageType: 'cross',
    liquidationPx: null,
    ...over,
  };
}

describe('diffLeaderPositions', () => {
  it('detects an OPEN when a coin is newly present', () => {
    const actions = diffLeaderPositions(LEADER, [], [snap('ETH', 'short', 1.128)]);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      coin: 'ETH',
      kind: 'open',
      prevSide: null,
      newSide: 'short',
      prevSize: 0,
      newSize: 1.128,
      sizeDelta: 1.128,
    });
  });

  it('detects a CLOSE when a coin vanishes (notional 0, prev context retained)', () => {
    const prev = [snap('ETH', 'short', 1.128, { entryPx: 1772.4 })];
    const actions = diffLeaderPositions(LEADER, prev, []);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      coin: 'ETH',
      kind: 'close',
      prevSide: 'short',
      newSide: null,
      prevSize: 1.128,
      newSize: 0,
      sizeDelta: -1.128,
      notionalUsd: 0,
      entryPx: 1772.4,
    });
  });

  it('carries the last-known unrealizedPnl on CLOSE (realized-P&L proxy, not zeroed)', () => {
    const prev = [snap('ETH', 'short', 1.128, { entryPx: 1772.4, unrealizedPnl: 312.5 })];
    const actions = diffLeaderPositions(LEADER, prev, []);
    expect(actions[0].kind).toBe('close');
    expect(actions[0].unrealizedPnl).toBe(312.5); // ← was 0 before; needed to rank traders by realized P&L
  });

  it('detects an ADD when size grows on the same side', () => {
    const prev = [snap('BTC', 'long', 1)];
    const curr = [snap('BTC', 'long', 1.5)];
    const actions = diffLeaderPositions(LEADER, prev, curr);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('add');
    expect(actions[0].sizeDelta).toBeCloseTo(0.5);
  });

  it('detects a REDUCE when size shrinks on the same side', () => {
    const prev = [snap('BTC', 'long', 2)];
    const curr = [snap('BTC', 'long', 0.5)];
    const actions = diffLeaderPositions(LEADER, prev, curr);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('reduce');
    expect(actions[0].sizeDelta).toBeCloseTo(-1.5);
  });

  it('detects a FLIP when the side reverses', () => {
    const prev = [snap('SOL', 'long', 10)];
    const curr = [snap('SOL', 'short', 4)];
    const actions = diffLeaderPositions(LEADER, prev, curr);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'flip',
      prevSide: 'long',
      newSide: 'short',
      prevSize: 10,
      newSize: 4,
    });
  });

  it('emits NO action when an unchanged same-side position is re-observed', () => {
    const same = [snap('ETH', 'short', 1.128)];
    expect(diffLeaderPositions(LEADER, same, [snap('ETH', 'short', 1.128)])).toEqual([]);
  });

  it('ignores sub-floor size jitter (no spurious add/reduce)', () => {
    const prev = [snap('ETH', 'long', 100)];
    // Change well below the relative floor → no action.
    const tiny = 100 * MIN_REL_SIZE_DELTA * 0.5;
    const curr = [snap('ETH', 'long', 100 + tiny)];
    expect(diffLeaderPositions(LEADER, prev, curr)).toEqual([]);
  });

  it('handles multiple coins at once, ordered by coin', () => {
    const prev = [snap('ETH', 'long', 1), snap('SOL', 'short', 5)];
    const curr = [snap('ETH', 'long', 2), snap('BTC', 'long', 0.1)]; // ETH add, SOL close, BTC open
    const actions = diffLeaderPositions(LEADER, prev, curr);
    expect(actions.map((a) => `${a.coin}:${a.kind}`)).toEqual([
      'BTC:open',
      'ETH:add',
      'SOL:close',
    ]);
  });

  it('normalizes coin casing across prev/curr (no phantom open+close)', () => {
    const prev = [snap('eth', 'long', 1)];
    const curr = [snap('ETH', 'long', 1)];
    expect(diffLeaderPositions(LEADER, prev, curr)).toEqual([]);
  });
});

describe('row builders', () => {
  it('buildLeaderPositionRow maps to snake_case with upper-cased coin', () => {
    const row = buildLeaderPositionRow(
      LEADER,
      snap('eth', 'short', 1.128, { entryPx: 1772.4, leverage: 7 }),
      125000,
      '2026-06-18T00:00:00.000Z',
    );
    expect(row).toMatchObject({
      leader_address: LEADER,
      coin: 'ETH',
      side: 'short',
      szi: -1.128,
      size: 1.128,
      entry_px: 1772.4,
      leverage: 7,
      account_value_usd: 125000,
      fetched_at: '2026-06-18T00:00:00.000Z',
      updated_at: '2026-06-18T00:00:00.000Z',
    });
  });

  it('buildLeaderActionRow maps an action to snake_case', () => {
    const [action] = diffLeaderPositions(LEADER, [], [snap('ETH', 'short', 1.128)]);
    const row = buildLeaderActionRow(action);
    expect(row).toMatchObject({
      leader_address: LEADER,
      coin: 'ETH',
      kind: 'open',
      prev_side: null,
      new_side: 'short',
      new_size: 1.128,
      size_delta: 1.128,
    });
  });
});

describe('formatLeaderAction', () => {
  it('renders an open with the short address + side + size', () => {
    const [action] = diffLeaderPositions(LEADER, [], [snap('ETH', 'short', 1.128, { entryPx: 1772.4 })]);
    expect(formatLeaderAction(action, '0xecb6…1234')).toBe(
      '0xecb6…1234 opened short ETH (1.128 @ $1772.4)',
    );
  });

  it('renders a close without a current price', () => {
    const [action] = diffLeaderPositions(LEADER, [snap('ETH', 'short', 1.128)], []);
    expect(formatLeaderAction(action, '0xecb6…1234')).toBe(
      '0xecb6…1234 closed short ETH (was 1.128)',
    );
  });
});
