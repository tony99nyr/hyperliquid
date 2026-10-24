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
