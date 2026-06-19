import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Position } from '@/types/position';
import type { CanonicalFill } from '@/types/fill';

// --- Mocks for every I/O dependency; the pure decision/intent logic stays real ---
const loadPosition = vi.fn();
const executeIntent = vi.fn();
const assessHealth = vi.fn();
const fetchAllMids = vi.fn();
const fetchClearinghouseState = vi.fn();
const getTradingMode = vi.fn();
const writeAnalysisLog = vi.fn();
const acquireExitLock = vi.fn();
const releaseExitLock = vi.fn();
const loadAutoExitConfig = vi.fn();
const getHlAccountAddress = vi.fn();

vi.mock('@/lib/cockpit/fill-persistence-service', () => ({ loadPosition: (...a: unknown[]) => loadPosition(...a) }));
vi.mock('@/lib/trading/fill-source', () => ({ executeIntent: (...a: unknown[]) => executeIntent(...a) }));
vi.mock('@/lib/health/health-engine', () => ({ assessHealth: (...a: unknown[]) => assessHealth(...a) }));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({
  fetchAllMids: (...a: unknown[]) => fetchAllMids(...a),
  fetchClearinghouseState: (...a: unknown[]) => fetchClearinghouseState(...a),
}));
vi.mock('@/lib/env/mode', () => ({ getTradingMode: () => getTradingMode() }));
vi.mock('@/lib/env/env', () => ({ validateEnv: () => ({ HL_NETWORK: 'mainnet' }) }));
vi.mock('@/lib/cockpit/analysis-log-service', () => ({ writeAnalysisLog: (...a: unknown[]) => writeAnalysisLog(...a) }));
vi.mock('@/lib/auto-exit/auto-exit-config', () => ({
  loadAutoExitConfig: () => loadAutoExitConfig(),
  getHlAccountAddress: () => getHlAccountAddress(),
}));
vi.mock('@/lib/auto-exit/auto-exit-lock-service', () => ({
  acquireExitLock: (...a: unknown[]) => acquireExitLock(...a),
  releaseExitLock: (...a: unknown[]) => releaseExitLock(...a),
}));

import { performRiskExit } from '@/lib/trading/risk-exit-service';

const LONG: Position = { coin: 'ETH', side: 'long', sz: 1, avgEntryPx: 1000, realizedPnlUsd: 0, feesPaidUsd: 0 };

const CONFIG = {
  liqProximityPct: 0.03,
  maxLossUsd: 40,
  maxLossPctOfMargin: 0.6,
  minHealthScore: 15,
  hardExitAlerts: ['regime-flip-8h'],
  cooldownMs: 120_000,
  lockTtlMs: 120_000,
};

function fullFill(over: Partial<CanonicalFill> = {}): CanonicalFill {
  return {
    clientIntentId: 'ci', sessionId: 's1', coin: 'ETH', side: 'sell', px: 950, sz: 1, notionalUsd: 950,
    feeUsd: 0.4, reduceOnly: true, partial: false, source: 'paper', hlOrderId: null, hlRaw: null, filledAt: 1,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getTradingMode.mockReturnValue('paper'); // no clearinghouse path
  getHlAccountAddress.mockReturnValue(undefined);
  loadAutoExitConfig.mockReturnValue(CONFIG);
  assessHealth.mockResolvedValue({ score: 80, pContinuation: 0.6, pAdverse: 0.2, alerts: [] });
  fetchAllMids.mockResolvedValue({ ETH: 950 });
  acquireExitLock.mockResolvedValue({ id: 'lock1', sessionId: 's1', coin: 'ETH', expiresAt: 999 });
  releaseExitLock.mockResolvedValue(undefined);
  writeAnalysisLog.mockResolvedValue(undefined);
});

describe('performRiskExit', () => {
  it('fires a reduce-only close when a trigger is met (max-loss-usd: -$50)', async () => {
    loadPosition.mockResolvedValue(LONG); // mark 950 → uPnL -50 ≤ -40
    executeIntent.mockResolvedValue(fullFill());
    const r = await performRiskExit({ sessionId: 's1', coin: 'ETH', now: 1 });
    expect(r.fired).toBe(true);
    expect(r.reason).toMatch(/max-loss-usd/);
    expect(executeIntent).toHaveBeenCalledTimes(1);
    const intent = executeIntent.mock.calls[0][0];
    expect(intent.reduceOnly).toBe(true);
    expect(intent.side).toBe('sell'); // closes a long
    expect(releaseExitLock).not.toHaveBeenCalled(); // clean full close keeps the lock (cooldown)
  });

  it('skips a flat position without touching execution', async () => {
    loadPosition.mockResolvedValue({ ...LONG, side: 'flat', sz: 0 });
    const r = await performRiskExit({ sessionId: 's1', coin: 'ETH', now: 1 });
    expect(r).toMatchObject({ fired: false, skipped: 'flat' });
    expect(acquireExitLock).not.toHaveBeenCalled();
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('does not fire when no trigger is met', async () => {
    loadPosition.mockResolvedValue(LONG);
    fetchAllMids.mockResolvedValue({ ETH: 1000 }); // uPnL 0
    const r = await performRiskExit({ sessionId: 's1', coin: 'ETH', now: 1 });
    expect(r.fired).toBe(false);
    expect(r.skipped).toBe('condition-not-met');
    expect(acquireExitLock).not.toHaveBeenCalled();
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('backs off when the lock is held (no double close)', async () => {
    loadPosition.mockResolvedValue(LONG);
    acquireExitLock.mockResolvedValue(null); // someone else holds it
    const r = await performRiskExit({ sessionId: 's1', coin: 'ETH', now: 1 });
    expect(r.fired).toBe(false);
    expect(r.skipped).toBe('locked');
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('releases the lock + alerts loudly when the close throws, then rethrows', async () => {
    loadPosition.mockResolvedValue(LONG);
    executeIntent.mockRejectedValue(new Error('HL rejected'));
    await expect(performRiskExit({ sessionId: 's1', coin: 'ETH', now: 1 })).rejects.toThrow(/HL rejected/);
    expect(releaseExitLock).toHaveBeenCalledWith('lock1', 'failed');
    const alerted = writeAnalysisLog.mock.calls.some(
      (c) => (c[0] as { severity?: string; message?: string }).severity === 'danger' &&
        /AUTO-EXIT FAILED/.test((c[0] as { message: string }).message),
    );
    expect(alerted).toBe(true);
  });

  it('bad mark skips the cycle and flags degraded', async () => {
    loadPosition.mockResolvedValue(LONG);
    fetchAllMids.mockResolvedValue({ ETH: Number.NaN });
    const r = await performRiskExit({ sessionId: 's1', coin: 'ETH', now: 1 });
    expect(r).toMatchObject({ fired: false, skipped: 'bad-mark', dataDegraded: true });
    expect(executeIntent).not.toHaveBeenCalled();
  });
});
