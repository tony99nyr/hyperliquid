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
const disarmLadder = vi.fn();
const getActiveSession = vi.fn();
const openSession = vi.fn();
const fetchAllMids = vi.fn();
const fetchClearinghouseState = vi.fn();
const executeIntent = vi.fn();
const placeBracketOnHl = vi.fn();
const placeStopOnHl = vi.fn();
const loadPosition = vi.fn();
const getTradingMode = vi.fn();
const getHlAccountAddress = vi.fn();
const writeAnalysisLog = vi.fn();
const isLadderAutofireEnabled = vi.fn();

vi.mock('@/lib/ladder/ladder-flags', () => ({ isLadderAutofireEnabled: (...a: unknown[]) => isLadderAutofireEnabled(...a) }));
vi.mock('@/lib/ladder/ladder-service', () => ({
  getLadderWithRungs: (...a: unknown[]) => getLadderWithRungs(...a),
  claimRungFire: (...a: unknown[]) => claimRungFire(...a),
  markFireOutcome: (...a: unknown[]) => markFireOutcome(...a),
  setRungStatus: (...a: unknown[]) => setRungStatus(...a),
  disarmLadder: (...a: unknown[]) => disarmLadder(...a),
}));
vi.mock('@/lib/cockpit/session-service', () => ({ getActiveSession: (...a: unknown[]) => getActiveSession(...a), openSession: (...a: unknown[]) => openSession(...a) }));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({ fetchAllMids: (...a: unknown[]) => fetchAllMids(...a), fetchClearinghouseState: (...a: unknown[]) => fetchClearinghouseState(...a) }));
vi.mock('@/lib/trading/fill-source', () => ({ executeIntent: (...a: unknown[]) => executeIntent(...a) }));
vi.mock('@/lib/trading/stop-order-service', () => ({ placeBracketOnHl: (...a: unknown[]) => placeBracketOnHl(...a), placeStopOnHl: (...a: unknown[]) => placeStopOnHl(...a) }));
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
    sizeCoins: null, riskUsd: 50, stopFrac: 0.04, leverage: 5, stopPx: null, targetPx: null,
    status: 'pending', cloid: 'L1:r1', ...over,
  };
}
function ladder(over: Partial<LadderWithRungs> = {}, rungs?: LadderRung[]): LadderWithRungs {
  const r = rungs ?? [openRung()];
  // The matching precondition hash for these rungs in PAPER (live state []).
  const hash = hashPreconditionSnapshot(buildPreconditionSnapshot(r, []));
  return {
    id: 'L1', title: 'T', thesis: null, author: 'operator', mode: 'paper', status: 'armed',
    preconditionHash: hash, maxTotalNotionalUsd: 100_000, maxTotalLossUsd: 5_000,
    expiresAt: new Date(NOW + 3_600_000).toISOString(), armedAt: null, disarmedAt: null, disarmReason: null,
    createdAt: '', updatedAt: '', rungs: r, ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isLadderAutofireEnabled.mockReturnValue(true);
  getLadderWithRungs.mockResolvedValue(ladder());
  claimRungFire.mockResolvedValue({ claimed: true, fireId: 'f1' });
  markFireOutcome.mockResolvedValue(undefined);
  setRungStatus.mockResolvedValue(undefined);
  disarmLadder.mockResolvedValue(undefined);
  getActiveSession.mockResolvedValue({ id: 's1' });
  openSession.mockResolvedValue({ id: 's1' });
  fetchAllMids.mockResolvedValue({ ETH: 2000 });
  fetchClearinghouseState.mockResolvedValue({ positions: [] });
  executeIntent.mockResolvedValue({ sz: 0.625, avgPx: 2000 });
  placeBracketOnHl.mockResolvedValue({ pushed: false });
  placeStopOnHl.mockResolvedValue({ pushed: false });
  loadPosition.mockResolvedValue(null);
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

describe('performLadderRungFire — execution', () => {
  it('fires a PAPER open: executes + atomically places the protective stop', async () => {
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.fired).toBe(true);
    expect(executeIntent).toHaveBeenCalledTimes(1);
    // No target → a stop (not a bracket); long stop ~1920 (2000*(1-0.04)), size from the fill.
    expect(placeStopOnHl).toHaveBeenCalledWith('ETH', expect.closeTo(1920, 1), 0.625, 'long');
    expect(markFireOutcome).toHaveBeenCalledWith('f1', 'filled');
    expect(setRungStatus).toHaveBeenCalledWith('r1', 'fired');
  });

  it('places a BRACKET when the rung has a target', async () => {
    getLadderWithRungs.mockResolvedValue(ladder({}, [openRung({ targetPx: 2200 })]));
    await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(placeBracketOnHl).toHaveBeenCalledWith('ETH', expect.closeTo(1920, 1), 2200, 0.625, 'long');
  });

  it('FLATTENS on a bracket reject (filled-but-unstopped hard fault)', async () => {
    placeStopOnHl.mockRejectedValue(new Error('HL stop rejected'));
    loadPosition.mockResolvedValue({ coin: 'ETH', side: 'long', sz: 0.625, avgEntryPx: 2000, realizedPnlUsd: 0, feesPaidUsd: 0 });
    const res = await performLadderRungFire({ ladderId: 'L1', rungId: 'r1', now: NOW });
    expect(res.flattened).toBe(true);
    expect(res.fired).toBe(false);
    // Two executeIntent calls: the open, then the reduce-only flatten.
    expect(executeIntent).toHaveBeenCalledTimes(2);
    expect(markFireOutcome).toHaveBeenCalledWith('f1', 'flattened', expect.stringContaining('bracket-reject'));
    expect(setRungStatus).toHaveBeenCalledWith('r1', 'failed');
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
