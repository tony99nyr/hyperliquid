/**
 * Pins the ladder watcher: the PURE completed-candle snapshot (drops the in-progress
 * bar, fails closed), and runLadderWatchTick (autofire gate, evaluate ARMED ladders,
 * fire only MET pending rungs via performLadderRungFire). evaluateLadderRungs runs real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { snapshotFromCandleResult } from '@/lib/ladder/ladder-watch-business-logic';
import type { PriceCandle } from '@/types/trading-core';
import type { LadderWithRungs, LadderRung } from '@/lib/ladder/ladder-types';

function candle(close: number, ts = 0): PriceCandle {
  return { timestamp: ts, open: close, high: close, low: close, close, volume: 100 };
}

describe('snapshotFromCandleResult — completed candle only, fail-closed', () => {
  it('uses the LAST COMPLETED candle (second-to-last), not the in-progress bar', () => {
    const s = snapshotFromCandleResult('ETH', [candle(1900), candle(2050), candle(9999)], false);
    expect(s.completedClose).toBe(2050); // [-2], not the 9999 in-progress bar
    expect(s.stale).toBe(false);
  });
  it('fails closed on a stale feed', () => {
    expect(snapshotFromCandleResult('ETH', [candle(1), candle(2)], true).stale).toBe(true);
  });
  it('fails closed with fewer than two candles (no completed bar yet)', () => {
    expect(snapshotFromCandleResult('ETH', [candle(2000)], false).stale).toBe(true);
    expect(snapshotFromCandleResult('ETH', [], false).stale).toBe(true);
  });
  it('fails closed when the completed close is non-positive', () => {
    expect(snapshotFromCandleResult('ETH', [candle(0), candle(9999)], false).stale).toBe(true);
  });
  it('fails closed when the newest bar is older than maxAge (lagging feed)', () => {
    const now = 10_000_000;
    // newest bar is 1h old, maxAge 30m → stale even though there are 2+ candles.
    const fresh = snapshotFromCandleResult('ETH', [candle(1900, now - 7_200_000), candle(2050, now - 3_600_000)], false, { now, maxAgeMs: 1_800_000 });
    expect(fresh.stale).toBe(true);
    // within maxAge → not stale.
    const ok = snapshotFromCandleResult('ETH', [candle(1900, now - 1_800_000), candle(2050, now - 60_000)], false, { now, maxAgeMs: 1_800_000 });
    expect(ok.stale).toBe(false);
    expect(ok.completedClose).toBe(1900); // [-2]
  });
});

// ---- service ----
const isLadderAutofireEnabled = vi.fn();
const listLadders = vi.fn();
const getLadderWithRungs = vi.fn();
const markLadderExpired = vi.fn();
const fetchCandles = vi.fn();
const performLadderRungFire = vi.fn();

vi.mock('@/lib/ladder/ladder-flags', () => ({ isLadderAutofireEnabled: (...a: unknown[]) => isLadderAutofireEnabled(...a) }));
vi.mock('@/lib/ladder/ladder-service', () => ({ listLadders: (...a: unknown[]) => listLadders(...a), getLadderWithRungs: (...a: unknown[]) => getLadderWithRungs(...a), markLadderExpired: (...a: unknown[]) => markLadderExpired(...a) }));
vi.mock('@/lib/hyperliquid/candle-service', () => ({ fetchCandles: (...a: unknown[]) => fetchCandles(...a) }));
vi.mock('@/lib/ladder/ladder-fire-service', () => ({ performLadderRungFire: (...a: unknown[]) => performLadderRungFire(...a) }));

import { runLadderWatchTick } from '@/lib/ladder/ladder-watch-service';

function openRung(over: Partial<LadderRung> = {}): LadderRung {
  return { id: 'r1', ladderId: 'L1', seq: 1, coin: 'ETH', side: 'long', action: 'open', triggerKind: 'price_above', triggerPx: 2000, triggerMeta: null, sizeCoins: null, reduceFrac: null, riskUsd: 50, stopFrac: 0.04, leverage: 5, stopPx: null, targetPx: null, status: 'pending', cloid: 'L1:r1', ...over };
}
function ladder(rungs: LadderRung[]): LadderWithRungs {
  return { id: 'L1', title: 'T', thesis: null, author: 'operator', mode: 'paper', status: 'armed', preconditionHash: 'h', ocoGroupId: null, leaderAddress: null, maxTotalNotionalUsd: null, maxTotalLossUsd: null, expiresAt: null, armedAt: null, disarmedAt: null, disarmReason: null, archivedAt: null, createdAt: '', updatedAt: '', rungs };
}

beforeEach(() => {
  vi.clearAllMocks();
  isLadderAutofireEnabled.mockReturnValue(true);
  listLadders.mockResolvedValue([{ id: 'L1' }]);
  markLadderExpired.mockResolvedValue(undefined);
  getLadderWithRungs.mockResolvedValue(ladder([openRung()]));
  fetchCandles.mockResolvedValue({ candles: [candle(1900), candle(2050), candle(9999)], stale: false });
  performLadderRungFire.mockResolvedValue({ fired: true, skipped: null });
});

describe('runLadderWatchTick', () => {
  it('is a no-op when autofire is OFF (no candle fetch, no fire)', async () => {
    isLadderAutofireEnabled.mockReturnValue(false);
    const s = await runLadderWatchTick({ now: 0 });
    expect(s.autofireOff).toBe(true);
    expect(fetchCandles).not.toHaveBeenCalled();
    expect(performLadderRungFire).not.toHaveBeenCalled();
  });

  it('PROACTIVELY expires an overdue armed ladder and does not evaluate it', async () => {
    const now = 1_700_000_000_000;
    listLadders.mockResolvedValue([{ id: 'L1', expiresAt: new Date(now - 60_000).toISOString() }]);
    const s = await runLadderWatchTick({ now });
    expect(markLadderExpired).toHaveBeenCalledWith('L1');
    expect(s.laddersEvaluated).toBe(0);
    expect(fetchCandles).not.toHaveBeenCalled();
    expect(performLadderRungFire).not.toHaveBeenCalled();
  });

  it('fires a MET rung (completed close 2050 ≥ trigger 2000)', async () => {
    const s = await runLadderWatchTick({ now: 0 });
    expect(s.rungsMet).toBe(1);
    expect(s.rungsFired).toBe(1);
    expect(performLadderRungFire).toHaveBeenCalledWith(expect.objectContaining({ ladderId: 'L1', rungId: 'r1' }));
  });

  it('does NOT fire when the completed close is below the trigger', async () => {
    fetchCandles.mockResolvedValue({ candles: [candle(1900), candle(1950), candle(9999)], stale: false });
    const s = await runLadderWatchTick({ now: 0 });
    expect(s.rungsMet).toBe(0);
    expect(performLadderRungFire).not.toHaveBeenCalled();
  });

  it('fails closed (no fire) when the candle feed is stale', async () => {
    fetchCandles.mockResolvedValue({ candles: [candle(1900), candle(2050)], stale: true });
    const s = await runLadderWatchTick({ now: 0 });
    expect(s.rungsMet).toBe(0);
    expect(performLadderRungFire).not.toHaveBeenCalled();
  });

  it('fails closed when the candle fetch throws (no fire)', async () => {
    fetchCandles.mockRejectedValue(new Error('HL down'));
    const s = await runLadderWatchTick({ now: 0 });
    expect(s.rungsMet).toBe(0);
    expect(performLadderRungFire).not.toHaveBeenCalled();
  });
});
