import { describe, it, expect } from 'vitest';
import {
  diffLeaderPositions,
  buildLeaderPositionRow,
  buildLeaderActionRow,
  formatLeaderAction,
  describeFollowedAction,
  shortAddress,
  MIN_REL_SIZE_DELTA,
  type LeaderAction,
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

  it('treats a sub-materiality rebalance (1% of a big book) as NOISE — the floor regression', () => {
    // A market-maker nudging a 1,000,000-unit book by 1% (10,000 units) is the
    // exact churn that flooded leader_actions at the old 0.01% floor. At 5% it is
    // correctly suppressed; only open/close/flip or a material add/reduce survive.
    const prev = [snap('PUMP', 'long', 1_000_000)];
    const curr = [snap('PUMP', 'long', 1_010_000)]; // +1% → below the 5% floor
    expect(diffLeaderPositions(LEADER, prev, curr)).toEqual([]);
  });

  it('still registers a MATERIAL add (>= the floor)', () => {
    const prev = [snap('PUMP', 'long', 1_000_000)];
    const curr = [snap('PUMP', 'long', 1_080_000)]; // +8% → above the 5% floor
    const actions = diffLeaderPositions(LEADER, prev, curr);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('add');
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

describe('describeFollowedAction (Discord alert lines)', () => {
  function action(over: Partial<LeaderAction>): LeaderAction {
    return {
      leaderAddress: LEADER, coin: 'ETH', kind: 'open', prevSide: null, newSide: 'long',
      prevSize: 0, newSize: 1, sizeDelta: 1, entryPx: 1600, notionalUsd: 1600, unrealizedPnl: 0, ...over,
    };
  }
  it('shortens the address', () => {
    expect(shortAddress(LEADER)).toBe('0xecb6…1234');
  });
  it('describes an OPEN with side + notional', () => {
    const s = describeFollowedAction(action({ kind: 'open', newSide: 'short', notionalUsd: 2000 }));
    expect(s).toMatch(/OPENED SHORT ETH/);
    expect(s).toMatch(/\$2,000/);
  });
  it('describes a REDUCE with the relative percent', () => {
    const s = describeFollowedAction(action({ kind: 'reduce', newSide: 'short', prevSize: 2, newSize: 1, sizeDelta: -1 }));
    expect(s).toMatch(/REDUCED SHORT ETH/);
    expect(s).toMatch(/−50%/);
  });
  it('describes a CLOSE off the previous side', () => {
    expect(describeFollowedAction(action({ kind: 'close', prevSide: 'long', newSide: null }))).toMatch(/CLOSED LONG ETH/);
  });
  it('describes a FLIP with both sides', () => {
    expect(describeFollowedAction(action({ kind: 'flip', prevSide: 'long', newSide: 'short' }))).toMatch(/FLIPPED ETH LONG → SHORT/);
  });
});
