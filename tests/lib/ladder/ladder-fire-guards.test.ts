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

describe('performLadderRungFire — guard stack', () => {
  it('refuses at the seam when autofire is disabled (belt-and-suspenders kill-switch)', async () => {
    isLadderAutofireEnabled.mockReturnValue(false);
    expect((await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW })).skipped).toBe('autofire-disabled');
    expect(getLadderWithRungs).not.toHaveBeenCalled();
  });

  it('skips when the ladder is absent', async () => {
    getLadderWithRungs.mockResolvedValue(null);
    expect((await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW })).skipped).toBe('ladder-not-found');
    expect(claimRungFire).not.toHaveBeenCalled();
  });

  it('skips a non-armed ladder', async () => {
    getLadderWithRungs.mockResolvedValue(ladder({ status: 'draft' }));
    expect((await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW })).skipped).toMatch(/not-armed/);
  });

  it('disarms + skips an expired ladder', async () => {
    getLadderWithRungs.mockResolvedValue(ladder({ expiresAt: new Date(NOW - 1).toISOString() }));
    expect((await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW })).skipped).toBe('expired');
    expect(disarmLadder).toHaveBeenCalledWith('L1', 'expired');
    expect(claimRungFire).not.toHaveBeenCalled();
  });

  it('refuses (but keeps ARMED) a ladder whose activation window has not opened', async () => {
    getLadderWithRungs.mockResolvedValue(ladder({ activeFrom: new Date(NOW + 60_000).toISOString() }));
    expect((await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW })).skipped).toBe('before-active-from');
    expect(disarmLadder).not.toHaveBeenCalled(); // restrictive only — authorization stands
    expect(claimRungFire).not.toHaveBeenCalled();
  });

  it('fires normally once the activation window is open', async () => {
    getLadderWithRungs.mockResolvedValue(ladder({ activeFrom: new Date(NOW - 60_000).toISOString() }));
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).not.toBe('before-active-from');
  });

  it('refuses a scout-authored ladder (defense-in-depth)', async () => {
    getLadderWithRungs.mockResolvedValue(ladder({ author: 'scout' }));
    expect((await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW })).skipped).toBe('not-operator');
  });

  it('skips a rung that is not pending', async () => {
    getLadderWithRungs.mockResolvedValue(ladder({}, [openRung({ status: 'fired' })]));
    expect((await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW })).skipped).toMatch(/rung-fired/);
  });

  it('auto-disarms + skips on precondition drift', async () => {
    getLadderWithRungs.mockResolvedValue(ladder({ preconditionHash: 'deadbeef' })); // wrong hash
    expect((await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW })).skipped).toBe('precondition-drift');
    expect(disarmLadder).toHaveBeenCalledWith('L1', 'precondition-drift');
    expect(claimRungFire).not.toHaveBeenCalled();
  });

  it('skips when the claim is lost (already fired — idempotent)', async () => {
    claimRungFire.mockResolvedValue({ claimed: false, fireId: null });
    expect((await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW })).skipped).toBe('already-fired');
    expect(executeIntent).not.toHaveBeenCalled();
  });
});

describe('performLadderRungFire — pre-opener guard (Jul-17)', () => {
  const mgmtRung = (over: Partial<LadderRung> = {}): LadderRung =>
    openRung({ id: 'r2', seq: 2, action: 'reduce', reduceFrac: 0.5, triggerKind: 'indicator', triggerPx: null, triggerMeta: { op: 'above', indicatorName: 'momentum-stall-long', indicatorValue: 2 }, cloid: 'L1:r2', ...over });

  it('a management rung on a FLAT coin with the own opener still PENDING waits — no claim, no status change', async () => {
    const lad = ladder({}, [openRung(), mgmtRung()]);
    getLadderWithRungs.mockResolvedValue(lad);
    getActiveSession.mockResolvedValue({ id: 's1', mode: 'paper' });
    loadPosition.mockResolvedValue(null); // flat
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r2', now: NOW });
    expect(res.fired).toBe(false);
    expect(res.skipped).toContain('awaiting-own-opener');
    expect(claimRungFire).not.toHaveBeenCalled(); // claim UNSPENT — retries next candle
    expect(setRungStatus).not.toHaveBeenCalled(); // rung stays PENDING (the whole point)
  });

  it('once the opener has FIRED, a flat coin terminal-skips as before (trade really over)', async () => {
    const lad = ladder({}, [openRung({ status: 'fired' }), mgmtRung()]);
    getLadderWithRungs.mockResolvedValue(lad);
    getActiveSession.mockResolvedValue({ id: 's1', mode: 'paper' });
    loadPosition.mockResolvedValue(null); // flat — position stopped out for real
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r2', now: NOW });
    expect(res.fired).toBe(false);
    expect(claimRungFire).toHaveBeenCalled(); // normal path: claim then flat-skip
    expect(setRungStatus).toHaveBeenCalledWith('r2', 'skipped');
  });

  it('an unreadable position with a pending opener also waits (fail toward pending)', async () => {
    const lad = ladder({}, [openRung(), mgmtRung()]);
    getLadderWithRungs.mockResolvedValue(lad);
    getActiveSession.mockResolvedValue({ id: 's1', mode: 'paper' });
    loadPosition.mockRejectedValue(new Error('db down'));
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r2', now: NOW });
    expect(res.fired).toBe(false);
    expect(res.skipped).toContain('awaiting-own-opener');
    expect(claimRungFire).not.toHaveBeenCalled();
  });
});

