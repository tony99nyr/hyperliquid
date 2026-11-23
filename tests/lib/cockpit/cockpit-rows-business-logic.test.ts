import { describe, it, expect } from 'vitest';
import {
  classifyContextZone,
  buildSessionRow,
  buildAnalysisLogRow,
  buildHypothesisRow,
  buildHealthSnapshotRow,
  buildContextGaugeRow,
  buildFillRow,
  buildPositionFoldArgs,
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

  describe('buildPositionFoldArgs', () => {
    const pos: Position = { coin: 'ETH', side: 'long', sz: 1.5, avgEntryPx: 2000, realizedPnlUsd: 3, feesPaidUsd: 1.2 };
    const base = { sessionId: 's1', position: pos, openedAtIso: '2026-01-01T00:00:00.000Z', ledgerFillCount: 4 };

    it('maps the folded position and the ledger count onto the RPC arguments', () => {
      expect(buildPositionFoldArgs(base)).toEqual({
        p_session_id: 's1',
        p_coin: 'ETH',
        p_side: 'long',
        p_sz: 1.5,
        p_avg_entry_px: 2000,
        p_realized_pnl_usd: 3,
        p_fees_paid_usd: 1.2,
        p_opened_at: '2026-01-01T00:00:00.000Z',
        p_leverage: null,
        p_lane: null,
        p_ledger_fill_count: 4,
      });
    });

    it('sends leverage only when it is a positive finite number', () => {
      expect(buildPositionFoldArgs({ ...base, leverage: 5 }).p_leverage).toBe(5);
      for (const leverage of [null, 0, -2, NaN, Infinity]) {
        expect(buildPositionFoldArgs({ ...base, leverage }).p_leverage).toBeNull();
      }
    });

    it('sends lane trimmed, and null for an empty or blank lane', () => {
      expect(buildPositionFoldArgs({ ...base, lane: '  carry  ' }).p_lane).toBe('carry');
      for (const lane of [null, '', '   ']) {
        expect(buildPositionFoldArgs({ ...base, lane }).p_lane).toBeNull();
      }
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
