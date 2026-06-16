import { describe, it, expect } from 'vitest';
import {
  assessDataCompleteness,
  applyCompletenessGate,
  gradeCandidate,
  rankCandidates,
  COMPLETENESS_THRESHOLDS,
  type TraderCandidate,
} from '@/lib/skills/analyze-traders-business-logic';
import type { RatedWallet } from '@/lib/hyperliquid/rated-wallets-service';
import type { HlClearinghouseState, HlFill } from '@/lib/hyperliquid/hyperliquid-info-service';

function wallet(over: Partial<RatedWallet> = {}): RatedWallet {
  return {
    address: '0x' + 'a'.repeat(40),
    short: '0xaaaa…aaaa',
    displayName: null,
    grades: { consistency: { grade: 'A', score10: 10 } },
    composite: 10,
    flags: ['CLEAN_BOOK'],
    metrics: {},
    sources: [],
    tradingActivity: null,
    ...over,
  };
}

function emptyState(addr: string, accountValueUsd = 100_000): HlClearinghouseState {
  return {
    address: addr,
    accountValueUsd,
    totalMarginUsed: 0,
    totalNotionalPosition: 0,
    withdrawableUsd: accountValueUsd,
    positions: [],
    fetchedAt: 0,
    stale: false,
  };
}

function fills(n: number): HlFill[] {
  return Array.from({ length: n }, (_, i) => ({
    coin: 'ETH',
    side: i % 2 === 0 ? ('buy' as const) : ('sell' as const),
    px: 2000,
    sz: 1,
    time: i,
    closedPnl: 0,
    dir: 'Open Long',
  }));
}

describe('assessDataCompleteness (the gate input)', () => {
  it('flags thin history below the minimum fills', () => {
    const { completeness } = assessDataCompleteness(COMPLETENESS_THRESHOLDS.minFills - 1);
    expect(completeness).toBe('INSUFFICIENT_HISTORY');
  });
  it('flags page-capped history as incomplete', () => {
    const { completeness } = assessDataCompleteness(COMPLETENESS_THRESHOLDS.pageCapFills);
    expect(completeness).toBe('INSUFFICIENT_HISTORY');
  });
  it('passes a full-but-not-capped history', () => {
    const { completeness } = assessDataCompleteness(500);
    expect(completeness).toBe('COMPLETE');
  });

  it('legacy single-call: a count at the page cap is assumed truncated (no signal)', () => {
    const { completeness } = assessDataCompleteness(COMPLETENESS_THRESHOLDS.pageCapFills + 500);
    expect(completeness).toBe('INSUFFICIENT_HISTORY');
  });

  it('deep fetch that exhausted history (truncated=false) is COMPLETE even above the cap', () => {
    const { completeness } = assessDataCompleteness(COMPLETENESS_THRESHOLDS.pageCapFills + 3000, false);
    expect(completeness).toBe('COMPLETE');
  });

  it('deep fetch that hit a bound (truncated=true) is INSUFFICIENT_HISTORY', () => {
    const { completeness } = assessDataCompleteness(COMPLETENESS_THRESHOLDS.pageCapFills + 3000, true);
    expect(completeness).toBe('INSUFFICIENT_HISTORY');
  });

  it('truncated=true still gates a small history (core rule never weakened)', () => {
    const { completeness } = assessDataCompleteness(800, true);
    expect(completeness).toBe('INSUFFICIENT_HISTORY');
  });
});

describe('applyCompletenessGate (THE hard rule)', () => {
  it('caps an A at B when history is insufficient', () => {
    expect(applyCompletenessGate('A', 'INSUFFICIENT_HISTORY', ['CLEAN_BOOK'])).toBe('B');
  });
  it('keeps an A when history is complete', () => {
    expect(applyCompletenessGate('A', 'COMPLETE', ['CLEAN_BOOK'])).toBe('A');
  });
  it('forces F on a DISQUALIFIED wallet regardless of completeness', () => {
    expect(applyCompletenessGate('A', 'COMPLETE', ['DISQUALIFIED'])).toBe('F');
  });
  it('leaves worse-than-B grades unchanged under the gate', () => {
    expect(applyCompletenessGate('C', 'INSUFFICIENT_HISTORY', [])).toBe('C');
  });
});

describe('gradeCandidate — the 0x418aa6 lesson', () => {
  it('NEVER grades a thin-history clean-A wallet as A', () => {
    // A wallet the rating dataset called a clean A, but with only a handful of
    // fills actually fetched — exactly the trap.
    const w = wallet({ grades: { consistency: { grade: 'A', score10: 10 } }, flags: ['CLEAN_BOOK'] });
    const c = gradeCandidate(w, emptyState(w.address), fills(10));
    expect(c.completeness).toBe('INSUFFICIENT_HISTORY');
    expect(c.grade).not.toBe('A');
    expect(c.grade).toBe('B');
    expect(c.rationale).toContain('INSUFFICIENT_HISTORY');
  });

  it('grades a full-history clean-A wallet as A', () => {
    const w = wallet({ grades: { consistency: { grade: 'A', score10: 10 } }, flags: ['CLEAN_BOOK'] });
    const c = gradeCandidate(w, emptyState(w.address), fills(800));
    expect(c.completeness).toBe('COMPLETE');
    expect(c.grade).toBe('A');
  });

  it('a page-capped wallet (looks deep, is truncated) cannot be a clean A', () => {
    const w = wallet({ grades: { consistency: { grade: 'A', score10: 10 } } });
    const c = gradeCandidate(w, emptyState(w.address), fills(COMPLETENESS_THRESHOLDS.pageCapFills));
    expect(c.completeness).toBe('INSUFFICIENT_HISTORY');
    expect(c.grade).not.toBe('A');
  });

  it('a DISQUALIFIED martingale wallet is F even with full history', () => {
    const w = wallet({ flags: ['DISQUALIFIED', 'DEEP_MARTINGALE'] });
    const c = gradeCandidate(w, emptyState(w.address), fills(800));
    expect(c.grade).toBe('F');
  });

  it('deep fetch CLEARS the gate: >2000 clean fills with truncated=false grades A', () => {
    // The live blocker fix: a wallet whose deep-paginated history legitimately
    // exceeds the single-page cap must NOT be falsely flagged INSUFFICIENT_HISTORY.
    const w = wallet({ grades: { consistency: { grade: 'A', score10: 10 } }, flags: ['CLEAN_BOOK'] });
    const c = gradeCandidate(w, emptyState(w.address), fills(COMPLETENESS_THRESHOLDS.pageCapFills + 2500), false);
    expect(c.completeness).toBe('COMPLETE');
    expect(c.grade).toBe('A');
  });

  it('a single 2000-capped page (no deep signal) still flags INSUFFICIENT_HISTORY', () => {
    // Same fill count, but no truncated signal => legacy heuristic => gated.
    const w = wallet({ grades: { consistency: { grade: 'A', score10: 10 } }, flags: ['CLEAN_BOOK'] });
    const c = gradeCandidate(w, emptyState(w.address), fills(COMPLETENESS_THRESHOLDS.pageCapFills));
    expect(c.completeness).toBe('INSUFFICIENT_HISTORY');
    expect(c.grade).not.toBe('A');
  });

  it('deep fetch that hit a bound (truncated=true) stays capped at B even with many fills', () => {
    const w = wallet({ grades: { consistency: { grade: 'A', score10: 10 } }, flags: ['CLEAN_BOOK'] });
    const c = gradeCandidate(w, emptyState(w.address), fills(COMPLETENESS_THRESHOLDS.pageCapFills + 5000), true);
    expect(c.completeness).toBe('INSUFFICIENT_HISTORY');
    expect(c.grade).toBe('B');
  });
});

describe('rankCandidates', () => {
  function cand(over: Partial<TraderCandidate>): TraderCandidate {
    return {
      address: '0x' + '1'.repeat(40),
      short: 's',
      displayName: null,
      grade: 'B',
      composite: 5,
      completeness: 'COMPLETE',
      completenessReason: '',
      flags: [],
      alerts: [],
      fillsSeen: 100,
      accountValueUsd: 0,
      rationale: '',
      ...over,
    };
  }
  it('ranks A before B', () => {
    const ranked = rankCandidates([cand({ grade: 'B', address: '0xbbbb' }), cand({ grade: 'A', address: '0xaaaa' })]);
    expect(ranked[0].grade).toBe('A');
  });
  it('ranks a COMPLETE B above an INSUFFICIENT_HISTORY B', () => {
    const ranked = rankCandidates([
      cand({ grade: 'B', completeness: 'INSUFFICIENT_HISTORY', address: '0x1' }),
      cand({ grade: 'B', completeness: 'COMPLETE', address: '0x2' }),
    ]);
    expect(ranked[0].completeness).toBe('COMPLETE');
  });
});
