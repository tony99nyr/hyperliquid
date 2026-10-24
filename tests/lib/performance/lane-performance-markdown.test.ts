import { expect, it } from 'vitest';
import { renderLanePerformanceMarkdown } from '@/lib/performance/lane-performance-markdown';
import { buildLanePerformanceReport, type ReportInput } from '@/lib/performance/lane-performance-business-logic';

it('renders a concise report without structured JSON in table cells', () => {
  const at = '2026-10-24T00:00:00Z';
  const input: ReportInput = {
    now: at, horizonEnd: '2026-11-23', seed: 17, since: undefined, notes: ['fixture data'],
    ladders: [], rungs: [], hypotheses: [{ id: 'h', lane: 'directional', realized_r: -0.1,
      realized_pnl_usd: -1, resolved_at: at, excluded: false, status: 'invalidated' }],
    scoutCards: [{ lane: 'directional', verdict: 'kill', tradeCount: 6, updatedAt: at }], snapshots: [],
    outcomes: [{ ladder_id: 'a', title: 'Test', setup_type: 'breakout', mode: 'live', outcome: 'won',
      planned_risk_usd: 10, realized_pnl_usd: 5, realized_r: .5, resolved_at: at }],
    markers: [{ id: 'm1', at, kind: 'process', lanes: ['breakout'], title: 'New filter', note: '', source: 'manual',
      ref: null, proposed_by: 'agent', confirmed_by: 'operator', confirmed_at: at, created_at: at },
    { id: 'm2', at, kind: 'process', lanes: ['breakout'], title: 'Candidate', note: '', source: 'manual',
      ref: null, proposed_by: 'agent', confirmed_by: null, confirmed_at: null, created_at: at }],
  };
  const md = renderLanePerformanceMarkdown(buildLanePerformanceReport(input));
  expect(md).toContain('Generated: 2026-10-24T00:00:00Z');
  expect(md).toContain('Notes: fixture data');
  expect(md).toContain('| lane | kind | verdict | persisted verdict (updated at) | n trades | n episodes | net $ | mean R per trade (unit) | progress to bar | ETA |');
  expect(md).toContain('| breakout | live | COLLECT | n/a | 1 | 1 | $5.00 | +0.50 r_slip | 1/10 |');
  expect(md).toContain('| directional | scout | KILL | n/a | 6 | 1 | $-1.00 | -0.10 r | unregistered |');
  expect(md).not.toContain('6/0');
  expect(md).toContain('Per-episode mean R: breakout +0.50 r_slip (n=1)');
  expect(md.indexOf('New filter')).toBeLessThan(md.indexOf('Candidate'));
  expect(md).toContain('P5 / P50 / P95');
  expect(md).toContain('P95 30-day drawdown');
  expect(md).toContain('Realised live net/month (last 90d): $1.67');
  expect(md).toContain('seed 17');
  expect(md).not.toMatch(/\{"(?:value|id|at)"/);
});
