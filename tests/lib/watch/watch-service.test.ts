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
vi.mock('@/lib/health/health-engine', () => ({
  assessHealth: vi.fn(),
  HEALTH_LOOKBACK_MS: { '1d': 1, '8h': 1, '1h': 1, '15m': 400 * 15 * 60 * 1000 },
}));
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
import {
  runWatchCycle,
  runWatchTickForPosition,
  _resetHlBackoff,
  type AlertStateStore,
} from '@/lib/watch/watch-service';

/** A fixed "now" + a fresh candle timestamp so the mark-age guard passes. */
const NOW = 1_700_000_900_000;
const FRESH_TS = NOW - 60_000; // 1 minute old — well within the 2×15m window.

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

/** Make fetchCandles return a single fresh 15m candle with a given close. */
function mockMark(close: number): void {
  mFetchCandles.mockResolvedValue({
    coin: 'ETH',
    interval: '15m',
    candles: [{ timestamp: FRESH_TS, open: close, high: close, low: close, close, volume: 1 }],
    fetchedAt: NOW,
    stale: false,
  } as Awaited<ReturnType<typeof fetchCandles>>);
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetHlBackoff();
  mAssessHealth.mockResolvedValue(healthResult());
  mWritePnl.mockResolvedValue(undefined);
  mWriteHealth.mockResolvedValue(undefined);
  mWriteLog.mockResolvedValue(undefined);
});

describe('runWatchTickForPosition — persists snapshot + pnl', () => {
  it('writes a health snapshot and a pnl snapshot with the live mark + unrealized P&L', async () => {
    mockMark(2100); // long 2 @ 2000 ⇒ +$200 unrealized
    const state: AlertStateStore = new Map();
    const decision = await runWatchTickForPosition('s1', pos(), state, { now: NOW });

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

    await runWatchTickForPosition('s1', pos(), state, { now: NOW });
    // big-move + regime-flip-8h both new ⇒ two analysis-log writes.
    expect(mWriteLog).toHaveBeenCalledTimes(2);

    // Second tick, same alerts ⇒ no new analysis-log writes.
    mWriteLog.mockClear();
    await runWatchTickForPosition('s1', pos(), state, { now: NOW });
    expect(mWriteLog).toHaveBeenCalledTimes(0);
  });
});

describe('runWatchTickForPosition — stale / too-old mark (FIX 1)', () => {
  it('throws on a STALE candle result and writes NO pnl/health snapshot', async () => {
    mFetchCandles.mockResolvedValue({
      coin: 'ETH',
      interval: '15m',
      candles: [{ timestamp: FRESH_TS, open: 2100, high: 2100, low: 2100, close: 2100, volume: 1 }],
      fetchedAt: NOW,
      stale: true, // HL outage → cached/old value flagged stale
      error: 'Hyperliquid info API returned 503',
    } as Awaited<ReturnType<typeof fetchCandles>>);

    await expect(
      runWatchTickForPosition('s1', pos(), new Map(), { now: NOW }),
    ).rejects.toThrow(/stale mark/i);

    expect(mWritePnl).not.toHaveBeenCalled();
    expect(mWriteHealth).not.toHaveBeenCalled();
    expect(mWriteLog).not.toHaveBeenCalled();
  });

  it('throws when the newest candle is older than ~2 periods (no stale flag)', async () => {
    const OLD_TS = NOW - 60 * 60 * 1000; // 1h old > 2×15m
    mFetchCandles.mockResolvedValue({
      coin: 'ETH',
      interval: '15m',
      candles: [{ timestamp: OLD_TS, open: 2100, high: 2100, low: 2100, close: 2100, volume: 1 }],
      fetchedAt: NOW,
      stale: false,
    } as Awaited<ReturnType<typeof fetchCandles>>);

    await expect(
      runWatchTickForPosition('s1', pos(), new Map(), { now: NOW }),
    ).rejects.toThrow(/too old/i);
    expect(mWritePnl).not.toHaveBeenCalled();
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
        candles: [{ timestamp: FRESH_TS, open: close, high: close, low: close, close, volume: 1 }],
        fetchedAt: NOW,
        stale: false,
      } as Awaited<ReturnType<typeof fetchCandles>>;
    });

    const result = await runWatchCycle(new Map(), { now: NOW });
    expect(result.activeSessions).toBe(2);
    expect(result.monitored).toHaveLength(2);
    expect(result.failures).toHaveLength(0);
    expect(mWritePnl).toHaveBeenCalledTimes(2);
  });

  it('no-ops cleanly when there are active sessions but NO open positions', async () => {
    mActiveSessions.mockResolvedValue([session('s1')]);
    mLoadPositions.mockResolvedValue([]);

    const result = await runWatchCycle(new Map(), { now: NOW });
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
        candles: [{ timestamp: FRESH_TS, open: 2100, high: 2100, low: 2100, close: 2100, volume: 1 }],
        fetchedAt: NOW,
        stale: false,
      } as Awaited<ReturnType<typeof fetchCandles>>);

    const result = await runWatchCycle(new Map(), { now: NOW });
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

  it('reset-on-clean-cycle: a no-HL-failure cycle clears the streak so the next cycle does NOT back off (FIX C)', async () => {
    vi.useRealTimers();
    mActiveSessions.mockResolvedValue([session('s1')]);
    mLoadPositions.mockResolvedValue([pos()]);

    // Cycle 1: mark fetch fails → one HL failure → streak grows to 1.
    mFetchCandles.mockRejectedValueOnce(new Error('hl 429'));
    const r1 = await runWatchCycle(new Map(), { now: NOW });
    expect(r1.failures).toHaveLength(1);

    // Cycle 2: mark fetch succeeds → no HL failures → streak resets to 0.
    mockMark(2100);
    const sleepSpy = vi.spyOn(globalThis, 'setTimeout');
    const r2 = await runWatchCycle(new Map(), { now: NOW });
    expect(r2.monitored).toHaveLength(1);

    // Cycle 3: should NOT pay a cycle-start backoff (streak was reset). Only the
    // per-position spacing sleeps may fire; with a single position the first one
    // is skipped, so a clean prior cycle ⇒ zero setTimeout calls here.
    sleepSpy.mockClear();
    await runWatchCycle(new Map(), { now: NOW });
    expect(sleepSpy).not.toHaveBeenCalled();
    sleepSpy.mockRestore();
  });

  it('zero-position cycle resets the streak (FIX C)', async () => {
    vi.useRealTimers();
    mActiveSessions.mockResolvedValue([session('s1')]);

    // Cycle 1: a position fails → streak grows to 1.
    mLoadPositions.mockResolvedValueOnce([pos()]);
    mFetchCandles.mockRejectedValueOnce(new Error('hl down'));
    await runWatchCycle(new Map(), { now: NOW });

    // Cycle 2: ZERO open positions → healthy → streak reset.
    mLoadPositions.mockResolvedValueOnce([]);
    await runWatchCycle(new Map(), { now: NOW });

    // Cycle 3: a fresh position opens — must NOT be penalized by a stale streak.
    mLoadPositions.mockResolvedValueOnce([pos()]);
    mockMark(2100);
    const sleepSpy = vi.spyOn(globalThis, 'setTimeout');
    await runWatchCycle(new Map(), { now: NOW });
    expect(sleepSpy).not.toHaveBeenCalled(); // no cycle-start backoff
    sleepSpy.mockRestore();
  });

  it('per-cycle backoff is applied ONCE, not per position (FIX A)', async () => {
    vi.useRealTimers();
    mActiveSessions.mockResolvedValue([session('s1')]);
    // Three positions, all failing the mark fetch.
    mLoadPositions.mockResolvedValue([
      pos({ coin: 'ETH' }),
      pos({ coin: 'BTC' }),
      pos({ coin: 'SOL' }),
    ]);
    mFetchCandles.mockRejectedValue(new Error('hl outage'));

    // Cycle 1: builds a streak (3 failing positions ⇒ streak grows by ONE cycle).
    await runWatchCycle(new Map(), { now: NOW });

    // Cycle 2: with streak=1, expect EXACTLY ONE cycle-start backoff sleep
    // (HL_BACKOFF_BASE_MS=500) — NOT one per failing position. Count setTimeout
    // calls whose delay is the backoff value.
    const sleepSpy = vi.spyOn(globalThis, 'setTimeout');
    await runWatchCycle(new Map(), { now: NOW });
    const backoffCalls = sleepSpy.mock.calls.filter(([, ms]) => ms === 500);
    expect(backoffCalls).toHaveLength(1);
    sleepSpy.mockRestore();
  });

  it('cycle-start backoff is interruptible via shouldStop (FIX B)', async () => {
    vi.useRealTimers();
    mActiveSessions.mockResolvedValue([session('s1')]);
    mLoadPositions.mockResolvedValue([pos()]);
    mFetchCandles.mockRejectedValue(new Error('hl outage'));

    // Build a large streak WITHOUT paying real backoff: shouldStop short-circuits
    // each cycle-start sleep, but the failing positions still grow the streak.
    for (let i = 0; i < 6; i++) {
      await runWatchCycle(new Map(), { now: NOW, shouldStop: () => true });
    }

    // Next cycle: with a maxed streak the cycle-start backoff is ~8s. Because it
    // is interruptible, a stop predicate makes it return fast instead of blocking
    // the full cap.
    const started = Date.now();
    await runWatchCycle(new Map(), { now: NOW, shouldStop: () => true });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('prunes alert-dedup state when a position closes, so a re-open re-fires (FIX 5)', async () => {
    mActiveSessions.mockResolvedValue([session('s1')]);
    mAssessHealth.mockResolvedValue(healthResult({ alerts: ['regime-flip-8h'] }));
    mockMark(2100); // also fires big-move
    const state: AlertStateStore = new Map();

    // Cycle 1: position open → alerts fire + dedup baseline recorded.
    mLoadPositions.mockResolvedValueOnce([pos()]);
    await runWatchCycle(state, { now: NOW });
    expect(state.has('s1:ETH')).toBe(true);
    expect(mWriteLog.mock.calls.length).toBeGreaterThan(0);

    // Cycle 2: position CLOSED (no open positions) → its baseline is pruned.
    mWriteLog.mockClear();
    mLoadPositions.mockResolvedValueOnce([]);
    await runWatchCycle(state, { now: NOW });
    expect(state.has('s1:ETH')).toBe(false);

    // Cycle 3: position RE-OPENS → alerts re-fire (not suppressed by stale state).
    mWriteLog.mockClear();
    mLoadPositions.mockResolvedValueOnce([pos()]);
    await runWatchCycle(state, { now: NOW });
    expect(mWriteLog.mock.calls.length).toBeGreaterThan(0);
  });
});
