import { describe, expect, it, vi } from 'vitest';
import { assertHtfEntryAuthority, runDeterministicHtfEntries } from '@/lib/scout/htf-deterministic-entry-service';
import { writeHypothesis } from '@/lib/cockpit/hypothesis-service';
import { createSupabaseMock } from '../../mocks/supabase.mock';
import type { SupabaseClient } from '@supabase/supabase-js';

const breakout = {
  coin: 'ETH', latestClose: 2000, atr: 80, don20High: 1900, don20Low: 1700,
  don10High: 1900, don10Low: 1800,
  breakout: { side: 'long' as const, entryPx: 2000, stopPx: 1840, stopFrac: 0.08, exitPx: 1800 },
};

function deps() {
  return {
    scan: vi.fn().mockResolvedValue({ reads: [breakout], coverage: { requested: 4, scanned: 4, skipped: 0 } }),
    openCoins: vi.fn().mockResolvedValue(new Set<string>()),
    execute: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
    veto: vi.fn().mockResolvedValue(null),
  };
}

describe('deterministic htf-trend entries', () => {
  it('keeps model entries when off and refuses them when daemon-owned', () => {
    expect(() => assertHtfEntryAuthority('htf-trend', false, false)).not.toThrow();
    expect(() => assertHtfEntryAuthority('htf-trend', true, false)).toThrow(/daemon-owned/);
    expect(() => assertHtfEntryAuthority('htf-trend', true, true)).not.toThrow();
  });
  it('flag off leaves the model path unchanged', async () => {
    const d = deps();
    expect(await runDeterministicHtfEntries(false, 'paper', Date.now(), d)).toEqual([]);
    expect(d.scan).not.toHaveBeenCalled();
    expect(d.execute).not.toHaveBeenCalled();
  });

  it('flag on opens from the frozen read without a model call', async () => {
    const d = deps();
    const result = await runDeterministicHtfEntries(true, 'paper', Date.now(), { ...d, veto: undefined });
    expect(result).toEqual([{ coin: 'ETH', outcome: 'opened' }]);
    expect(d.execute).toHaveBeenCalledWith(expect.objectContaining({ coin: 'ETH', side: 'buy', lane: 'htf-trend', setupType: 'donchian-20-10', stopFrac: 0.08 }));
    expect(d.veto).not.toHaveBeenCalled();
  });

  it('records a model veto reason and does not open', async () => {
    const d = deps();
    d.veto.mockResolvedValue('Exchange maintenance');
    expect(await runDeterministicHtfEntries(true, 'paper', Date.now(), d)).toEqual([{ coin: 'ETH', outcome: 'vetoed' }]);
    expect(d.execute).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('Exchange maintenance'));
  });

  it('does not enter a coin that already has a paper position', async () => {
    const d = deps();
    d.openCoins.mockResolvedValue(new Set(['ETH']));
    expect(await runDeterministicHtfEntries(true, 'paper', Date.now(), d)).toEqual([]);
    expect(d.execute).not.toHaveBeenCalled();
  });

  it('refuses live mode before reading or executing', async () => {
    const d = deps();
    await expect(runDeterministicHtfEntries(true, 'live', Date.now(), d)).rejects.toThrow(/PAPER-ONLY/);
    expect(d.scan).not.toHaveBeenCalled();
  });

  it('persists the rule version in the hypotheses ledger', async () => {
    const mock = createSupabaseMock();
    mock.queueResult({ data: {
      id: 'h1', session_id: 's1', created_at: '2026-10-29T00:00:00Z',
      statement: 'breakout', status: 'open', resolved_at: null, resolution_note: null,
    }, error: null });
    await writeHypothesis({ sessionId: 's1', statement: 'breakout', lane: 'htf-trend',
      ruleVersion: 'htf-trend-donchian-20-10-daemon-v1' }, mock.client as unknown as SupabaseClient);
    expect(mock.ops[0].payload).toMatchObject({ rule_version: 'htf-trend-donchian-20-10-daemon-v1' });
  });
});
