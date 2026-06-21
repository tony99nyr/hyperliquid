import { describe, it, expect } from 'vitest';
import { summarizeHypotheses, scoutPlaybookPath, type HypothesisSummaryRow } from '@/lib/scout/scout-cycle-business-logic';

function row(over: Partial<HypothesisSummaryRow>): HypothesisSummaryRow {
  return { statement: 's', status: 'open', resolution_note: null, created_at: '2026-06-21T00:00:00Z', resolved_at: null, ...over };
}

describe('summarizeHypotheses', () => {
  it('counts by status and surfaces the latest resolved (non-open) theses', () => {
    const out = summarizeHypotheses([
      row({ statement: 'a', status: 'open' }),
      row({ statement: 'b', status: 'confirmed', resolution_note: 'hit target' }),
      row({ statement: 'c', status: 'invalidated' }),
      row({ statement: 'd', status: 'resolved' }),
    ]);
    expect(out.open).toBe(1);
    expect(out.confirmed).toBe(1);
    expect(out.invalidated).toBe(1);
    expect(out.resolved).toBe(1);
    expect(out.lastResolved.map((h) => h.statement)).toEqual(['b', 'c', 'd']);
    expect(out.lastResolved[0].resolutionNote).toBe('hit target');
  });

  it('caps lastResolved to lastN, newest first (input is newest-first)', () => {
    const rows = Array.from({ length: 8 }, (_, i) => row({ statement: `h${i}`, status: 'resolved' }));
    const out = summarizeHypotheses(rows, 3);
    expect(out.lastResolved.map((h) => h.statement)).toEqual(['h0', 'h1', 'h2']);
  });
});

describe('scoutPlaybookPath', () => {
  it('resolves under docs/scout/playbook.md of the given cwd', () => {
    expect(scoutPlaybookPath('/repo')).toBe('/repo/docs/scout/playbook.md');
  });
});
