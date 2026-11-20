/**
 * Pins the scoped agent-action execution site (ADR-0009). Every I/O dependency is
 * mocked; the pure checks and the close builder stay real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getActiveSession = vi.fn();
const executeIntent = vi.fn();
const fetchAllMids = vi.fn();
const fetchClearinghouseState = vi.fn();
const getTradingMode = vi.fn();
const writeAnalysisLog = vi.fn();
const sendDiscord = vi.fn();
const acquireExitLock = vi.fn();
const releaseExitLock = vi.fn();
const getHlAccountAddress = vi.fn();
const findOpenStops = vi.fn();
const placeStopOnHl = vi.fn();
const cancelStopOnHl = vi.fn();
const fetchPerpMeta = vi.fn();
const hlNetwork = vi.fn();

vi.mock('@/lib/cockpit/session-service', () => ({ getActiveSession: () => getActiveSession() }));
vi.mock('@/lib/trading/fill-source', () => ({ executeIntent: (...a: unknown[]) => executeIntent(...a) }));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({
  fetchAllMids: (...a: unknown[]) => fetchAllMids(...a),
  fetchClearinghouseState: (...a: unknown[]) => fetchClearinghouseState(...a),
  fetchPerpMeta: (...a: unknown[]) => fetchPerpMeta(...a),
}));
vi.mock('@/lib/env/mode', () => ({ getTradingMode: () => getTradingMode() }));
vi.mock('@/lib/env/env', () => ({ validateEnv: () => ({ HL_NETWORK: hlNetwork() }) }));
vi.mock('@/lib/cockpit/analysis-log-service', () => ({ writeAnalysisLog: (...a: unknown[]) => writeAnalysisLog(...a) }));
vi.mock('@/lib/infrastructure/notify/discord-notify', () => ({ sendDiscord: (...a: unknown[]) => sendDiscord(...a) }));
vi.mock('@/lib/auto-exit/auto-exit-config', () => ({
  loadAutoExitConfig: () => ({ lockTtlMs: 120_000 }),
  getHlAccountAddress: () => getHlAccountAddress(),
}));
vi.mock('@/lib/auto-exit/auto-exit-lock-service', () => ({
  acquireExitLock: (...a: unknown[]) => acquireExitLock(...a),
  releaseExitLock: (...a: unknown[]) => releaseExitLock(...a),
}));
vi.mock('@/lib/trading/stop-order-service', () => ({
  findOpenStops: (...a: unknown[]) => findOpenStops(...a),
  placeStopOnHl: (...a: unknown[]) => placeStopOnHl(...a),
  cancelStopOnHl: (...a: unknown[]) => cancelStopOnHl(...a),
}));

import { reduceClose, tightenStop } from '@/lib/agent-actions/agent-action-service';
import { PreSubmitError } from '@/lib/trading/pre-submit-error';

const shortHype = { coin: 'HYPE', side: 'short', szi: -2.89, size: 2.89, entryPx: 69.085 };
const account = (positions: unknown[], extra: Record<string, unknown> = {}) => ({ positions, stale: false, positionsListed: true, ...extra });

let cancelled: Set<number>;
let oldStops: { oid: number; triggerPx: number | null; isPositionTpsl?: boolean }[];

beforeEach(() => {
  vi.clearAllMocks();
  oldStops = [{ oid: 11, triggerPx: 69.085 }];
  getTradingMode.mockReturnValue('live');
  hlNetwork.mockReturnValue('mainnet');
  fetchPerpMeta.mockResolvedValue([{ name: 'HYPE', szDecimals: 2 }]);
  getActiveSession.mockResolvedValue({ id: 's-live', mode: 'live' });
  getHlAccountAddress.mockReturnValue('0x' + 'a'.repeat(40));
  fetchClearinghouseState.mockResolvedValue(account([shortHype]));
  fetchAllMids.mockResolvedValue({ HYPE: 63.5 });
  // A small venue model: old stops rest until cancelled, and the new stop rests once placed.
  cancelled = new Set();
  findOpenStops.mockImplementation(async () => [
    ...oldStops.filter((o) => !cancelled.has(o.oid)),
    ...(placeStopOnHl.mock.calls.length > 0 ? [{ oid: 22, triggerPx: 66.5 }] : []),
  ]);
  placeStopOnHl.mockResolvedValue({ pushed: true, oid: 22 });
  cancelStopOnHl.mockImplementation(async (_coin: string, oid: number) => {
    cancelled.add(oid);
    return { pushed: true };
  });
  acquireExitLock.mockResolvedValue({ id: 'lock-1' });
  releaseExitLock.mockResolvedValue(undefined);
  writeAnalysisLog.mockResolvedValue(undefined);
  sendDiscord.mockResolvedValue(true);
  // Like the exchange layer: the venue floors the size to the lot, and partial compares the fill with intent.sz.
  executeIntent.mockImplementation(async (intent: { sz: number }) => {
    const filled = Math.floor(intent.sz * 100 + 1e-9) / 100;
    return { sz: filled, px: 63.4, partial: filled < intent.sz - 1e-9 };
  });
});

describe('live context (shared refusals)', () => {
  it.each([
    ['a paper deployment', () => getTradingMode.mockReturnValue('paper'), 'not-live-deployment'],
    ['a testnet deployment', () => hlNetwork.mockReturnValue('testnet'), 'not-mainnet'],
    ['no active session', () => getActiveSession.mockResolvedValue(null), 'no-live-session'],
    ['a paper session', () => getActiveSession.mockResolvedValue({ id: 's', mode: 'paper' }), 'no-live-session'],
    ['no account address', () => getHlAccountAddress.mockReturnValue(undefined), 'no-account-address'],
    ['a stale account read', () => fetchClearinghouseState.mockResolvedValue(account([shortHype], { stale: true })), 'account-unreadable'],
    ['an account read without the positions array', () => fetchClearinghouseState.mockResolvedValue(account([], { positionsListed: false })), 'account-unreadable'],
    ['an account read that throws', () => fetchClearinghouseState.mockRejectedValue(new Error('429')), 'account-unreadable'],
    ['a flat coin', () => fetchClearinghouseState.mockResolvedValue(account([])), 'flat'],
    ['a missing mark', () => fetchAllMids.mockResolvedValue({}), 'bad-mark'],
    ['a mark read that throws', () => fetchAllMids.mockRejectedValue(new Error('down')), 'bad-mark'],
  ])('refuses both actions on %s', async (_name, arrange, skipped) => {
    arrange();
    expect(await tightenStop({ coin: 'HYPE', triggerPx: 66.5 })).toMatchObject({ done: false, skipped });
    expect(await reduceClose({ coin: 'HYPE', fraction: 0.4 })).toMatchObject({ done: false, skipped });
    expect(placeStopOnHl).not.toHaveBeenCalled();
    expect(cancelStopOnHl).not.toHaveBeenCalled();
    expect(executeIntent).not.toHaveBeenCalled();
  });
});

describe('tightenStop', () => {
  it('places the new stop with the venue size before it cancels the old stop', async () => {
    const res = await tightenStop({ coin: 'hype', triggerPx: 66.5 });
    expect(res).toMatchObject({ done: true, skipped: null, newStopPx: 66.5, oldStopPx: 69.085, uncancelledOids: [] });
    expect(placeStopOnHl).toHaveBeenCalledWith('HYPE', 66.5, 2.89, 'short');
    expect(cancelStopOnHl).toHaveBeenCalledWith('HYPE', 11);
    expect(placeStopOnHl.mock.invocationCallOrder[0]).toBeLessThan(cancelStopOnHl.mock.invocationCallOrder[0]);
    expect(sendDiscord).toHaveBeenCalledTimes(1);
  });

  it('refuses a looser stop and touches no order', async () => {
    const res = await tightenStop({ coin: 'HYPE', triggerPx: 70 });
    expect(res).toMatchObject({ done: false, skipped: 'not-tighter-than-resting-stop' });
    expect(placeStopOnHl).not.toHaveBeenCalled();
    expect(cancelStopOnHl).not.toHaveBeenCalled();
  });

  it('compares against the tightest of several resting stops and cancels all of them', async () => {
    oldStops = [{ oid: 11, triggerPx: 72.6 }, { oid: 12, triggerPx: 67 }];
    expect(await tightenStop({ coin: 'HYPE', triggerPx: 68 })).toMatchObject({ done: false, skipped: 'not-tighter-than-resting-stop' });
    expect(await tightenStop({ coin: 'HYPE', triggerPx: 66.5 })).toMatchObject({ done: true, oldStopPx: 67 });
    expect(cancelStopOnHl).toHaveBeenCalledTimes(2);
  });

  it('places a first stop when none rests', async () => {
    oldStops = [];
    expect(await tightenStop({ coin: 'HYPE', triggerPx: 66.5 })).toMatchObject({ done: true, oldStopPx: null });
    expect(cancelStopOnHl).not.toHaveBeenCalled();
  });

  it('refuses when the resting stops are unreadable or carry no price', async () => {
    findOpenStops.mockRejectedValue(new Error('429'));
    expect(await tightenStop({ coin: 'HYPE', triggerPx: 66.5 })).toMatchObject({ done: false, skipped: 'cannot-read-resting-stop' });
    findOpenStops.mockResolvedValue([{ oid: 11, triggerPx: null }]);
    expect(await tightenStop({ coin: 'HYPE', triggerPx: 66.5 })).toMatchObject({ done: false, skipped: 'bad-resting-stop' });
    expect(placeStopOnHl).not.toHaveBeenCalled();
  });

  it('keeps the old stop when the new stop is rejected', async () => {
    placeStopOnHl.mockRejectedValue(new Error('rejected'));
    expect(await tightenStop({ coin: 'HYPE', triggerPx: 66.5 })).toMatchObject({ done: false, skipped: 'stop-place-unknown' });
    expect(cancelStopOnHl).not.toHaveBeenCalled();
  });

  it('keeps the old stop when the new stop was not pushed', async () => {
    placeStopOnHl.mockResolvedValue({ pushed: false, oid: null });
    expect(await tightenStop({ coin: 'HYPE', triggerPx: 66.5 })).toMatchObject({ done: false, skipped: 'stop-not-pushed' });
    expect(cancelStopOnHl).not.toHaveBeenCalled();
  });

  it('refuses to replace a position-attached stop', async () => {
    oldStops = [{ oid: 11, triggerPx: 69.085, isPositionTpsl: true }];
    expect(await tightenStop({ coin: 'HYPE', triggerPx: 66.5 })).toMatchObject({ done: false, skipped: 'position-attached-stop' });
    expect(placeStopOnHl).not.toHaveBeenCalled();
    expect(cancelStopOnHl).not.toHaveBeenCalled();
  });

  it('keeps the old stop when the new stop is not confirmed resting', async () => {
    findOpenStops.mockResolvedValue(oldStops); // the new oid never shows: it may have triggered
    expect(await tightenStop({ coin: 'HYPE', triggerPx: 66.5 })).toMatchObject({ done: false, skipped: 'new-stop-not-confirmed' });
    expect(placeStopOnHl).toHaveBeenCalledTimes(1);
    expect(cancelStopOnHl).not.toHaveBeenCalled();
    expect(writeAnalysisLog).toHaveBeenCalledWith(expect.objectContaining({ severity: 'danger' }));
  });

  it('keeps the old stop when the confirm read fails', async () => {
    findOpenStops.mockResolvedValueOnce(oldStops).mockRejectedValueOnce(new Error('429'));
    expect(await tightenStop({ coin: 'HYPE', triggerPx: 66.5 })).toMatchObject({ done: false, skipped: 'new-stop-not-confirmed' });
    expect(cancelStopOnHl).not.toHaveBeenCalled();
  });

  it('reports an old stop that still rests although its cancel was accepted', async () => {
    cancelStopOnHl.mockResolvedValue({ pushed: true }); // accepted, but the venue still lists oid 11
    expect(await tightenStop({ coin: 'HYPE', triggerPx: 66.5 })).toMatchObject({ done: true, uncancelledOids: [11] });
  });

  describe('when the new stop triggers between the confirm and the cancel', () => {
    const confirmed = () => [...oldStops, { oid: 22, triggerPx: 66.5 }];
    const remainder = { ...shortHype, szi: -1.2, size: 1.2 };

    it('places a stop again for the remainder and confirms that it rests', async () => {
      placeStopOnHl.mockResolvedValueOnce({ pushed: true, oid: 22 }).mockResolvedValueOnce({ pushed: true, oid: 33 });
      findOpenStops
        .mockResolvedValueOnce(oldStops)
        .mockResolvedValueOnce(confirmed())
        .mockResolvedValueOnce([]) // after the cancel: nothing rests
        .mockResolvedValueOnce([{ oid: 33, triggerPx: 66.5 }]);
      fetchClearinghouseState.mockResolvedValueOnce(account([shortHype])).mockResolvedValueOnce(account([remainder]));
      const res = await tightenStop({ coin: 'HYPE', triggerPx: 66.5 });
      expect(res).toMatchObject({ done: true, reprotected: true });
      expect(placeStopOnHl).toHaveBeenLastCalledWith('HYPE', 66.5, 1.2, 'short');
      expect(writeAnalysisLog).toHaveBeenCalledWith(expect.objectContaining({ severity: 'danger' }));
    });

    it('is not done when the replacement stop is not confirmed resting', async () => {
      placeStopOnHl.mockResolvedValueOnce({ pushed: true, oid: 22 }).mockResolvedValueOnce({ pushed: true, oid: 33 });
      findOpenStops.mockResolvedValueOnce(oldStops).mockResolvedValueOnce(confirmed()).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      fetchClearinghouseState.mockResolvedValueOnce(account([shortHype])).mockResolvedValueOnce(account([remainder]));
      expect(await tightenStop({ coin: 'HYPE', triggerPx: 66.5 })).toMatchObject({ done: false, skipped: 'unprotected' });
    });

    it('is not done when only an older, looser stop protects the remainder', async () => {
      cancelStopOnHl.mockRejectedValue(new Error('cancel failed'));
      findOpenStops.mockResolvedValueOnce(oldStops).mockResolvedValueOnce(confirmed()).mockResolvedValueOnce(oldStops);
      fetchClearinghouseState.mockResolvedValueOnce(account([shortHype])).mockResolvedValueOnce(account([remainder]));
      const res = await tightenStop({ coin: 'HYPE', triggerPx: 66.5 });
      expect(res).toMatchObject({ done: false, skipped: 'remainder-on-old-stop', uncancelledOids: [11] });
      expect(placeStopOnHl).toHaveBeenCalledTimes(1);
    });

    it('is done, with no second stop, when the triggered stop closed the whole position', async () => {
      findOpenStops.mockResolvedValueOnce(oldStops).mockResolvedValueOnce(confirmed()).mockResolvedValueOnce([]);
      fetchClearinghouseState.mockResolvedValueOnce(account([shortHype])).mockResolvedValueOnce(account([]));
      expect(await tightenStop({ coin: 'HYPE', triggerPx: 66.5 })).toMatchObject({ done: true, skipped: null });
      expect(placeStopOnHl).toHaveBeenCalledTimes(1);
    });

    it('does not place a stop on a position that changed side', async () => {
      findOpenStops.mockResolvedValueOnce(oldStops).mockResolvedValueOnce(confirmed()).mockResolvedValueOnce([]);
      fetchClearinghouseState.mockResolvedValueOnce(account([shortHype])).mockResolvedValueOnce(account([{ ...shortHype, side: 'long', szi: 1, size: 1 }]));
      expect(await tightenStop({ coin: 'HYPE', triggerPx: 66.5 })).toMatchObject({ done: false, skipped: 'unprotected' });
      expect(placeStopOnHl).toHaveBeenCalledTimes(1);
    });
  });

  it('is not done when the result cannot be read back', async () => {
    findOpenStops.mockResolvedValueOnce(oldStops).mockResolvedValueOnce([...oldStops, { oid: 22, triggerPx: 66.5 }]).mockRejectedValueOnce(new Error('429'));
    expect(await tightenStop({ coin: 'HYPE', triggerPx: 66.5 })).toMatchObject({ done: false, skipped: 'unverified' });
  });

  it('reports an old stop that failed to cancel and still succeeds', async () => {
    cancelStopOnHl.mockRejectedValue(new Error('cancel failed'));
    const res = await tightenStop({ coin: 'HYPE', triggerPx: 66.5 });
    expect(res).toMatchObject({ done: true, uncancelledOids: [11] });
    expect(writeAnalysisLog).toHaveBeenCalledWith(expect.objectContaining({ severity: 'danger' }));
  });
});

describe('reduceClose', () => {
  it('closes the fraction reduce-only on the opposite side, from the venue size', async () => {
    const res = await reduceClose({ coin: 'hype', fraction: 0.4 });
    expect(res).toMatchObject({ done: true, skipped: null, partial: false });
    const intent = executeIntent.mock.calls[0][0];
    expect(intent).toMatchObject({ coin: 'HYPE', side: 'buy', reduceOnly: true, sessionId: 's-live', origin: 'operator' });
    expect(intent.sz).toBe(1.15); // 2.89 x 0.4 = 1.156, floored to the 0.01 lot
    expect(intent.limitPx).toBeUndefined();
    expect(releaseExitLock).toHaveBeenCalledWith('lock-1', 'closed');
  });

  it('sells to close a long', async () => {
    fetchClearinghouseState.mockResolvedValue(account([{ coin: 'HYPE', side: 'long', szi: 2.89, size: 2.89, entryPx: 60 }]));
    await reduceClose({ coin: 'HYPE', fraction: 1 });
    expect(executeIntent.mock.calls[0][0]).toMatchObject({ side: 'sell', reduceOnly: true, sz: 2.89 });
  });

  it('refuses a close under the minimum notional and frees the lock', async () => {
    expect(await reduceClose({ coin: 'HYPE', fraction: 0.05 })).toMatchObject({ done: false, skipped: 'close-below-min-notional' });
    expect(releaseExitLock).toHaveBeenCalledWith('lock-1', 'close-below-min-notional');
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('refuses when the exit lock is held', async () => {
    acquireExitLock.mockResolvedValue(null);
    expect(await reduceClose({ coin: 'HYPE', fraction: 0.4 })).toMatchObject({ done: false, skipped: 'locked' });
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('takes the lock before it reads the venue position', async () => {
    await reduceClose({ coin: 'HYPE', fraction: 0.4 });
    expect(acquireExitLock.mock.invocationCallOrder[0]).toBeLessThan(fetchClearinghouseState.mock.invocationCallOrder[0]);
  });

  it('refuses and frees the lock when the lot size is unreadable', async () => {
    fetchPerpMeta.mockRejectedValue(new Error('down'));
    expect(await reduceClose({ coin: 'HYPE', fraction: 0.4 })).toMatchObject({ done: false, skipped: 'lot-size-unreadable' });
    expect(releaseExitLock).toHaveBeenCalledWith('lock-1', 'lot-size-unreadable');
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('closes a whole position that sits on the lot grid, with no dust left', async () => {
    fetchClearinghouseState.mockResolvedValue(account([{ coin: 'HYPE', side: 'short', szi: -0.29, size: 0.29, entryPx: 69 }]));
    expect(await reduceClose({ coin: 'HYPE', fraction: 1 })).toMatchObject({ done: true, partial: false, filledSz: 0.29 });
    expect(executeIntent.mock.calls[0][0].sz).toBe(0.29);
  });

  it('frees the lock when the order was never sent', async () => {
    executeIntent.mockRejectedValue(new PreSubmitError('no mid'));
    expect(await reduceClose({ coin: 'HYPE', fraction: 0.4 })).toMatchObject({ done: false, skipped: 'not-submitted' });
    expect(releaseExitLock).toHaveBeenCalledWith('lock-1', 'not-submitted');
  });

  it('names a resting stop that a full close leaves behind', async () => {
    await reduceClose({ coin: 'HYPE', fraction: 1 });
    expect(cancelStopOnHl).not.toHaveBeenCalled();
    expect(sendDiscord).toHaveBeenCalledWith(expect.stringContaining('Resting stop oid 11 remains'), expect.any(String));
  });

  it('holds the lock and rethrows when the outcome is unknown', async () => {
    executeIntent.mockRejectedValue(new Error('response lost'));
    await expect(reduceClose({ coin: 'HYPE', fraction: 0.4 })).rejects.toThrow('response lost');
    expect(releaseExitLock).not.toHaveBeenCalled();
    expect(writeAnalysisLog).toHaveBeenCalledWith(expect.objectContaining({ severity: 'danger' }));
  });

  it('releases the lock and reports no fill', async () => {
    executeIntent.mockResolvedValue({ sz: 0, px: 0, partial: false });
    expect(await reduceClose({ coin: 'HYPE', fraction: 0.4 })).toMatchObject({ done: false, skipped: 'no-fill' });
    expect(releaseExitLock).toHaveBeenCalledWith('lock-1', 'no-fill');
  });

  it('flags a partial fill', async () => {
    executeIntent.mockResolvedValue({ sz: 0.5, px: 63.4, partial: true });
    expect(await reduceClose({ coin: 'HYPE', fraction: 0.4 })).toMatchObject({ done: true, partial: true, filledSz: 0.5 });
    expect(releaseExitLock).toHaveBeenCalledWith('lock-1', 'partial');
  });
});
