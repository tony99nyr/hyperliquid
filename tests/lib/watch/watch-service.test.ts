import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Position } from '@/types/position';
import type { Session } from '@/types/cockpit';
import type { HealthResult } from '@/lib/health/health-engine-types';

// Mock every I/O dependency the watch-service touches.
vi.mock('@/lib/cockpit/session-service', () => ({ listActiveSessions: vi.fn() }));
vi.mock('@/lib/cockpit/fill-persistence-service', () => ({
  loadOpenPositions: vi.fn(),
  writePnlSnapshot: vi.fn(),
}));
vi.mock('@/lib/cockpit/health-snapshot-service', () => ({ writeHealthSnapshot: vi.fn() }));
vi.mock('@/lib/cockpit/analysis-log-service', () => ({ writeAnalysisLog: vi.fn() }));
vi.mock('@/lib/health/health-engine', () => ({ assessHealth: vi.fn() }));
vi.mock('@/lib/hyperliquid/candle-service', () => ({ fetchCandles: vi.fn() }));

import { listActiveSessions } from '@/lib/cockpit/session-service';
import {
  loadOpenPositions,
  writePnlSnapshot,
} from '@/lib/cockpit/fill-persistence-service';
import { writeHealthSnapshot } from '@/lib/cockpit/health-snapshot-service';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { assessHealth } from '@/lib/health/health-engine';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { runWatchCycle, runWatchTickForPosition, type AlertStateStore } from '@/lib/watch/watch-service';

const mActiveSessions = vi.mocked(listActiveSessions);
const mLoadPositions = vi.mocked(loadOpenPositions);
const mWritePnl = vi.mocked(writePnlSnapshot);
const mWriteHealth = vi.mocked(writeHealthSnapshot);
const mWriteLog = vi.mocked(writeAnalysisLog);
const mAssessHealth = vi.mocked(assessHealth);
const mFetchCandles = vi.mocked(fetchCandles);

function session(id: string): Session {
  return { id, createdAt: 0, status: 'active', mode: 'paper', title: null, leaderAddress: null };
}

function pos(over: Partial<Position> = {}): Position {
  return {
    coin: 'ETH',
    side: 'long',
    sz: 2,
    avgEntryPx: 2000,
    realizedPnlUsd: 0,
    feesPaidUsd: 3,
    ...over,
  };
}

function healthResult(over: Partial<HealthResult> = {}): HealthResult {
  return {
    score: 70,
    pContinuation: 0.6,
    pAdverse: 0.3,
    alerts: [],
    timeframeReads: [],
    ...over,
  };
}

/** Make fetchCandles return a single 15m candle with a given close. */
function mockMark(close: number): void {
  mFetchCandles.mockResolvedValue({
    coin: 'ETH',
    interval: '15m',
    candles: [{ timestamp: 0, open: close, high: close, low: close, close, volume: 1 }],
    fetchedAt: 0,
    stale: false,
  } as Awaited<ReturnType<typeof fetchCandles>>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mAssessHealth.mockResolvedValue(healthResult());
  mWritePnl.mockResolvedValue(undefined);
  mWriteHealth.mockResolvedValue(undefined);
  mWriteLog.mockResolvedValue(undefined);
});

describe('runWatchTickForPosition — persists snapshot + pnl', () => {
  it('writes a health snapshot and a pnl snapshot with the live mark + unrealized P&L', async () => {
    mockMark(2100); // long 2 @ 2000 ⇒ +$200 unrealized
    const state: AlertStateStore = new Map();
    const decision = await runWatchTickForPosition('s1', pos(), state);

    expect(decision.flat).toBe(false);
    expect(mWriteHealth).toHaveBeenCalledTimes(1);
    expect(mWritePnl).toHaveBeenCalledTimes(1);

    const pnlArg = mWritePnl.mock.calls[0][0];
    expect(pnlArg.sessionId).toBe('s1');
    expect(pnlArg.coin).toBe('ETH');
    expect(pnlArg.unrealizedPnlUsd).toBe(200);
    expect(pnlArg.markPx).toBe(2100);

    const healthArg = mWriteHealth.mock.calls[0][0];
    expect(healthArg.sessionId).toBe('s1');
    expect(healthArg.score).toBe(70);
  });

  it('writes a new alert to the analysis stream the first tick, then dedupes', async () => {
    mockMark(2100); // big-move (5%) fires
    mAssessHealth.mockResolvedValue(healthResult({ alerts: ['regime-flip-8h'] }));
    const state: AlertStateStore = new Map();

    await runWatchTickForPosition('s1', pos(), state);
    // big-move + regime-flip-8h both new ⇒ two analysis-log writes.
    expect(mWriteLog).toHaveBeenCalledTimes(2);

    // Second tick, same alerts ⇒ no new analysis-log writes.
    mWriteLog.mockClear();
    await runWatchTickForPosition('s1', pos(), state);
    expect(mWriteLog).toHaveBeenCalledTimes(0);
  });
});

describe('runWatchCycle — discovery + isolation', () => {
  it('monitors every open position across all active sessions', async () => {
    mActiveSessions.mockResolvedValue([session('s1'), session('s2')]);
    mLoadPositions.mockImplementation(async (sid: string) =>
      sid === 's1' ? [pos({ coin: 'ETH' })] : [pos({ coin: 'BTC', avgEntryPx: 50000 })],
    );
    mFetchCandles.mockImplementation(async (coin: string) => {
      const close = coin === 'ETH' ? 2100 : 51000;
      return {
        coin,
        interval: '15m',
        candles: [{ timestamp: 0, open: close, high: close, low: close, close, volume: 1 }],
        fetchedAt: 0,
        stale: false,
      } as Awaited<ReturnType<typeof fetchCandles>>;
    });

    const result = await runWatchCycle(new Map());
    expect(result.activeSessions).toBe(2);
    expect(result.monitored).toHaveLength(2);
    expect(result.failures).toHaveLength(0);
    expect(mWritePnl).toHaveBeenCalledTimes(2);
  });

  it('no-ops cleanly when there are active sessions but NO open positions', async () => {
    mActiveSessions.mockResolvedValue([session('s1')]);
    mLoadPositions.mockResolvedValue([]);

    const result = await runWatchCycle(new Map());
    expect(result.activeSessions).toBe(1);
    expect(result.monitored).toHaveLength(0);
    expect(mWritePnl).not.toHaveBeenCalled();
    expect(mWriteHealth).not.toHaveBeenCalled();
  });

  it('isolates a failing tick — one session error does not abort the others', async () => {
    mActiveSessions.mockResolvedValue([session('s1'), session('s2')]);
    mLoadPositions.mockResolvedValue([pos()]);
    // First position's mark fetch throws; second succeeds.
    mFetchCandles
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({
        coin: 'ETH',
        interval: '15m',
        candles: [{ timestamp: 0, open: 2100, high: 2100, low: 2100, close: 2100, volume: 1 }],
        fetchedAt: 0,
        stale: false,
      } as Awaited<ReturnType<typeof fetchCandles>>);

    const result = await runWatchCycle(new Map());
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toContain('network down');
    expect(result.monitored).toHaveLength(1); // the other session still ran
  });

  it('isolates a position-load failure for a session', async () => {
    mActiveSessions.mockResolvedValue([session('s1')]);
    mLoadPositions.mockRejectedValue(new Error('supabase timeout'));

    const result = await runWatchCycle(new Map());
    expect(result.monitored).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].coin).toBe('*');
    expect(result.failures[0].error).toContain('supabase timeout');
  });
});
