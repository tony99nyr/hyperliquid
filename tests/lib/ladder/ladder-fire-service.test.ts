/**
 * Pins performLadderRungFire — the autonomous money seam's guard stack. Each guard must
 * SKIP (never fire) on doubt; the happy PAPER open must execute + atomically bracket;
 * a bracket reject must FLATTEN. Only I/O is mocked — the pure builders/risk run real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LadderWithRungs, LadderRung } from '@/lib/ladder/ladder-types';

const getLadderWithRungs = vi.fn();
const claimRungFire = vi.fn();
const markFireOutcome = vi.fn();
const setRungStatus = vi.fn();
const markLadderDone = vi.fn();
const disarmOcoSiblings = vi.fn();
const disarmLadder = vi.fn();
const releaseOcoClaim = vi.fn();
const getActiveSession = vi.fn();
const openSession = vi.fn();
const fetchAllMids = vi.fn();
const fetchClearinghouseState = vi.fn();
const executeIntent = vi.fn();
const placeBracketOnHl = vi.fn();
const placeStopOnHl = vi.fn();
const findOpenStop = vi.fn();
const cancelStopOnHl = vi.fn();
const findAllStops = vi.fn();
const checkCircuitBreaker = vi.fn();
const computeLiveEquity = vi.fn();
const setAdvisoryStop = vi.fn();
const loadPosition = vi.fn();
const getTradingMode = vi.fn();
const getHlAccountAddress = vi.fn();
const writeAnalysisLog = vi.fn();
const isLadderAutofireEnabled = vi.fn();
const isLadderLiveEnabled = vi.fn();

vi.mock('@/lib/ladder/ladder-flags', () => ({
  isLadderAutofireEnabled: (...a: unknown[]) => isLadderAutofireEnabled(...a),
  isLadderLiveEnabled: (...a: unknown[]) => isLadderLiveEnabled(...a),
}));
vi.mock('@/lib/ladder/ladder-service', () => ({
  getLadderWithRungs: (...a: unknown[]) => getLadderWithRungs(...a),
  claimRungFire: (...a: unknown[]) => claimRungFire(...a),
  markFireOutcome: (...a: unknown[]) => markFireOutcome(...a),
  setRungStatus: (...a: unknown[]) => setRungStatus(...a),
  markLadderDone: (...a: unknown[]) => markLadderDone(...a),
  disarmOcoSiblings: (...a: unknown[]) => disarmOcoSiblings(...a),
  disarmLadder: (...a: unknown[]) => disarmLadder(...a),
  releaseOcoClaim: (...a: unknown[]) => releaseOcoClaim(...a),
}));
vi.mock('@/lib/cockpit/session-service', () => ({ getActiveSession: (...a: unknown[]) => getActiveSession(...a), openSession: (...a: unknown[]) => openSession(...a) }));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({ fetchAllMids: (...a: unknown[]) => fetchAllMids(...a), fetchClearinghouseState: (...a: unknown[]) => fetchClearinghouseState(...a) }));
vi.mock('@/lib/trading/fill-source', () => ({ executeIntent: (...a: unknown[]) => executeIntent(...a) }));
vi.mock('@/lib/trading/stop-order-service', () => ({
  placeBracketOnHl: (...a: unknown[]) => placeBracketOnHl(...a),
  placeStopOnHl: (...a: unknown[]) => placeStopOnHl(...a),
  findOpenStop: (...a: unknown[]) => findOpenStop(...a),
  cancelStopOnHl: (...a: unknown[]) => cancelStopOnHl(...a),
  findAllStops: (...a: unknown[]) => findAllStops(...a),
}));
vi.mock('@/lib/scout/scout-watch-service', () => ({ setAdvisoryStop: (...a: unknown[]) => setAdvisoryStop(...a) }));
vi.mock('@/lib/risk/circuit-breaker-service', () => ({
  checkCircuitBreaker: (...a: unknown[]) => checkCircuitBreaker(...a),
  computeLiveEquity: (...a: unknown[]) => computeLiveEquity(...a),
}));
vi.mock('@/lib/cockpit/fill-persistence-service', () => ({ loadPosition: (...a: unknown[]) => loadPosition(...a) }));
vi.mock('@/lib/env/mode', () => ({ getTradingMode: (...a: unknown[]) => getTradingMode(...a) }));
vi.mock('@/lib/auto-exit/auto-exit-config', () => ({ getHlAccountAddress: (...a: unknown[]) => getHlAccountAddress(...a) }));
vi.mock('@/lib/env/env', () => ({ validateEnv: () => ({ HL_NETWORK: 'mainnet' }) }));
vi.mock('@/lib/cockpit/analysis-log-service', () => ({ writeAnalysisLog: (...a: unknown[]) => writeAnalysisLog(...a) }));

import { performLadderRungFire } from '@/lib/ladder/ladder-fire-service';
import { PreSubmitError } from '@/lib/trading/pre-submit-error';
import { buildPreconditionSnapshot, hashPreconditionSnapshot } from '@/lib/ladder/ladder-risk-business-logic';

const NOW = 1_700_000_000_000;

function openRung(over: Partial<LadderRung> = {}): LadderRung {
  return {
    id: 'r1', ladderId: 'L1', seq: 1, coin: 'ETH', side: 'long', action: 'open',
    triggerKind: 'price_above', triggerPx: 2000, triggerMeta: null,
    sizeCoins: null, reduceFrac: null, riskUsd: 50, stopFrac: 0.04, leverage: 5, stopPx: null, targetPx: null,
    status: 'pending', cloid: 'L1:r1', ...over,
  };
}
function ladder(over: Partial<LadderWithRungs> = {}, rungs?: LadderRung[]): LadderWithRungs {
  const r = rungs ?? [openRung()];
  // The matching precondition hash for these rungs in PAPER (live state []).
  const hash = hashPreconditionSnapshot(buildPreconditionSnapshot(r, []));
  return {
    id: 'L1', title: 'T', thesis: null, author: 'operator', mode: 'paper', status: 'armed',
    preconditionHash: hash, ocoGroupId: null, leaderAddress: null, maxTotalNotionalUsd: 100_000, maxTotalLossUsd: 5_000, anchorPx: null,
    expiresAt: new Date(NOW + 3_600_000).toISOString(), activeFrom: null, armedAt: null, disarmedAt: null, disarmReason: null, archivedAt: null, expiryAlertAt: null,
    createdAt: '', updatedAt: '', rungs: r, ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchClearinghouseState.mockReset();
  isLadderAutofireEnabled.mockReturnValue(true);
  isLadderLiveEnabled.mockReturnValue(true);
  getLadderWithRungs.mockResolvedValue(ladder());
  claimRungFire.mockResolvedValue({ claimed: true, fireId: 'f1' });
  markFireOutcome.mockResolvedValue(undefined);
  setRungStatus.mockResolvedValue(undefined);
  markLadderDone.mockResolvedValue(undefined);
  disarmOcoSiblings.mockResolvedValue([]);
  disarmLadder.mockResolvedValue(undefined);
  getActiveSession.mockResolvedValue({ id: 's1' });
  openSession.mockResolvedValue({ id: 's1' });
  fetchAllMids.mockResolvedValue({ ETH: 2000 });
  fetchClearinghouseState.mockResolvedValue({ positions: [] });
  executeIntent.mockResolvedValue({ sz: 0.625, avgPx: 2000 });
  placeBracketOnHl.mockResolvedValue({ pushed: false });
  placeStopOnHl.mockResolvedValue({ pushed: false });
  loadPosition.mockResolvedValue(null);
  setAdvisoryStop.mockResolvedValue(true);
  findOpenStop.mockResolvedValue(null);
  cancelStopOnHl.mockResolvedValue({ pushed: true });
  findAllStops.mockResolvedValue({});
  checkCircuitBreaker.mockResolvedValue({ blockNewEntries: false, reason: 'ok', tripped: false, equityUsd: 10_000, peakEquityUsd: 10_000, dayStartEquityUsd: 10_000 }); // fixtures risk $50/rung — equity high enough that the heat gate stays out of unrelated tests
  computeLiveEquity.mockResolvedValue(10_000); // fixtures risk $50/rung — keep the heat gate out of unrelated tests
  getTradingMode.mockReturnValue('paper');
  writeAnalysisLog.mockResolvedValue(undefined);
  getHlAccountAddress.mockReturnValue(null);
});

describe('performLadderRungFire — execution', () => {
  it('fires a PAPER open: simulates the fill and places NO real exchange order', async () => {
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.fired).toBe(true);
    expect(executeIntent).toHaveBeenCalledWith(expect.anything(), { forcePaper: true });
    // CRIT: a paper ladder must NOT write a real stop/bracket to the exchange.
    expect(placeStopOnHl).not.toHaveBeenCalled();
    expect(placeBracketOnHl).not.toHaveBeenCalled();
    expect(markFireOutcome).toHaveBeenCalledWith('f1', 'filled', JSON.stringify({ entryOid: null, stopOid: null, tpOid: null }));
    expect(setRungStatus).toHaveBeenCalledWith('r1', 'fired');
    // Single-rung ladder fully executed → marked done so the UI shows completion.
    expect(markLadderDone).toHaveBeenCalledWith('L1');
    // Ungrouped ladder → no OCO sibling cancellation.
    expect(disarmOcoSiblings).not.toHaveBeenCalled();
  });

  it('OCO: a grouped ladder firing auto-disarms its sibling(s)', async () => {
    getLadderWithRungs.mockResolvedValue(ladder({ ocoGroupId: 'grp-1' }));
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.fired).toBe(true);
    expect(disarmOcoSiblings).toHaveBeenCalledWith('grp-1', 'L1', expect.stringContaining('oco'));
  });

  it('concurrentOcoFires_executeOnlyOneLeg', async () => {
    getTradingMode.mockReturnValue('live');
    getHlAccountAddress.mockReturnValue('0xabc');
    const group = '00000000-0000-4000-8000-000000000001';
    const first = ladder({ id: 'L1', mode: 'live', ocoGroupId: group });
    const secondRung = openRung({ id: 'r2', ladderId: 'L2', side: 'short', cloid: 'L2:r2' });
    const second = ladder({ id: 'L2', mode: 'live', ocoGroupId: group }, [secondRung]);
    getLadderWithRungs.mockImplementation(async (id: string) => id === 'L1' ? first : second);
    placeStopOnHl.mockResolvedValue({ pushed: true, oid: 501 });
    let arrivals = 0;
    let release: (() => void) | undefined;
    const bothAtClaim = new Promise<void>((resolve) => { release = resolve; });
    const claimed = new Set<string>();
    claimRungFire.mockImplementation(async (ladderId: string, rungId: string, _suffix?: string, ocoGroupId?: string) => {
      arrivals += 1;
      if (arrivals === 2) release?.();
      await bothAtClaim;
      const key = ocoGroupId ?? `${ladderId}:${rungId}`;
      if (claimed.has(key)) return { claimed: false, fireId: null };
      claimed.add(key);
      return { claimed: true, fireId: `f-${ladderId}` };
    });
    const results = await Promise.all([
      performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW }),
      performLadderRungFire({ ladderId: 'L2', rungId: 'r2', now: NOW }),
    ]);
    expect(results.filter((result) => result.fired)).toHaveLength(1);
    expect(executeIntent).toHaveBeenCalledTimes(1);
  });

  it('zero-fill (IOC did not cross) → no-fill skip, no bracket (HIGH-1)', async () => {
    executeIntent.mockResolvedValue({ sz: 0, avgPx: 0 });
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toBe('no-fill');
    expect(placeStopOnHl).not.toHaveBeenCalled();
    expect(markFireOutcome).toHaveBeenCalledWith('f1', 'failed', 'no-fill');
    expect(releaseOcoClaim).not.toHaveBeenCalled(); // not an OCO ladder
  });

  it('a paper open does not consume its claim on an unrelated position read error', async () => {
    loadPosition.mockRejectedValue(new Error('ledger temporarily unavailable'));
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.fired).toBe(true);
    expect(executeIntent).toHaveBeenCalledTimes(1);
  });

  it('OCO no-fill releases the group claim so the sibling leg stays live', async () => {
    getLadderWithRungs.mockResolvedValue(ladder({ ocoGroupId: 'grp-1' }));
    executeIntent.mockResolvedValue({ sz: 0, avgPx: 0 });
    releaseOcoClaim.mockResolvedValue(undefined);
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toBe('no-fill');
    expect(releaseOcoClaim).toHaveBeenCalledWith('grp-1', 'L1', 'r1');
    expect(disarmOcoSiblings).not.toHaveBeenCalled();
  });

  it('releases an OCO no-fill before telemetry can throw', async () => {
    getLadderWithRungs.mockResolvedValue(ladder({ ocoGroupId: 'grp-1' }));
    executeIntent.mockResolvedValue({ sz: 0 });
    markFireOutcome.mockRejectedValue(new Error('telemetry down'));
    await expect(performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW })).rejects.toThrow('telemetry down');
    expect(releaseOcoClaim).toHaveBeenCalledWith('grp-1', 'L1', 'r1');
    expect(releaseOcoClaim.mock.invocationCallOrder[0]).toBeLessThan(markFireOutcome.mock.invocationCallOrder[0]);
  });

  it('a rejected live OCO open with a verified flat position releases its claim and reports the reject', async () => {
    getTradingMode.mockReturnValue('live');
    getHlAccountAddress.mockReturnValue('0xabc');
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live', ocoGroupId: 'grp-1' }));
    fetchClearinghouseState.mockResolvedValue({ stale: false, positions: [] });
    executeIntent.mockRejectedValue(new Error('HL order error: insufficient margin'));
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res).toMatchObject({ fired: false, skipped: 'open-rejected' });
    expect(releaseOcoClaim).toHaveBeenCalledWith('grp-1', 'L1', 'r1');
    expect(markFireOutcome).toHaveBeenCalledWith('f1', 'failed', expect.stringContaining('insufficient margin'));
    expect(writeAnalysisLog).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('insufficient margin') }));
    expect(writeAnalysisLog).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('fault after fill') }));
  });

  it.each(['no live mid', 'size rounds below lot size', 'HL updateLeverage failed', 'missing agent key', 'Conflicting live intent'])('releases an OCO claim for a pre-submit failure: %s', async (message) => {
    getTradingMode.mockReturnValue('live');
    getHlAccountAddress.mockReturnValue('0xabc');
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live', ocoGroupId: 'grp-1' }));
    fetchClearinghouseState.mockResolvedValue({ stale: false, positions: [] });
    executeIntent.mockRejectedValue(new PreSubmitError(message));
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toBe('open-rejected');
    expect(releaseOcoClaim).toHaveBeenCalledWith('grp-1', 'L1', 'r1');
    expect(writeAnalysisLog).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('outcome unknown') }));
  });

  it('treats a flat paper position after an open throws as a rejection', async () => {
    getLadderWithRungs.mockResolvedValue(ladder({ ocoGroupId: 'grp-1' }));
    executeIntent.mockRejectedValue(new Error('paper book unavailable'));
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toBe('open-rejected');
    expect(releaseOcoClaim).toHaveBeenCalledWith('grp-1', 'L1', 'r1');
  });

  it('releases a pre-submit OCO claim even when the position read fails', async () => {
    getTradingMode.mockReturnValue('live');
    getHlAccountAddress.mockReturnValue('0xabc');
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live', ocoGroupId: 'grp-1' }));
    fetchClearinghouseState.mockResolvedValue({ stale: false, positions: [] });
    executeIntent.mockRejectedValue(new PreSubmitError('sign failed'));
    fetchClearinghouseState.mockResolvedValueOnce({ stale: false, positions: [] })
      .mockRejectedValueOnce(new Error('read failed'));
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toBe('open-rejected');
    expect(releaseOcoClaim).toHaveBeenCalledWith('grp-1', 'L1', 'r1');
    expect(fetchClearinghouseState).toHaveBeenCalledTimes(1);
  });

  it('does not flatten an existing position when the exchange rejects an open', async () => {
    getTradingMode.mockReturnValue('live');
    getHlAccountAddress.mockReturnValue('0xabc');
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live', ocoGroupId: 'grp-1' }));
    fetchClearinghouseState.mockResolvedValue({ stale: false, positions: [{ coin: 'ETH', side: 'long', size: 1, entryPx: 1800 }] });
    executeIntent.mockRejectedValue(new Error('HL order error: insufficient margin'));
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toBe('open-rejected');
    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(releaseOcoClaim).toHaveBeenCalledWith('grp-1', 'L1', 'r1');
  });

  it('keeps the OCO claim and reports an unknown outcome after a transport timeout', async () => {
    getTradingMode.mockReturnValue('live');
    getHlAccountAddress.mockReturnValue('0xabc');
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live', ocoGroupId: 'grp-1' }));
    fetchClearinghouseState.mockResolvedValue({ stale: false, positions: [{ coin: 'ETH', side: 'long', size: 1, entryPx: 1800 }] });
    executeIntent.mockRejectedValue(new Error('fetch timed out'));
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.fired).toBe(false);
    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(releaseOcoClaim).not.toHaveBeenCalled();
    expect(writeAnalysisLog).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('outcome unknown') }));
  });

  it('a rejected live open keeps the OCO claim when the position read finds a fill', async () => {
    getTradingMode.mockReturnValue('live');
    getHlAccountAddress.mockReturnValue('0xabc');
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live', ocoGroupId: 'grp-1' }));
    fetchClearinghouseState.mockResolvedValueOnce({ stale: false, positions: [] })
      .mockResolvedValue({ stale: false, positions: [{ coin: 'ETH', side: 'long', size: 0.625, entryPx: 2000 }] });
    executeIntent.mockRejectedValueOnce(new Error('persist failed')).mockResolvedValue({ sz: 0.625, hlOrderId: '102' });
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toBe('fault-flattened');
    expect(releaseOcoClaim).not.toHaveBeenCalled();
  });

  it('OCO no-fill whose release fails sends a critical alert naming the dead straddle', async () => {
    getLadderWithRungs.mockResolvedValue(ladder({ ocoGroupId: 'grp-1' }));
    executeIntent.mockResolvedValue({ sz: 0, avgPx: 0 });
    releaseOcoClaim.mockRejectedValue(new Error('db down'));
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toBe('no-fill');
    expect(writeAnalysisLog).toHaveBeenCalledWith(expect.objectContaining({ severity: 'danger', message: expect.stringContaining('could not release its OCO group') }));
  });

  it('MODE-MISMATCH: a PAPER ladder on a LIVE deployment is skipped WITHOUT claiming', async () => {
    getTradingMode.mockReturnValue('live'); // live deployment, paper ladder
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toBe('mode-mismatch');
    expect(claimRungFire).not.toHaveBeenCalled(); // claim not spent → the matching box can fire it
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('MODE-MISMATCH: a LIVE ladder on a PAPER deployment is skipped WITHOUT claiming', async () => {
    getTradingMode.mockReturnValue('paper');
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live' }));
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toBe('mode-mismatch');
    expect(claimRungFire).not.toHaveBeenCalled();
  });

  it('LIVE-DISABLED: a live ladder is refused at FIRE when LADDER_LIVE_ENABLED is off', async () => {
    getTradingMode.mockReturnValue('live');
    isLadderLiveEnabled.mockReturnValue(false); // operator flipped the live kill-switch
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live' }));
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toBe('live-disabled');
    expect(claimRungFire).not.toHaveBeenCalled();
  });

  it('a LIVE ladder on a LIVE deployment fills live (forcePaper false)', async () => {
    getTradingMode.mockReturnValue('live');
    getHlAccountAddress.mockReturnValue('0xabc'); // heat gate needs the live account
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live' }));
    await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(executeIntent).toHaveBeenCalledWith(expect.anything(), { forcePaper: false });
  });

  it('a LIVE ladder with a target places a real BRACKET', async () => {
    getTradingMode.mockReturnValue('live');
    getHlAccountAddress.mockReturnValue('0xabc');
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live' }, [openRung({ targetPx: 2200 })]));
    await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(placeBracketOnHl).toHaveBeenCalledWith('ETH', expect.closeTo(1920, 1), 2200, 0.625, 'long');
  });

  it('accepts a grouped bracket after the stop service reads back its resting oid', async () => {
    getTradingMode.mockReturnValue('live');
    getHlAccountAddress.mockReturnValue('0xabc');
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live' }, [openRung({ targetPx: 2200 })]));
    placeBracketOnHl.mockResolvedValue({ pushed: true, stopOid: 501, tpOid: null });
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.fired).toBe(true);
    expect(findOpenStop).not.toHaveBeenCalled();
    expect(markFireOutcome).toHaveBeenCalledWith('f1', 'filled', JSON.stringify({ entryOid: null, stopOid: 501, tpOid: null }));
  });

  it('liveOpen_requiresConfirmedRestingStop', async () => {
    getTradingMode.mockReturnValue('live');
    getHlAccountAddress.mockReturnValue('0xabc');
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live' }));
    fetchClearinghouseState.mockResolvedValue({ stale: false, positions: [{ coin: 'ETH', side: 'long', size: 0.4, entryPx: 2000, unrealizedPnl: '0' }] });
    for (const response of [{ pushed: false, oid: 501 }, { pushed: true, oid: null }]) {
      vi.clearAllMocks();
      executeIntent.mockResolvedValueOnce({ sz: 0.4, avgPx: 2000, partial: true, hlOrderId: '101' })
        .mockResolvedValueOnce({ sz: 0.4, avgPx: 2000, hlOrderId: '102' });
      placeStopOnHl.mockResolvedValue(response);
      const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
      expect(res).toMatchObject({ fired: false, flattened: true });
      expect(executeIntent).toHaveBeenCalledTimes(2);
      expect(markFireOutcome).not.toHaveBeenCalledWith('f1', 'filled', expect.anything());
    }
  });

  it('cancels known bracket orders after a successful fault flatten', async () => {
    getTradingMode.mockReturnValue('live');
    getHlAccountAddress.mockReturnValue('0xabc');
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live' }, [openRung({ targetPx: 2200 })]));
    fetchClearinghouseState.mockResolvedValue({ stale: false, positions: [{ coin: 'ETH', side: 'long', size: 0.625, entryPx: 2000 }] });
    placeBracketOnHl.mockResolvedValue({ pushed: false, stopOid: 501, tpOid: 502 });
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res).toMatchObject({ fired: false, flattened: true });
    expect(cancelStopOnHl).toHaveBeenCalledWith('ETH', 501);
    expect(cancelStopOnHl).toHaveBeenCalledWith('ETH', 502);
    expect(executeIntent.mock.invocationCallOrder[1]).toBeLessThan(cancelStopOnHl.mock.invocationCallOrder[0]);
  });

  it('reports a failed cancel and tries both known bracket orders', async () => {
    getTradingMode.mockReturnValue('live');
    getHlAccountAddress.mockReturnValue('0xabc');
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live' }, [openRung({ targetPx: 2200 })]));
    fetchClearinghouseState.mockResolvedValue({ stale: false, positions: [{ coin: 'ETH', side: 'long', size: 0.625, entryPx: 2000 }] });
    placeBracketOnHl.mockResolvedValue({ pushed: false, stopOid: 501, tpOid: 502 });
    cancelStopOnHl.mockRejectedValueOnce(new Error('cancel failed')).mockResolvedValueOnce({ pushed: true });
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toBe('fault-cancel-failed');
    expect(cancelStopOnHl).toHaveBeenCalledTimes(2);
    expect(markFireOutcome).toHaveBeenCalledWith('f1', 'failed', expect.stringContaining('orphan'));
  });

  it('keeps the protective stop when the fault close does not fill', async () => {
    getTradingMode.mockReturnValue('live');
    getHlAccountAddress.mockReturnValue('0xabc');
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live' }, [openRung({ targetPx: 2200 })]));
    fetchClearinghouseState.mockResolvedValue({ stale: false, positions: [{ coin: 'ETH', side: 'long', size: 0.625, entryPx: 2000 }] });
    placeBracketOnHl.mockResolvedValue({ pushed: false, stopOid: 501, tpOid: 502 });
    executeIntent.mockResolvedValueOnce({ sz: 0.625, avgPx: 2000 }).mockResolvedValueOnce({ sz: 0, avgPx: 0 });
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res).toMatchObject({ flattened: false, skipped: 'fault-flatten-failed' });
    expect(cancelStopOnHl).not.toHaveBeenCalled();
  });

  it('postFillFault_withStaleClearinghouse_reportsUnstopped', async () => {
    getTradingMode.mockReturnValue('live');
    getHlAccountAddress.mockReturnValue('0xabc');
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live' }));
    executeIntent.mockResolvedValue({ sz: 0.4, avgPx: 2000, partial: true, hlOrderId: '101' });
    placeStopOnHl.mockRejectedValue(new Error('stop rejected'));
    fetchClearinghouseState.mockResolvedValueOnce({ stale: false, positions: [] })
      .mockResolvedValueOnce({ stale: true, positions: [] });
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res).toMatchObject({ fired: false, flattened: false, skipped: 'fault-flatten-failed' });
    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(markFireOutcome).toHaveBeenCalledWith('f1', 'failed', expect.stringContaining('UNSTOPPED'));
    expect(writeAnalysisLog).toHaveBeenCalledWith(expect.objectContaining({ severity: 'danger', message: expect.stringContaining('UNSTOPPED') }));
  });

  it('FLATTENS a LIVE fill on a bracket reject (filled-but-unstopped hard fault)', async () => {
    getTradingMode.mockReturnValue('live');
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live' }));
    getHlAccountAddress.mockReturnValue('0xabc'); // live → loadEffectivePosition reads HL
    placeStopOnHl.mockRejectedValue(new Error('HL stop rejected'));
    // loadEffectivePosition reads the LIVE HL position for a live ladder.
    fetchClearinghouseState.mockResolvedValueOnce({ positions: [] })
      .mockResolvedValue({ positions: [{ coin: 'ETH', side: 'long', size: 0.625, entryPx: 2000 }] });
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.flattened).toBe(true);
    expect(res.fired).toBe(false);
    expect(executeIntent).toHaveBeenCalledTimes(2); // the open, then the reduce-only flatten
    expect(markFireOutcome).toHaveBeenCalledWith('f1', 'flattened', expect.stringContaining('fault-flattened'));
    expect(setRungStatus).toHaveBeenCalledWith('r1', 'failed');
  });

  it('CRIT-B: executeIntent THROWS post-fill on a live ladder → flattens (no silent unstopped position)', async () => {
    getTradingMode.mockReturnValue('live');
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live' }));
    // The live order FILLED on HL, but persistFill threw → executeIntent throws on the open.
    getHlAccountAddress.mockReturnValue('0xabc'); // live → loadEffectivePosition reads HL
    executeIntent.mockRejectedValueOnce(new Error('Supabase persistFill failed')).mockResolvedValue({ sz: 0.625, avgPx: 2000 });
    fetchClearinghouseState.mockResolvedValueOnce({ positions: [] })
      .mockResolvedValue({ positions: [{ coin: 'ETH', side: 'long', size: 0.625, entryPx: 2000 }] });
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.flattened).toBe(true); // the (possible) exposure was flattened, not left unstopped
    expect(executeIntent).toHaveBeenCalledTimes(2); // the throwing open, then the flatten close
    expect(setRungStatus).toHaveBeenCalledWith('r1', 'failed');
  });

  it('CRIT-B worst case: post-fill throw AND flatten ALSO fails → CRITICAL unstopped fault (not "flattened")', async () => {
    getTradingMode.mockReturnValue('live');
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live' }));
    getHlAccountAddress.mockReturnValue('0xabc'); // live → loadEffectivePosition reads HL
    executeIntent.mockRejectedValue(new Error('exchange/db error')); // both the open AND the flatten close fail
    fetchClearinghouseState.mockResolvedValue({ positions: [{ coin: 'ETH', side: 'long', size: 0.625, entryPx: 2000 }] });
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.flattened).toBe(false);
    expect(markFireOutcome).toHaveBeenCalledWith('f1', 'failed', expect.stringContaining('UNSTOPPED'));
  });

  it('a LIVE add that is profit-COVERED fires + places a real bracket', async () => {
    getTradingMode.mockReturnValue('live');
    getHlAccountAddress.mockReturnValue('0xabc');
    placeStopOnHl.mockResolvedValue({ pushed: true, oid: 501 });
    const addRung = openRung({ action: 'add' });
    // arm-time precondition hash must match the live ETH position at fire (add depends on it).
    const liveState = [{ coin: 'ETH', side: 'long' as const, leverage: 5 }];
    getLadderWithRungs.mockResolvedValue(
      ladder({ mode: 'live', preconditionHash: hashPreconditionSnapshot(buildPreconditionSnapshot([addRung], liveState)) }, [addRung]),
    );
    // used by both the precondition re-derive AND the add profit-guard; profit 500 >> add risk ~170.
    fetchClearinghouseState.mockResolvedValue({ positions: [{ coin: 'ETH', side: 'long', size: 1, entryPx: 1800, leverage: 5, unrealizedPnl: 500 }] });
    loadPosition.mockResolvedValue({ coin: 'ETH', side: 'long', sz: 1, avgEntryPx: 1800, realizedPnlUsd: 0, feesPaidUsd: 0 });
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.fired).toBe(true);
    expect(placeStopOnHl).toHaveBeenCalled(); // live → a real protective stop rests
    expect(markFireOutcome).toHaveBeenCalledWith('f1', 'filled', JSON.stringify({ entryOid: null, stopOid: 501, tpOid: null }));
  });

  it('does not flatten the healthy base when a live add is rejected', async () => {
    getTradingMode.mockReturnValue('live');
    getHlAccountAddress.mockReturnValue('0xabc');
    const add = openRung({ action: 'add' });
    const liveState = [{ coin: 'ETH', side: 'long' as const, leverage: 5 }];
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live', preconditionHash: hashPreconditionSnapshot(buildPreconditionSnapshot([add], liveState)) }, [add]));
    fetchClearinghouseState.mockResolvedValue({ stale: false, positions: [{ coin: 'ETH', side: 'long', size: 1, entryPx: 1800, leverage: 5, unrealizedPnl: 500 }] });
    loadPosition.mockResolvedValue({ coin: 'ETH', side: 'long', sz: 1, avgEntryPx: 1800 });
    executeIntent.mockRejectedValue(new Error('HL order error: insufficient margin'));
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toBe('open-rejected');
    expect(executeIntent).toHaveBeenCalledTimes(1);
  });

  it('a stale live-add read skips before the claim and leaves the rung pending', async () => {
    getTradingMode.mockReturnValue('live');
    getHlAccountAddress.mockReturnValue('0xabc');
    const add = openRung({ action: 'add' });
    const liveState = [{ coin: 'ETH', side: 'long' as const, leverage: 5 }];
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live', preconditionHash: hashPreconditionSnapshot(buildPreconditionSnapshot([add], liveState)) }, [add]));
    fetchClearinghouseState.mockResolvedValueOnce({ stale: false, positions: [{ coin: 'ETH', side: 'long', size: 1, leverage: 5 }] })
      .mockResolvedValueOnce({ stale: false, positions: [] })
      .mockResolvedValueOnce({ stale: true, positions: [] });
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toContain('cannot-verify-add');
    expect(claimRungFire).not.toHaveBeenCalled();
    expect(setRungStatus).not.toHaveBeenCalled();
  });

  it('invalid live add uPnL skips before the claim and stays retryable', async () => {
    getTradingMode.mockReturnValue('live');
    getHlAccountAddress.mockReturnValue('0xabc');
    const add = openRung({ action: 'add' });
    const liveState = [{ coin: 'ETH', side: 'long' as const, leverage: 5 }];
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live', preconditionHash: hashPreconditionSnapshot(buildPreconditionSnapshot([add], liveState)) }, [add]));
    fetchClearinghouseState.mockResolvedValue({ stale: false, positions: [{ coin: 'ETH', side: 'long', size: 1, leverage: 5, unrealizedPnl: 0, unrealizedPnlValid: false }] });
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toBe('cannot-verify-add: invalid uPnL');
    expect(claimRungFire).not.toHaveBeenCalled();
    expect(setRungStatus).not.toHaveBeenCalled();
  });

  it('liveAdd_refusesOppositeSidePosition', async () => {
    getTradingMode.mockReturnValue('live');
    getHlAccountAddress.mockReturnValue('0xabc');
    const opener = openRung();
    const add = openRung({ id: 'r2', seq: 2, action: 'add', cloid: 'L1:r2' });
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live' }, [opener, add]));
    fetchClearinghouseState.mockResolvedValue({ stale: false, positions: [
      { coin: 'ETH', side: 'short', size: 0.2, entryPx: 4000, leverage: 5, unrealizedPnl: '400' },
    ] });
    loadPosition.mockResolvedValue({ coin: 'ETH', side: 'long', sz: 1, avgEntryPx: 1800 });
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r2', now: NOW });
    expect(res.fired).toBe(false);
    expect(res.skipped).toBe('add-opposite-side-position');
    expect(markFireOutcome).toHaveBeenCalledWith('f1', 'skipped', 'add-opposite-side-position');
    expect(setRungStatus).toHaveBeenCalledWith('r2', 'skipped');
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('REFUSES an add whose risk is not covered by unrealized profit (no martingale)', async () => {
    getLadderWithRungs.mockResolvedValue(ladder({}, [openRung({ action: 'add' })]));
    // A flat/zero-profit position can never cover an add.
    loadPosition.mockResolvedValue({ coin: 'ETH', side: 'long', sz: 1, avgEntryPx: 2000, realizedPnlUsd: 0, feesPaidUsd: 0 });
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toBe('add-risk-not-covered');
    expect(executeIntent).not.toHaveBeenCalled();
    expect(setRungStatus).toHaveBeenCalledWith('r1', 'skipped');
  });
});
