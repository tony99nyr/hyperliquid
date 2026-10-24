import { expect, it, vi } from 'vitest';

const from = vi.fn();
const computeScoutLaneCards = vi.fn();
vi.mock('@/lib/cockpit/supabase-server', () => ({ getServiceRoleClient: () => ({ from }) }));
vi.mock('@/lib/scout/lane-scorecard-service', () => ({ computeScoutLaneCards: (...args: unknown[]) => computeScoutLaneCards(...args) }));

import { getLanePerformanceReport } from '@/lib/performance/lane-performance-service';

it('returns the report with notes when optional marker and snapshot tables are absent', async () => {
  computeScoutLaneCards.mockResolvedValue({ lanes: [] });
  from.mockImplementation((table: string) => {
    const query = {
      select: () => query,
      order: () => query,
      range: async () => ['change_markers', 'forecast_snapshots'].includes(table)
        ? { data: null, error: { code: '42P01', message: 'missing relation' } }
        : { data: [], error: null },
    };
    return query;
  });
  const report = await getLanePerformanceReport();
  expect(report.markers).toEqual([]);
  expect(report.snapshots).toEqual([]);
  expect(report.notes).toEqual([
    'change_markers table is unavailable; apply migration 0046.',
    'forecast_snapshots table is unavailable; apply migration 0046.',
  ]);
});

it('uses live scout verdicts and flags stale persisted verdicts', async () => {
  computeScoutLaneCards.mockResolvedValue({ lanes: [
    { lane: 'compression-straddle', kind: 'positions', verdict: 'kill', tradeCount: 7 },
    { lane: 'directional', kind: 'positions', verdict: 'kill', tradeCount: 6 },
  ] });
  from.mockImplementation((table: string) => {
    const query = {
      select: () => query, order: () => query,
      range: async () => ({ data: table === 'hypotheses' ? [
        { id: 'h1', lane: 'compression-straddle', realized_r: -0.1, realized_pnl_usd: -12.34,
          resolved_at: '2026-10-20T00:00:00Z', excluded: false, status: 'invalidated' },
        { id: 'h2', lane: 'directional', realized_r: -0.1, realized_pnl_usd: -1,
          resolved_at: '2026-10-20T00:00:00Z', excluded: false, status: 'invalidated' },
      ] : table === 'lane_scorecards' ? [
        { lane: 'compression-straddle', kind: 'positions', verdict: 'continue', trade_count: 7,
          updated_at: '2026-10-19T00:00:00Z' },
      ] : [], error: null }),
    };
    return query;
  });
  const report = await getLanePerformanceReport();
  const compression = report.lanes.find((lane) => lane.id === 'compression-straddle');
  expect(compression?.verdict).toBe('KILL');
  expect(compression?.persistedVerdict).toEqual({ verdict: 'CONTINUE', updatedAt: '2026-10-19T00:00:00Z' });
  expect(report.notes.join(' ')).toMatch(/compression-straddle.*live KILL.*persisted CONTINUE/);
  expect(report.lanes.find((lane) => lane.id === 'directional')?.bar.source).toBe('unregistered');
});

it('falls back to persisted scout verdicts when live scoring fails', async () => {
  computeScoutLaneCards.mockRejectedValue(new Error('positions query failed'));
  from.mockImplementation((table: string) => {
    const query = {
      select: () => query, order: () => query,
      range: async () => ({ data: table === 'hypotheses' ? [
        { id: 'h1', lane: 'compression-straddle', realized_r: -0.1, realized_pnl_usd: -1,
          resolved_at: '2026-10-20T00:00:00Z', excluded: false, status: 'invalidated' },
      ] : table === 'lane_scorecards' ? [
        { lane: 'compression-straddle', kind: 'positions', verdict: 'continue', trade_count: 7,
          updated_at: '2026-10-19T00:00:00Z' },
      ] : [], error: null }),
    };
    return query;
  });
  const report = await getLanePerformanceReport();
  expect(report.lanes.find((lane) => lane.id === 'compression-straddle')?.verdict).toBe('CONTINUE');
  expect(report.notes.join(' ')).toMatch(/Live scout scorecard failed.*persisted.*positions query failed/);
});
