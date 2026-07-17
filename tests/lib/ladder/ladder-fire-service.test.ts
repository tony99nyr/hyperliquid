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
    preconditionHash: hash, ocoGroupId: null, leaderAddress: null, maxTotalNotionalUsd: 100_000, maxTotalLossUsd: 5_000,
    expiresAt: new Date(NOW + 3_600_000).toISOString(), activeFrom: null, armedAt: null, disarmedAt: null, disarmReason: null, archivedAt: null, expiryAlertAt: null,
    createdAt: '', updatedAt: '', rungs: r, ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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

describe('performLadderRungFire — execution', () => {
  it('fires a PAPER open: simulates the fill and places NO real exchange order', async () => {
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.fired).toBe(true);
    expect(executeIntent).toHaveBeenCalledWith(expect.anything(), { forcePaper: true });
    // CRIT: a paper ladder must NOT write a real stop/bracket to the exchange.
    expect(placeStopOnHl).not.toHaveBeenCalled();
    expect(placeBracketOnHl).not.toHaveBeenCalled();
    expect(markFireOutcome).toHaveBeenCalledWith('f1', 'filled');
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

  it('zero-fill (IOC did not cross) → no-fill skip, no bracket (HIGH-1)', async () => {
    executeIntent.mockResolvedValue({ sz: 0, avgPx: 0 });
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toBe('no-fill');
    expect(placeStopOnHl).not.toHaveBeenCalled();
    expect(markFireOutcome).toHaveBeenCalledWith('f1', 'failed', 'no-fill');
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

  it('FLATTENS a LIVE fill on a bracket reject (filled-but-unstopped hard fault)', async () => {
    getTradingMode.mockReturnValue('live');
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live' }));
    getHlAccountAddress.mockReturnValue('0xabc'); // live → loadEffectivePosition reads HL
    placeStopOnHl.mockRejectedValue(new Error('HL stop rejected'));
    // loadEffectivePosition reads the LIVE HL position for a live ladder.
    fetchClearinghouseState.mockResolvedValue({ positions: [{ coin: 'ETH', side: 'long', size: 0.625, entryPx: 2000 }] });
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
    fetchClearinghouseState.mockResolvedValue({ positions: [{ coin: 'ETH', side: 'long', size: 0.625, entryPx: 2000 }] });
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
    expect(markFireOutcome).toHaveBeenCalledWith('f1', 'filled');
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

describe('performLadderRungFire — stop_move (paper path + guards)', () => {
  const smRung = (over: Partial<LadderRung> = {}): LadderRung =>
    openRung({
      id: 'r1', action: 'stop_move', side: 'long',
      triggerKind: 'price_above', triggerPx: 66.85,
      triggerMeta: { moveTo: 'breakeven' },
      riskUsd: null, stopFrac: null, leverage: null,
      ...over,
    });
  const smLadder = (rung: LadderRung) => ladder({}, [rung]);

  it('paper: ratchets the ADVISORY stop to breakeven and marks fired', async () => {
    getLadderWithRungs.mockResolvedValue(smLadder(smRung()));
    loadPosition.mockResolvedValue({ coin: 'ETH', side: 'long', sz: 2, avgEntryPx: 65.0, realizedPnlUsd: 0, feesPaidUsd: 0 });
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.fired).toBe(true);
    expect(setAdvisoryStop).toHaveBeenCalledWith('s1', 'ETH', 65.0);
    expect(setRungStatus).toHaveBeenCalledWith('r1', 'fired');
    expect(placeStopOnHl).not.toHaveBeenCalled(); // paper NEVER touches the exchange
  });

  it('skips (rung → skipped) when the position is flat', async () => {
    getLadderWithRungs.mockResolvedValue(smLadder(smRung()));
    loadPosition.mockResolvedValue(null);
  setAdvisoryStop.mockResolvedValue(true);
  findOpenStop.mockResolvedValue(null);
  cancelStopOnHl.mockResolvedValue({ pushed: true });
  findAllStops.mockResolvedValue({});
  checkCircuitBreaker.mockResolvedValue({ blockNewEntries: false, reason: 'ok', tripped: false, equityUsd: 10_000, peakEquityUsd: 10_000, dayStartEquityUsd: 10_000 }); // fixtures risk $50/rung — equity high enough that the heat gate stays out of unrelated tests
  computeLiveEquity.mockResolvedValue(10_000); // fixtures risk $50/rung — keep the heat gate out of unrelated tests
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toBe('flat');
    expect(setRungStatus).toHaveBeenCalledWith('r1', 'skipped');
  });

  it('refuses a stop that would trigger instantly (not protective vs the mark)', async () => {
    // mark is 2000 (mock default); a long stop_move to 2050 is at/through the mark.
    getLadderWithRungs.mockResolvedValue(smLadder(smRung({ triggerMeta: { moveTo: 2050 } })));
    loadPosition.mockResolvedValue({ coin: 'ETH', side: 'long', sz: 2, avgEntryPx: 1900, realizedPnlUsd: 0, feesPaidUsd: 0 });
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toBe('stop-would-trigger');
    expect(setAdvisoryStop).not.toHaveBeenCalled();
  });

  it('fails closed on an invalid moveTo', async () => {
    getLadderWithRungs.mockResolvedValue(smLadder(smRung({ triggerMeta: { moveTo: -5 } })));
    loadPosition.mockResolvedValue({ coin: 'ETH', side: 'long', sz: 2, avgEntryPx: 1900, realizedPnlUsd: 0, feesPaidUsd: 0 });
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toBe('invalid-moveTo');
  });
});

describe('performLadderRungFire — exposure gates (EDGE_ROADMAP 3a/3c)', () => {
  beforeEach(() => {
    getTradingMode.mockReturnValue('live');
    getHlAccountAddress.mockReturnValue('0xabc');
  });

  it('a tripped LIVE circuit breaker blocks opens (before the claim — retryable)', async () => {
    checkCircuitBreaker.mockResolvedValue({ blockNewEntries: true, reason: 'daily loss', tripped: true, equityUsd: 900, peakEquityUsd: 1000, dayStartEquityUsd: 1000 });
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live' }));
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toMatch(/circuit-breaker/);
    expect(claimRungFire).not.toHaveBeenCalled();
  });

  it('book heat over the ceiling blocks opens', async () => {
    checkCircuitBreaker.mockResolvedValue({ blockNewEntries: false, reason: 'ok', tripped: false, equityUsd: 500, peakEquityUsd: 500, dayStartEquityUsd: 500 }); // rung worst ≈ $175 > 10% of 500
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live' }));
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toMatch(/book-heat-exceeded/);
    expect(claimRungFire).not.toHaveBeenCalled();
  });

  it('risk-reducing rungs are NEVER gated (a LIVE reduce passes a tripped breaker)', async () => {
    checkCircuitBreaker.mockResolvedValue({ blockNewEntries: true, reason: 'daily loss', tripped: true, equityUsd: 900, peakEquityUsd: 1000, dayStartEquityUsd: 1000 });
    const r = openRung({ id: 'r1', action: 'reduce', reduceFrac: 0.5, riskUsd: null, stopFrac: null, triggerPx: 2000 });
    getTradingMode.mockReturnValue('live'); // LIVE path — the exemption itself is what's tested
    getHlAccountAddress.mockReturnValue('0xabc');
    fetchClearinghouseState.mockResolvedValue({ positions: [], stale: false }); // flat on HL
    getLadderWithRungs.mockResolvedValue(ladder({ mode: 'live' }, [r]));
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.skipped).toBe('flat'); // reached fireReduce — the gates never ran
    expect(checkCircuitBreaker).not.toHaveBeenCalled();
  });

  it('TRAIL stop_move: fires per candle (bucketed claim), stays PENDING, never marks the ladder done', async () => {
    const trail = openRung({
      id: 'r1', action: 'stop_move', side: 'long', triggerKind: 'price_above', triggerPx: 1950,
      triggerMeta: { moveTo: 'trail', trailDistancePx: 30 }, riskUsd: null, stopFrac: null,
    });
    getTradingMode.mockReturnValue('paper'); // paper ladder on paper deployment (mode-match)
    getLadderWithRungs.mockResolvedValue(ladder({}, [trail])); // paper ladder — advisory path
    loadPosition.mockResolvedValue({ coin: 'ETH', side: 'long', sz: 1, avgEntryPx: 1900, realizedPnlUsd: 0, feesPaidUsd: 0 });
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.fired).toBe(true);
    // per-candle claim: the dedupe suffix is the 15m bucket
    expect(claimRungFire).toHaveBeenCalledWith('L1', 'r1', String(Math.floor(NOW / (15 * 60 * 1000))));
    // stays pending: never marked fired, ladder never done
    expect(setRungStatus).not.toHaveBeenCalledWith('r1', 'fired');
    expect(markLadderDone).not.toHaveBeenCalled();
    // advisory stop trailed to mark − distance = 2000 − 30
    expect(setAdvisoryStop).toHaveBeenCalledWith('s1', 'ETH', 1970);
  });
});
