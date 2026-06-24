import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HlClearinghouseState, HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';
import type { TopTraderRow } from '@/lib/hyperliquid/top-traders-service';

// Mock the two I/O dependencies the service reaches outside the injected client.
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({
  fetchClearinghouseState: vi.fn(),
}));
vi.mock('@/lib/hyperliquid/top-traders-service', () => ({ getTopTraders: vi.fn() }));

import { fetchClearinghouseState } from '@/lib/hyperliquid/hyperliquid-info-service';
import { getTopTraders } from '@/lib/hyperliquid/top-traders-service';
import {
  runLeaderWatchCycle,
  _resetHlBackoff,
  type LeaderSnapshotStore,
} from '@/lib/trader-watch/leader-watch-service';

const mFetch = vi.mocked(fetchClearinghouseState);
const mTopTraders = vi.mocked(getTopTraders);

const LEADER = '0xecb6000000000000000000000000000000001234';
const NOW = 1_700_000_000_000;

function topTrader(address: string): TopTraderRow {
  return {
    address,
    short: '0xecb6…1234',
    displayName: null,
    composite: 9,
    hasRisk: false,
    cleanBook: true,
    tradesTradeableCoin: true,
    flags: [],
    allFlags: [],
    leaderboardTop: true,
    topCoins: [],
    metrics: {
      sharpe: null,
      winRate: null,
      profitFactor: null,
      maxDrawdownFrac: null,
      aggregatePnlUsd: null,
      medianHoldHours: null,
      nFills: null,
      worstLossVsMedianWin: null,
    },
  };
}

function hlPos(coin: string, side: 'long' | 'short', size: number): HlPosition {
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
    marginUsed: size * 200,
    maxLeverage: 20,
  };
}

function chState(positions: HlPosition[], over: Partial<HlClearinghouseState> = {}): HlClearinghouseState {
  return {
    address: LEADER,
    accountValueUsd: 125000,
    totalMarginUsed: 0,
    totalNotionalPosition: 0,
    withdrawableUsd: 0,
    positions,
    fetchedAt: NOW,
    stale: false,
    ...over,
  };
}

/**
 * A minimal fake Supabase client recording the table operations the service
 * performs. delete()/upsert()/insert() each resolve to `{ error: null }` and are
 * awaitable (delete returns a chainable thenable so `.eq(...).not(...)` works).
 */
function fakeClient() {
  const calls = { upserts: [] as unknown[][], inserts: [] as unknown[][], deletes: 0 };
  const deleteChain = () => {
    const chain: Record<string, unknown> = {};
    chain.eq = () => chain;
    chain.not = () => chain;
    chain.then = (resolve: (v: { error: null }) => void) => {
      calls.deletes++;
      return Promise.resolve({ error: null }).then(resolve);
    };
    return chain;
  };
  const client = {
    from() {
      return {
        delete: () => deleteChain(),
        upsert: (rows: unknown[]) => {
          calls.upserts.push(rows);
          return Promise.resolve({ error: null });
        },
        insert: (rows: unknown[]) => {
          calls.inserts.push(rows);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client: client as never, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetHlBackoff();
  mTopTraders.mockReturnValue([topTrader(LEADER)]);
});

describe('runLeaderWatchCycle', () => {
  it('first observation establishes a SILENT baseline (positions written, no actions)', async () => {
    mFetch.mockResolvedValue(chState([hlPos('ETH', 'short', 1.128)]));
    const prior: LeaderSnapshotStore = new Map();
    const { client, calls } = fakeClient();

    const result = await runLeaderWatchCycle(prior, { now: NOW, clientFactory: () => client });

    expect(result.watched).toBe(1);
    expect(result.actionsEmitted).toBe(0);
    expect(result.results[0].baselined).toBe(true);
    expect(calls.upserts).toHaveLength(1); // positions reconciled
    expect(calls.inserts).toHaveLength(0); // no actions
    expect(prior.get(LEADER)).toHaveLength(1); // baseline stored
  });

  it('emits an ADD action on the second cycle when size grows', async () => {
    const prior: LeaderSnapshotStore = new Map();
    const { client } = fakeClient();

    mFetch.mockResolvedValueOnce(chState([hlPos('ETH', 'short', 1)]));
    await runLeaderWatchCycle(prior, { now: NOW, clientFactory: () => client });

    mFetch.mockResolvedValueOnce(chState([hlPos('ETH', 'short', 2)]));
    const { client: c2, calls } = fakeClient();
    const result = await runLeaderWatchCycle(prior, { now: NOW + 30_000, clientFactory: () => c2 });

    expect(result.actionsEmitted).toBe(1);
    expect(result.results[0].actions[0].kind).toBe('add');
    expect(calls.inserts).toHaveLength(1);
  });

  it('does NOT re-upsert an UNCHANGED book on the second cycle (no needless realtime churn)', async () => {
    const prior: LeaderSnapshotStore = new Map();
    const { client } = fakeClient();
    mFetch.mockResolvedValueOnce(chState([hlPos('ETH', 'short', 1.128)]));
    await runLeaderWatchCycle(prior, { now: NOW, clientFactory: () => client }); // baseline writes

    // Identical book next cycle → no actions → MUST NOT write (the egress/message fix).
    mFetch.mockResolvedValueOnce(chState([hlPos('ETH', 'short', 1.128)]));
    const { client: c2, calls } = fakeClient();
    const result = await runLeaderWatchCycle(prior, { now: NOW + 60_000, clientFactory: () => c2 });

    expect(result.actionsEmitted).toBe(0);
    expect(calls.upserts).toHaveLength(0); // unchanged → skipped
    expect(calls.inserts).toHaveLength(0);
  });

  it('SKIPS a stale clearinghouse read (failure, no diff → no phantom closes)', async () => {
    const prior: LeaderSnapshotStore = new Map([[LEADER, [
      { coin: 'ETH', side: 'short', szi: -1, size: 1, entryPx: 1000, positionValue: 1000,
        unrealizedPnl: 0, returnOnEquity: null, leverage: 5, leverageType: 'cross', liquidationPx: null },
    ]]]);
    mFetch.mockResolvedValue(chState([], { stale: true, error: 'HL 429' }));
    const { client, calls } = fakeClient();

    const result = await runLeaderWatchCycle(prior, { now: NOW, clientFactory: () => client });

    expect(result.results).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toMatch(/stale/);
    expect(calls.inserts).toHaveLength(0); // NO actions written
    expect(calls.upserts).toHaveLength(0); // baseline untouched
    expect(prior.get(LEADER)).toHaveLength(1); // prior baseline preserved
  });

  it('isolates a per-leader failure without aborting the cycle', async () => {
    mTopTraders.mockReturnValue([topTrader(LEADER), topTrader('0xabc0000000000000000000000000000000005678')]);
    mFetch
      .mockResolvedValueOnce(chState([], { stale: true, error: 'boom' })) // first leader fails
      .mockResolvedValueOnce(chState([hlPos('BTC', 'long', 0.5)])); // second succeeds
    const prior: LeaderSnapshotStore = new Map();
    const { client } = fakeClient();

    const result = await runLeaderWatchCycle(prior, { now: NOW, clientFactory: () => client });

    expect(result.watched).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.results).toHaveLength(1); // the healthy leader still ticked
  });
});
