import { describe, it, expect } from 'vitest';
import { splitTrend, opportunityFlag, trendLine } from '@/lib/skills/desk-review-business-logic';
import type { TimeframeRead, MarketTimeframe } from '@/lib/skills/analyze-market-business-logic';

const r = (
  timeframe: MarketTimeframe,
  regime: 'bullish' | 'bearish' | 'neutral',
  confidence: number,
  hasData = true,
): TimeframeRead => ({ timeframe, hasData, regime, confidence, rsi: null, atr: null, divergence: null });

describe('splitTrend', () => {
  it('aligned bull: all TFs bullish', () => {
    const s = splitTrend([r('1d', 'bullish', 0.8), r('8h', 'bullish', 0.7), r('1h', 'bullish', 0.6), r('15m', 'bullish', 0.5)]);
    expect(s.longTerm).toBe('bull');
    expect(s.shortTerm).toBe('bull');
    expect(s.aligned).toBe(true);
    expect(s.counterTrendPullback).toBe(false);
  });

  it('counter-trend pullback: long-term bull, short-term bear', () => {
    const s = splitTrend([r('1d', 'bullish', 0.8), r('8h', 'bullish', 0.6), r('1h', 'bearish', 0.7), r('15m', 'bearish', 0.6)]);
    expect(s.longTerm).toBe('bull');
    expect(s.shortTerm).toBe('bear');
    expect(s.aligned).toBe(false);
    expect(s.counterTrendPullback).toBe(true);
    expect(trendLine(s)).toBe('LT bull · ST bear (counter-trend)');
  });

  it('neutral long-term is never aligned or a pullback', () => {
    const s = splitTrend([r('1d', 'neutral', 0.2), r('8h', 'neutral', 0.1), r('1h', 'bullish', 0.7), r('15m', 'bullish', 0.6)]);
    expect(s.longTerm).toBe('neutral');
    expect(s.aligned).toBe(false);
    expect(s.counterTrendPullback).toBe(false);
  });

  it('ignores no-data timeframes without crashing', () => {
    const s = splitTrend([r('1d', 'bearish', 0.9), r('8h', 'bearish', 0.8, false), r('1h', 'bearish', 0.7)]);
    expect(s.longTerm).toBe('bear'); // 8h dropped (no data), 1d alone drives LT
    expect(s.shortTerm).toBe('bear'); // 15m absent, 1h drives ST
  });

  it('empty reads → all neutral, no crash', () => {
    const s = splitTrend([]);
    expect(s.longTerm).toBe('neutral');
    expect(s.shortTerm).toBe('neutral');
    expect(s.longScore).toBe(0);
  });
});

describe('opportunityFlag', () => {
  it('rubric GO wins over everything', () => {
    expect(opportunityFlag({ rubricBest: { side: 'short', opportunity: 72, badge: 'GO' }, reversion: { side: 'long', z: 3 } })).toBe('GO');
  });
  it('a reversion candidate flags REVERSION when no GO', () => {
    expect(opportunityFlag({ rubricBest: { side: 'short', opportunity: 40, badge: 'NO-EDGE' }, reversion: { side: 'long', z: -2.8 } })).toBe('REVERSION');
  });
  it('WATCH badge with no reversion → WATCH', () => {
    expect(opportunityFlag({ rubricBest: { side: 'long', opportunity: 58, badge: 'WATCH' }, reversion: null })).toBe('WATCH');
  });
  it('nothing → NONE', () => {
    expect(opportunityFlag({ rubricBest: { side: 'long', opportunity: 30, badge: 'NO-EDGE' }, reversion: null })).toBe('NONE');
    expect(opportunityFlag({ rubricBest: null, reversion: null })).toBe('NONE');
  });
});
