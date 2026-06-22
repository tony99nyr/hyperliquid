import { describe, it, expect } from 'vitest';
import { pickNewestRubricReads, assessFeedDegradation, RUBRIC_STALE_MS, loadScoutState, saveScoutState } from '@/lib/scout/scout-watch-service';
import { emptyScoutState } from '@/lib/scout/scout-trigger-business-logic';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('pickNewestRubricReads', () => {
  it('keeps the newest row per coin×side (input is computed_at desc)', () => {
    const out = pickNewestRubricReads([
      { coin: 'ETH', side: 'short', opportunity: 72, badge: 'GO', computed_at: '2026-06-21T21:00:00Z' },
      { coin: 'ETH', side: 'short', opportunity: 40, badge: 'NO-EDGE', computed_at: '2026-06-21T20:00:00Z' }, // older, dropped
      { coin: 'ETH', side: 'long', opportunity: 30, badge: 'NO-EDGE', computed_at: '2026-06-21T21:00:00Z' },
      { coin: 'BTC', side: 'long', opportunity: 61, badge: 'WATCH', computed_at: '2026-06-21T21:00:00Z' },
    ]);
    expect(out).toEqual([
      { coin: 'ETH', side: 'short', opportunity: 72, badge: 'GO' },
      { coin: 'ETH', side: 'long', opportunity: 30, badge: 'NO-EDGE' },
      { coin: 'BTC', side: 'long', opportunity: 61, badge: 'WATCH' },
    ]);
  });

  it('normalizes unknown badges to NO-EDGE and coin to upper-case', () => {
    const out = pickNewestRubricReads([
      { coin: 'eth', side: 'long', opportunity: 50, badge: 'weird', computed_at: '2026-06-21T21:00:00Z' },
    ]);
    expect(out[0]).toEqual({ coin: 'ETH', side: 'long', opportunity: 50, badge: 'NO-EDGE' });
  });

  it('coerces non-finite opportunity to 0', () => {
    const out = pickNewestRubricReads([
      { coin: 'ETH', side: 'short', opportunity: NaN as unknown as number, badge: 'GO', computed_at: 'x' },
    ]);
    expect(out[0].opportunity).toBe(0);
  });
});

describe('assessFeedDegradation — freshness gate', () => {
  const NOW = 1_700_000_000_000;
  it('fresh rubric + marks present → not degraded', () => {
    const r = assessFeedDegradation(NOW - 60_000, 4, NOW);
    expect(r.degraded).toBe(false);
    expect(r.reason).toBeNull();
  });
  it('stale rubric (older than the window) → degraded', () => {
    const r = assessFeedDegradation(NOW - RUBRIC_STALE_MS - 60_000, 4, NOW);
    expect(r.degraded).toBe(true);
    expect(r.reason).toMatch(/rubric stale/);
  });
  it('no rubric at all → degraded (none)', () => {
    const r = assessFeedDegradation(0, 4, NOW);
    expect(r.degraded).toBe(true);
    expect(r.reason).toMatch(/none/);
  });
  it('empty marks → degraded even if rubric is fresh', () => {
    const r = assessFeedDegradation(NOW - 60_000, 0, NOW);
    expect(r.degraded).toBe(true);
    expect(r.reason).toMatch(/marks empty/);
  });
});

describe('scout state persistence', () => {
  const path = join(tmpdir(), `scout-state-test-${process.pid}.json`);
  it('round-trips state to disk and back', () => {
    const state = { ...emptyScoutState(), lastBadge: { 'ETH:short': 'GO' }, lastMark: { ETH: 1700 } };
    saveScoutState(state, path);
    expect(loadScoutState(path)).toEqual(state);
  });
  it('returns empty state for a missing file (fresh baseline)', () => {
    expect(loadScoutState(join(tmpdir(), 'definitely-not-there-xyz.json'))).toEqual(emptyScoutState());
  });
});
