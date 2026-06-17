/**
 * Pins the run-session ENTRY-CHAIN orchestration with every I/O dependency
 * mocked. The two load-bearing assertions:
 *   - APPROVED path: openSession → analyze → requireApproval(true) → executeIntent
 *     → ensureWatchDaemon → upsertSafeExitPlan, in order; outcome 'live'.
 *   - REJECTED path (NO-AUTO-FIRE): requireApproval(false) ⇒ NO executeIntent, NO
 *     watch spawn, NO Safe-Exit arm; outcome 'aborted'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runSessionEntryChain,
  resolveEntrySide,
  type RunSessionDeps,
  type RunSessionPick,
} from '@/lib/cockpit/run-session-service';
import type { CanonicalFill, TradeIntent } from '@/types/fill';
import type { Position } from '@/types/position';
import type { OpenProposal } from '@/lib/skills/open-position-business-logic';

const intent: TradeIntent = {
  clientIntentId: 'cid-entry',
  sessionId: 'sess-1',
  coin: 'ETH',
  side: 'buy',
  sz: 1,
  reduceOnly: false,
  createdAt: 1_000,
};

const proposal: OpenProposal = {
  intent,
  stopPx: 1900,
  notionalUsd: 2000,
  dollarRisk: 100,
  rationale: 'LONG 1 ETH @ ~$2000',
  warnings: [],
};

const fill: CanonicalFill = {
  clientIntentId: 'cid-entry',
  sessionId: 'sess-1',
  coin: 'ETH',
  side: 'buy',
  px: 2000,
  sz: 1,
  notionalUsd: 2000,
  feeUsd: 0.7,
  reduceOnly: false,
  partial: false,
  source: 'paper',
  hlOrderId: null,
  hlRaw: null,
  filledAt: 1_000,
};

const openPosition: Position = {
  coin: 'ETH',
  side: 'long',
  sz: 1,
  avgEntryPx: 2000,
  realizedPnlUsd: 0,
  feesPaidUsd: 0.7,
};

function makeDeps(over: Partial<RunSessionDeps> = {}): RunSessionDeps {
  return {
    mode: 'paper',
    now: () => 1_000,
    newId: () => 'cid-entry',
    openSession: vi.fn().mockResolvedValue({ id: 'sess-1', createdAt: 0, status: 'active', mode: 'paper', title: 'ETH', leaderAddress: null }),
    fetchMark: vi.fn().mockResolvedValue(2000),
    analyzeMarket: vi.fn().mockResolvedValue({ coin: 'ETH', reads: [], bias: 0.5, biasLabel: 'bullish', aligned: true, summary: 'ETH: bullish bias +0.50' }),
    buildEntryProposal: vi.fn().mockReturnValue(proposal),
    requireApproval: vi.fn().mockResolvedValue(true),
    executeIntent: vi.fn().mockResolvedValue(fill),
    writeHypothesis: vi.fn().mockResolvedValue({ id: 'hyp-1' }),
    ensureWatchDaemon: vi.fn().mockReturnValue({ status: 'spawned', pid: 4242 }),
    loadPosition: vi.fn().mockResolvedValue(openPosition),
    fetchL2Book: vi.fn().mockResolvedValue({ coin: 'ETH', bids: [{ px: 1999, sz: 100 }], asks: [{ px: 2001, sz: 100 }] }),
    assessHealth: vi.fn().mockResolvedValue({ score: 80, pContinuation: 0.6, pAdverse: 0.1, alerts: [], timeframeReads: [] }),
    buildBestExitPlan: vi.fn().mockReturnValue({ intent: { ...intent, side: 'sell', reduceOnly: true, limitPx: 1999 }, style: 'limit', reasoning: 'LIMIT close', isFallback: false }),
    upsertSafeExitPlan: vi.fn().mockResolvedValue({}),
    log: vi.fn(),
    ...over,
  };
}

const pick: RunSessionPick = {
  coin: 'ETH',
  side: 'buy',
  riskUsd: 100,
  stopDistanceFrac: 0.05,
  thesis: 'reclaim of the range high',
};

describe('resolveEntrySide', () => {
  it('explicit user side wins', () => {
    expect(resolveEntrySide({ side: 'sell' }, { biasLabel: 'bullish' })).toBe('sell');
  });
  it('falls back to the market read when no side is given', () => {
    expect(resolveEntrySide({}, { biasLabel: 'bullish' })).toBe('buy');
    expect(resolveEntrySide({}, { biasLabel: 'bearish' })).toBe('sell');
  });
  it('neutral read + no explicit side ⇒ null (user must decide)', () => {
    expect(resolveEntrySide({}, { biasLabel: 'neutral' })).toBeNull();
  });
});

describe('runSessionEntryChain — APPROVED', () => {
  let deps: RunSessionDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('chains open → analyze → approval(true) → execute → watch → arm Safe-Exit; outcome live', async () => {
    const result = await runSessionEntryChain(pick, deps);

    expect(result.outcome).toBe('live');
    expect(result.sessionId).toBe('sess-1');
    expect(result.fill).toEqual(fill);
    expect(result.watch).toEqual({ status: 'spawned', pid: 4242 });
    expect(result.safeExitArmed).toBe(true);

    expect(deps.openSession).toHaveBeenCalledTimes(1);
    expect(deps.analyzeMarket).toHaveBeenCalledWith('ETH', 'sess-1');
    expect(deps.requireApproval).toHaveBeenCalledTimes(1);
    expect(deps.executeIntent).toHaveBeenCalledTimes(1);
    expect(deps.executeIntent).toHaveBeenCalledWith(intent);
    expect(deps.ensureWatchDaemon).toHaveBeenCalledTimes(1);
    expect(deps.upsertSafeExitPlan).toHaveBeenCalledTimes(1);
    // The armed plan must be reduce-only (the smart Safe-Exit).
    const armedIntent = (deps.upsertSafeExitPlan as ReturnType<typeof vi.fn>).mock.calls[0][1] as TradeIntent;
    expect(armedIntent.reduceOnly).toBe(true);
  });

  it('approval is requested BEFORE any execution (gate ordering)', async () => {
    const order: string[] = [];
    deps = makeDeps({
      requireApproval: vi.fn().mockImplementation(async () => {
        order.push('approval');
        return true;
      }),
      executeIntent: vi.fn().mockImplementation(async () => {
        order.push('execute');
        return fill;
      }),
    });
    await runSessionEntryChain(pick, deps);
    expect(order).toEqual(['approval', 'execute']);
  });
});

describe('runSessionEntryChain — REJECTED (no-auto-fire)', () => {
  it('approval(false) ⇒ NO execute, NO watch spawn, NO Safe-Exit arm; outcome aborted', async () => {
    const deps = makeDeps({ requireApproval: vi.fn().mockResolvedValue(false) });
    const result = await runSessionEntryChain(pick, deps);

    expect(result.outcome).toBe('aborted');
    expect(result.fill).toBeNull();
    expect(result.watch).toBeNull();
    expect(result.safeExitArmed).toBe(false);

    expect(deps.requireApproval).toHaveBeenCalledTimes(1);
    expect(deps.executeIntent).not.toHaveBeenCalled();
    expect(deps.ensureWatchDaemon).not.toHaveBeenCalled();
    expect(deps.upsertSafeExitPlan).not.toHaveBeenCalled();
    expect(deps.writeHypothesis).not.toHaveBeenCalled();
  });

  it('ZERO-FILL after approval ⇒ no hypothesis, no watch, no Safe-Exit; outcome no-fill (FIX 1)', async () => {
    // executeIntent returns an empty fill (sz 0) — empty book or a limit that
    // never crossed. The chain must NOT report a live session.
    const emptyFill: CanonicalFill = { ...fill, sz: 0, px: 0, notionalUsd: 0, feeUsd: 0, partial: false };
    const deps = makeDeps({ executeIntent: vi.fn().mockResolvedValue(emptyFill) });
    const result = await runSessionEntryChain(pick, deps);

    expect(result.outcome).toBe('no-fill');
    expect(result.fill).toEqual(emptyFill);
    expect(result.watch).toBeNull();
    expect(result.safeExitArmed).toBe(false);

    // Execution WAS attempted (approval was granted)...
    expect(deps.requireApproval).toHaveBeenCalledTimes(1);
    expect(deps.executeIntent).toHaveBeenCalledTimes(1);
    // ...but nothing downstream of a real fill happened.
    expect(deps.writeHypothesis).not.toHaveBeenCalled();
    expect(deps.ensureWatchDaemon).not.toHaveBeenCalled();
    expect(deps.upsertSafeExitPlan).not.toHaveBeenCalled();
    expect(deps.loadPosition).not.toHaveBeenCalled();
  });

  it('a neutral read with no explicit side aborts BEFORE proposing or approving', async () => {
    const deps = makeDeps({
      analyzeMarket: vi.fn().mockResolvedValue({ coin: 'ETH', reads: [], bias: 0, biasLabel: 'neutral', aligned: false, summary: 'neutral' }),
    });
    const result = await runSessionEntryChain({ ...pick, side: undefined }, deps);
    expect(result.outcome).toBe('aborted');
    expect(deps.buildEntryProposal).not.toHaveBeenCalled();
    expect(deps.requireApproval).not.toHaveBeenCalled();
    expect(deps.executeIntent).not.toHaveBeenCalled();
  });

  it('a proposal with warnings aborts BEFORE approval (refuse to propose)', async () => {
    const deps = makeDeps({
      buildEntryProposal: vi.fn().mockReturnValue({ ...proposal, warnings: ['riskUsd must be positive.'] }),
    });
    const result = await runSessionEntryChain(pick, deps);
    expect(result.outcome).toBe('aborted');
    expect(deps.requireApproval).not.toHaveBeenCalled();
    expect(deps.executeIntent).not.toHaveBeenCalled();
  });
});
