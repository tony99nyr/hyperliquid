/**
 * Pins the PURE opportunity-view helpers: card grouping, the calm NO-EDGE badge,
 * pillar segments, integer confidence dots, staleness, no-false-precision score
 * formatting, and whale-posture summarization.
 */

import { describe, it, expect } from 'vitest';
import type { RubricScoreUiRow, LeaderPositionRow, LeaderActionRow } from '@/hooks/realtime-row-mappers';
import { GH } from '@/app/cockpit/components/panel-styles';
import {
  toCardModels, badgeMeta, pillarSegments, confidenceDots, isStale, formatScore, summarizeWhalePosture,
} from '@/app/cockpit/components/opportunity/opportunity-helpers';

function row(coin: string, side: 'long' | 'short', over: Partial<RubricScoreUiRow> = {}): RubricScoreUiRow {
  return {
    id: `${coin}:${side}`, coin, side, opportunity: 30, pillarRegime: 50, pillarLeaders: 50, pillarCarry: 50,
    pillarMicro: 50, regimeMultiplier: 0.5, badge: 'NO-EDGE', chosenSide: 'none', noTradeReason: 'below-bar',
    entryLow: 99, entryHigh: 101, invalidation: 95, target: 110, triggerPx: 100, roomToTarget: 3,
    confidence: 0.2, scoreBandLow: 20, scoreBandHigh: 40, killedBy: null, computedAt: 1000, ...over,
  };
}

describe('toCardModels', () => {
  it('groups rows into one card per coin, picking the chosen side to display', () => {
    // Both sides of a coin carry the same result-level badge/chosenSide (the writer
    // sets result.badge on both rows); they differ only in per-side opportunity.
    const go = { badge: 'GO' as const, chosenSide: 'short' as const, noTradeReason: null };
    const rows = [
      row('ETH', 'long', { opportunity: 20, ...go }),
      row('ETH', 'short', { opportunity: 75, ...go }),
    ];
    const [m] = toCardModels(rows, ['ETH']);
    expect(m.coin).toBe('ETH');
    expect(m.badge).toBe('GO');
    expect(m.display.side).toBe('short'); // chosen side displayed
    expect(m.display.opportunity).toBe(75);
  });
  it('falls back to the higher-opportunity side when chosen is none', () => {
    const [m] = toCardModels([row('BTC', 'long', { opportunity: 18 }), row('BTC', 'short', { opportunity: 29 })], ['BTC']);
    expect(m.display.side).toBe('short');
  });
  it('keeps the NEWEST row per coin×side when history accumulates', () => {
    const old = row('ETH', 'short', { opportunity: 10, computedAt: 1000 });
    const fresh = row('ETH', 'short', { opportunity: 88, computedAt: 9000 });
    // newest-first AND oldest-first input orders must both yield the fresh read.
    expect(toCardModels([fresh, old], ['ETH'])[0].display.opportunity).toBe(88);
    expect(toCardModels([old, fresh], ['ETH'])[0].display.opportunity).toBe(88);
  });

  it('orders by the supplied universe order', () => {
    const rows = [row('SOL', 'long'), row('ETH', 'long'), row('BTC', 'long')];
    expect(toCardModels(rows, ['ETH', 'BTC', 'SOL']).map((m) => m.coin)).toEqual(['ETH', 'BTC', 'SOL']);
  });
});

describe('badge / pillars / confidence / score', () => {
  it('NO-EDGE badge is CALM (muted color, not danger)', () => {
    const b = badgeMeta('NO-EDGE');
    expect(b.muted).toBe(true);
    expect(b.color).toBe(GH.textMuted);
    expect(badgeMeta('GO').muted).toBe(false);
  });
  it('pillarSegments returns the 4 pillars colored by value', () => {
    const segs = pillarSegments(row('ETH', 'short', { pillarRegime: 80, pillarLeaders: 20 }));
    expect(segs.map((s) => s.key)).toEqual(['regime', 'leaders', 'carry', 'micro']);
    expect(segs[0].value).toBe(80);
  });
  it('confidenceDots is an integer 0–5', () => {
    expect(confidenceDots(0)).toBe(0);
    expect(confidenceDots(1)).toBe(5);
    expect(confidenceDots(0.5)).toBe(3);
  });
  it('formatScore is integer + a ± band (no decimals)', () => {
    const f = formatScore(74, 62, 86);
    expect(f.score).toBe('74');
    expect(f.band).toBe('±12');
    expect(formatScore(50, 50, 50).band).toBe('');
  });
});

describe('isStale', () => {
  it('flags data older than the ttl', () => {
    expect(isStale(0, 30 * 60 * 1000)).toBe(true);
    expect(isStale(0, 60 * 1000)).toBe(false);
  });
});

describe('summarizeWhalePosture', () => {
  const pos = (coin: string, side: 'long' | 'short', pv: number): LeaderPositionRow => ({
    id: `x:${coin}`, leaderAddress: '0xabc', coin, side, szi: 0, size: 0, entryPx: null, positionValue: pv,
    unrealizedPnl: 0, returnOnEquity: null, leverage: null, leverageType: null, liquidationPx: null,
    accountValueUsd: null, fetchedAt: 0, updatedAt: 0,
  });
  const act = (coin: string, kind: LeaderActionRow['kind']): LeaderActionRow => ({
    id: Math.random().toString(), leaderAddress: '0xabc', coin, kind, prevSide: null, newSide: null,
    prevSize: 0, newSize: 0, sizeDelta: 0, entryPx: null, notionalUsd: null, unrealizedPnl: null, detectedAt: 0,
  });
  it('nets by notional + counts sides + flags covering', () => {
    const rows = summarizeWhalePosture(
      [pos('ETH', 'short', 46_000_000), pos('ETH', 'short', 2_000_000), pos('ETH', 'long', 1_000_000)],
      [act('ETH', 'reduce'), act('ETH', 'close'), act('ETH', 'open')],
      ['ETH'],
    );
    expect(rows[0].netSide).toBe('short');
    expect(rows[0].shortCount).toBe(2);
    expect(rows[0].longCount).toBe(1);
    expect(rows[0].coveringCount).toBe(2); // reduce + close (not open)
  });
  it('returns a row per requested coin even with no data', () => {
    expect(summarizeWhalePosture([], [], ['ETH', 'BTC']).map((r) => r.coin)).toEqual(['ETH', 'BTC']);
  });
});
