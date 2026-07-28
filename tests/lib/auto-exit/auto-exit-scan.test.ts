import { describe, it, expect, vi, beforeEach } from 'vitest';

const listActiveSessions = vi.fn();
const loadOpenPositions = vi.fn();

vi.mock('@/lib/cockpit/session-service', () => ({ listActiveSessions: (...a: unknown[]) => listActiveSessions(...a) }));
vi.mock('@/lib/cockpit/fill-persistence-service', () => ({ loadOpenPositions: (...a: unknown[]) => loadOpenPositions(...a) }));

import { listExitCandidates } from '@/lib/auto-exit/auto-exit-scan';

beforeEach(() => vi.clearAllMocks());

describe('listExitCandidates', () => {
  it('skips a session whose positions fail to load (fail-soft) and still scans the rest', async () => {
    listActiveSessions.mockResolvedValue([
      { id: 's1', mode: 'live' },
      { id: 's2', mode: 'live' },
    ]);
    loadOpenPositions.mockImplementation(async (id: string) => {
      if (id === 's1') throw new Error('db blip');
      return [{ coin: 'eth', side: 'long', sz: 1 }];
    });
    const out = await listExitCandidates();
    expect(out).toEqual([{ sessionId: 's2', coin: 'ETH' }]); // s1 skipped, coin upper-cased
  });

  it('excludes flat / zero-size positions', async () => {
    listActiveSessions.mockResolvedValue([{ id: 's1', mode: 'live' }]);
    loadOpenPositions.mockResolvedValue([
      { coin: 'ETH', side: 'long', sz: 1 },
      { coin: 'BTC', side: 'flat', sz: 0 },
      { coin: 'SOL', side: 'short', sz: 0 }, // zero size despite a side
    ]);
    const out = await listExitCandidates();
    expect(out).toEqual([{ sessionId: 's1', coin: 'ETH' }]);
  });

  it('EXCLUDES paper (scout) sessions — the live auto-exit must never see a paper position', async () => {
    listActiveSessions.mockResolvedValue([
      { id: 'paper1', mode: 'paper' }, // scout — must be skipped
      { id: 'live1', mode: 'live' },
    ]);
    loadOpenPositions.mockResolvedValue([{ coin: 'SOL', side: 'short', sz: 1.09 }]);
    const out = await listExitCandidates();
    expect(out).toEqual([{ sessionId: 'live1', coin: 'SOL' }]); // paper1's SOL never listed
    expect(loadOpenPositions).not.toHaveBeenCalledWith('paper1'); // not even read
  });

  it('returns empty when there are no active sessions', async () => {
    listActiveSessions.mockResolvedValue([]);
    expect(await listExitCandidates()).toEqual([]);
  });
});
