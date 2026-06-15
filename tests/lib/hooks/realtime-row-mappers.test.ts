import { describe, it, expect } from 'vitest';
import {
  mapAnalysisLogRow,
  mapHealthSnapshotRow,
  mapContextGaugeRow,
  mapHypothesisRow,
  mapPnlRow,
  mapPositionRow,
  accumulateById,
  byCreatedAtDesc,
  byCreatedAtAsc,
} from '@/hooks/realtime-row-mappers';

describe('realtime-row-mappers', () => {
  it('maps an analysis_log row (ISO time → ms, default severity)', () => {
    const e = mapAnalysisLogRow({
      id: 'a1',
      session_id: 's1',
      created_at: '2026-01-01T00:00:00.000Z',
      source: 'analyze-market-timeframes',
      message: 'hello',
    });
    expect(e.id).toBe('a1');
    expect(e.sessionId).toBe('s1');
    expect(e.createdAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(e.severity).toBe('info');
    expect(e.source).toBe('analyze-market-timeframes');
  });

  it('maps a health_snapshots row including the alerts array', () => {
    const h = mapHealthSnapshotRow({
      id: 'h1',
      session_id: 's1',
      created_at: '2026-01-01T00:00:00.000Z',
      score: 42,
      p_continuation: 0.4,
      p_adverse: 0.5,
      alerts: ['bearish-divergence-1h', 'stop-within-1-ATR'],
    });
    expect(h.score).toBe(42);
    expect(h.pContinuation).toBe(0.4);
    expect(h.pAdverse).toBe(0.5);
    expect(h.alerts).toEqual(['bearish-divergence-1h', 'stop-within-1-ATR']);
  });

  it('defaults alerts to [] when missing/non-array', () => {
    const h = mapHealthSnapshotRow({ id: 'h', session_id: 's', score: 1, p_continuation: 0, p_adverse: 0 });
    expect(h.alerts).toEqual([]);
  });

  it('maps a context_gauge row', () => {
    const c = mapContextGaugeRow({ id: 'c', session_id: 's', approx_pct: 72, zone: 'warn' });
    expect(c.approxPct).toBe(72);
    expect(c.zone).toBe('warn');
  });

  it('maps a hypothesis row (null resolved_at → null)', () => {
    const h = mapHypothesisRow({
      id: 'hy',
      session_id: 's',
      statement: 'ETH continues up',
      status: 'open',
      resolved_at: null,
      resolution_note: null,
    });
    expect(h.statement).toBe('ETH continues up');
    expect(h.status).toBe('open');
    expect(h.resolvedAt).toBeNull();
    expect(h.resolutionNote).toBeNull();
  });

  it('maps pnl + position rows', () => {
    const p = mapPnlRow({ id: 'p', session_id: 's', coin: 'ETH', realized_pnl_usd: 10, unrealized_pnl_usd: 5, fees_paid_usd: 1, mark_px: 3000 });
    expect(p.unrealizedPnlUsd).toBe(5);
    expect(p.markPx).toBe(3000);

    const pos = mapPositionRow({ id: 'po', session_id: 's', coin: 'ETH', side: 'long', sz: 2, avg_entry_px: 2900, realized_pnl_usd: 0, fees_paid_usd: 0 });
    expect(pos.side).toBe('long');
    expect(pos.sz).toBe(2);
    expect(pos.avgEntryPx).toBe(2900);
  });

  it('coerces an unknown position side to flat', () => {
    const pos = mapPositionRow({ id: 'x', session_id: 's', coin: 'ETH', side: 'weird' });
    expect(pos.side).toBe('flat');
  });

  describe('accumulateById', () => {
    const mk = (id: string, createdAt: number) => ({ id, createdAt });

    it('appends a new row and sorts (desc)', () => {
      const out = accumulateById([mk('a', 1)], mk('b', 2), byCreatedAtDesc);
      expect(out.map((r) => r.id)).toEqual(['b', 'a']);
    });

    it('replaces a row with the same id (UPDATE)', () => {
      const out = accumulateById([mk('a', 1), mk('b', 2)], { id: 'a', createdAt: 5 }, byCreatedAtDesc);
      expect(out).toHaveLength(2);
      expect(out[0]).toEqual({ id: 'a', createdAt: 5 });
    });

    it('supports ascending order', () => {
      const out = accumulateById([mk('b', 2)], mk('a', 1), byCreatedAtAsc);
      expect(out.map((r) => r.id)).toEqual(['a', 'b']);
    });
  });
});
