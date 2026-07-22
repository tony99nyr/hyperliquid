import { describe, it, expect } from 'vitest';
import {
  classifyContextZone,
  buildSessionRow,
  buildAnalysisLogRow,
  buildHypothesisRow,
  buildHealthSnapshotRow,
  buildContextGaugeRow,
  buildFillRow,
  buildPositionRow,
  buildPnlRow,
  positionFromRow,
} from '@/lib/cockpit/cockpit-rows-business-logic';
import type { CanonicalFill } from '@/types/fill';
import type { Position } from '@/types/position';

describe('classifyContextZone (PURE: ok<60≤warn<85≤critical)', () => {
  it('classifies ok below 60', () => {
    expect(classifyContextZone(0)).toBe('ok');
    expect(classifyContextZone(59.9)).toBe('ok');
  });
  it('classifies warn in [60, 85)', () => {
    expect(classifyContextZone(60)).toBe('warn');
    expect(classifyContextZone(84.9)).toBe('warn');
  });
  it('classifies critical at/above 85', () => {
    expect(classifyContextZone(85)).toBe('critical');
    expect(classifyContextZone(100)).toBe('critical');
  });
  it('clamps out-of-range input before classifying', () => {
    expect(classifyContextZone(-10)).toBe('ok');
    expect(classifyContextZone(150)).toBe('critical');
  });
});

describe('insert-row builders (camelCase → snake_case)', () => {
  it('buildSessionRow applies defaults', () => {
    expect(buildSessionRow({ mode: 'paper' })).toEqual({
      status: 'active',
      mode: 'paper',
      title: null,
      leader_address: null,
    });
  });

  it('buildSessionRow maps leaderAddress', () => {
    const row = buildSessionRow({ mode: 'live', title: 'BTC follow', leaderAddress: '0xabc' });
    expect(row.leader_address).toBe('0xabc');
    expect(row.mode).toBe('live');
  });

  it('buildAnalysisLogRow defaults severity to info', () => {
    expect(buildAnalysisLogRow({ sessionId: 's1', source: 'analyze-market', message: 'hi' })).toEqual({
      session_id: 's1',
      source: 'analyze-market',
      severity: 'info',
      message: 'hi',
    });
  });

  it('buildHypothesisRow defaults status to open', () => {
    expect(buildHypothesisRow({ sessionId: 's1', statement: 'ETH breaks 3k' })).toEqual({
      session_id: 's1',
      statement: 'ETH breaks 3k',
      status: 'open',
    });
  });

  it('buildHypothesisRow attaches lane only when a non-empty string is given', () => {
    expect(buildHypothesisRow({ sessionId: 's1', statement: 'x', lane: 'carry' }).lane).toBe('carry');
    expect(buildHypothesisRow({ sessionId: 's1', statement: 'x', lane: '  vault ' }).lane).toBe('vault'); // trimmed
    expect('lane' in buildHypothesisRow({ sessionId: 's1', statement: 'x' })).toBe(false);
    expect('lane' in buildHypothesisRow({ sessionId: 's1', statement: 'x', lane: '' })).toBe(false);
  });

  it('buildHypothesisRow attaches coin uppercased only when non-empty (the by-coin resolution key)', () => {
    expect(buildHypothesisRow({ sessionId: 's1', statement: 'x', coin: 'sol' }).coin).toBe('SOL');
    expect('coin' in buildHypothesisRow({ sessionId: 's1', statement: 'x' })).toBe(false);
    expect('coin' in buildHypothesisRow({ sessionId: 's1', statement: 'x', coin: '  ' })).toBe(false);
  });

  it('buildHealthSnapshotRow maps probs + alerts', () => {
    expect(
      buildHealthSnapshotRow({
        sessionId: 's1',
        coin: 'ETH',
        score: 72,
        pContinuation: 0.6,
        pAdverse: 0.3,
        alerts: ['regime-flip-8h'],
      }),
    ).toEqual({
      session_id: 's1',
      coin: 'ETH',
      score: 72,
      p_continuation: 0.6,
      p_adverse: 0.3,
      alerts: ['regime-flip-8h'],
    });
  });

  it('buildContextGaugeRow derives the zone', () => {
    expect(buildContextGaugeRow({ sessionId: 's1', approxPct: 90 })).toEqual({
      session_id: 's1',
      approx_pct: 90,
      zone: 'critical',
    });
  });
});

const fill: CanonicalFill = {
  clientIntentId: 'ci-1',
  sessionId: 's1',
  coin: 'ETH',
  side: 'buy',
  px: 2000,
  sz: 1.5,
  notionalUsd: 3000,
  feeUsd: 1.2,
  reduceOnly: false,
  partial: false,
  source: 'paper',
  hlOrderId: null,
  hlRaw: null,
  filledAt: 1_700_000_000_000,
};

describe('fill / position / pnl rows', () => {
  it('buildFillRow maps the canonical fill to DB columns', () => {
    expect(buildFillRow(fill)).toEqual({
      session_id: 's1',
      client_intent_id: 'ci-1',
      coin: 'ETH',
      side: 'buy',
      px: 2000,
      sz: 1.5,
      notional_usd: 3000,
      fee_usd: 1.2,
      reduce_only: false,
      partial: false,
      source: 'paper',
      filled_at: new Date(1700000000000).toISOString(),
      hl_order_id: null,
      hl_raw: null,
    });
  });

  it('buildPositionRow includes updated_at + unique key columns', () => {
    const pos: Position = {
      coin: 'ETH',
      side: 'long',
      sz: 1.5,
      avgEntryPx: 2000,
      realizedPnlUsd: 0,
      feesPaidUsd: 1.2,
    };
    const row = buildPositionRow('s1', pos, '2026-01-01T00:00:00.000Z');
    expect(row).toEqual({
      session_id: 's1',
      coin: 'ETH',
      side: 'long',
      sz: 1.5,
      avg_entry_px: 2000,
      realized_pnl_usd: 0,
      fees_paid_usd: 1.2,
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    // No leverage arg → column omitted (won't clobber a stored value on upsert).
    expect('leverage' in row).toBe(false);
  });

  it('buildPositionRow attaches leverage only when a positive finite value is given', () => {
    const pos: Position = { coin: 'ETH', side: 'long', sz: 1, avgEntryPx: 2000, realizedPnlUsd: 0, feesPaidUsd: 0 };
    const iso = '2026-01-01T00:00:00.000Z';
    expect(buildPositionRow('s1', pos, iso, 5).leverage).toBe(5);
    // Bogus / absent values leave the column out entirely.
    expect('leverage' in buildPositionRow('s1', pos, iso, null)).toBe(false);
    expect('leverage' in buildPositionRow('s1', pos, iso, 0)).toBe(false);
    expect('leverage' in buildPositionRow('s1', pos, iso, NaN)).toBe(false);
  });

  it('buildPositionRow attaches lane only when a non-empty string is given (else omitted → preserved on re-fold)', () => {
    const pos: Position = { coin: 'ETH', side: 'long', sz: 1, avgEntryPx: 2000, realizedPnlUsd: 0, feesPaidUsd: 0 };
    const iso = '2026-01-01T00:00:00.000Z';
    expect(buildPositionRow('s1', pos, iso, undefined, undefined, 'vault').lane).toBe('vault');
    expect(buildPositionRow('s1', pos, iso, 5, iso, '  carry  ').lane).toBe('carry'); // trimmed
    // Absent / null / empty leave the column out entirely (don't clobber stored lane).
    expect('lane' in buildPositionRow('s1', pos, iso)).toBe(false);
    expect('lane' in buildPositionRow('s1', pos, iso, undefined, undefined, null)).toBe(false);
    expect('lane' in buildPositionRow('s1', pos, iso, undefined, undefined, '')).toBe(false);
    expect('lane' in buildPositionRow('s1', pos, iso, undefined, undefined, '   ')).toBe(false);
  });

  it('buildPnlRow defaults unrealized to 0 + mark to null', () => {
    const pos: Position = {
      coin: 'ETH',
      side: 'flat',
      sz: 0,
      avgEntryPx: 0,
      realizedPnlUsd: 50,
      feesPaidUsd: 2,
    };
    expect(buildPnlRow('s1', pos)).toEqual({
      session_id: 's1',
      coin: 'ETH',
      realized_pnl_usd: 50,
      unrealized_pnl_usd: 0,
      fees_paid_usd: 2,
      mark_px: null,
    });
  });

  it('positionFromRow round-trips a DB row to a domain Position', () => {
    const pos = positionFromRow({
      coin: 'ETH',
      side: 'short',
      sz: 2,
      avg_entry_px: 1900,
      realized_pnl_usd: 10,
      fees_paid_usd: 3,
    });
    expect(pos).toEqual({
      coin: 'ETH',
      side: 'short',
      sz: 2,
      avgEntryPx: 1900,
      realizedPnlUsd: 10,
      feesPaidUsd: 3,
    });
  });
});
