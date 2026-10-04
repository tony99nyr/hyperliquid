/**
 * Pins the PURE draft re-anchor math (retro 2026-10-03: three stale-gate incidents
 * left drafter ladders un-armable; re-anchor scales the plan to the live mark).
 * The load-bearing properties: every PRICE field scales by exactly mark/anchor,
 * nothing else changes, non-pending rungs are untouched, and the drift bound
 * refuses a mechanical re-price of a dead premise.
 */

import { describe, it, expect } from 'vitest';
import {
  reanchorLadderRungs,
  reanchorThesisNote,
  stripReanchorNotes,
  MAX_REANCHOR_DRIFT_FRAC,
} from '@/lib/ladder/ladder-reanchor-business-logic';
import type { LadderRung } from '@/lib/ladder/ladder-types';

type RungIn = Pick<LadderRung, 'id' | 'status' | 'triggerPx' | 'stopPx' | 'targetPx' | 'triggerMeta'>;

const rung = (over: Partial<RungIn> = {}): RungIn => ({
  id: 'r1', status: 'pending', triggerPx: 100, stopPx: 95, targetPx: 110, triggerMeta: null, ...over,
});

describe('reanchorLadderRungs', () => {
  it('scales triggerPx/stopPx/targetPx by exactly mark/anchor (the SOL incident shape)', () => {
    // Anchor 117.2 → mark 121.31 (the 2026-10-03 SOL runaway re-anchor, done by hand then).
    const out = reanchorLadderRungs([rung({ triggerPx: 113.098, stopPx: 107.4431, targetPx: 124.232 })], 117.2, 121.31);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const f = 121.31 / 117.2;
    expect(out.factor).toBeCloseTo(f, 12);
    expect(out.patches[0].triggerPx).toBeCloseTo(113.098 * f, 5);
    expect(out.patches[0].stopPx).toBeCloseTo(107.4431 * f, 5);
    expect(out.patches[0].targetPx).toBeCloseTo(124.232 * f, 5);
  });

  it('scales the price-valued triggerMeta fields and leaves the rest alone', () => {
    const out = reanchorLadderRungs(
      [
        rung({ id: 'a', triggerMeta: { moveTo: 102, trailDistancePx: 2, floorPx: 105, momentumConfirm: true, momentumMaxFlips: 1 } }),
        rung({ id: 'b', triggerMeta: { moveTo: 'breakeven' } }),
        rung({ id: 'c', triggerMeta: { moveTo: 'trail', trailDistancePx: 2.4 } }),
        rung({ id: 'd', triggerMeta: { indicatorName: 'momentum-stall-long', indicatorValue: 2, op: 'above', minVolume: 500 } }),
      ],
      100,
      110,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const [a, b, c, d] = out.patches;
    expect(a.triggerMeta).toMatchObject({ moveTo: 112.2, trailDistancePx: 2.2, floorPx: 115.5, momentumConfirm: true, momentumMaxFlips: 1 });
    expect(b.triggerMeta).toEqual({ moveTo: 'breakeven' }); // string moveTo untouched
    expect(c.triggerMeta).toMatchObject({ moveTo: 'trail', trailDistancePx: 2.64 });
    // indicatorValue is a stall COUNT, minVolume a volume — neither is a price.
    expect(d.triggerMeta).toEqual({ indicatorName: 'momentum-stall-long', indicatorValue: 2, op: 'above', minVolume: 500 });
  });

  it('does not mutate the input rungs (pure)', () => {
    const meta = { moveTo: 102, trailDistancePx: 2 };
    const r = rung({ triggerMeta: meta });
    reanchorLadderRungs([r], 100, 110);
    expect(r.triggerPx).toBe(100);
    expect(meta.moveTo).toBe(102);
    expect(meta.trailDistancePx).toBe(2);
  });

  it('skips non-pending rungs and keeps null prices null', () => {
    const out = reanchorLadderRungs(
      [rung({ id: 'fired', status: 'fired' }), rung({ id: 'p', triggerPx: 100, stopPx: null, targetPx: null })],
      100,
      105,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.patches).toHaveLength(1);
    expect(out.patches[0]).toMatchObject({ rungId: 'p', triggerPx: 105, stopPx: null, targetPx: null });
  });

  it('refuses when every rung is non-pending', () => {
    const out = reanchorLadderRungs([rung({ status: 'fired' })], 100, 105);
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining('no pending rungs') });
  });

  it('refuses a bad anchor or a bad mark', () => {
    expect(reanchorLadderRungs([rung()], 0, 105).ok).toBe(false);
    expect(reanchorLadderRungs([rung()], NaN, 105).ok).toBe(false);
    expect(reanchorLadderRungs([rung()], 100, 0).ok).toBe(false);
    expect(reanchorLadderRungs([rung()], 100, Number.NaN).ok).toBe(false);
  });

  it(`refuses a drift beyond ±${MAX_REANCHOR_DRIFT_FRAC * 100}% (dead premise — re-draft, do not scale)`, () => {
    const up = reanchorLadderRungs([rung()], 100, 151);
    expect(up).toMatchObject({ ok: false, reason: expect.stringContaining('re-draft') });
    const down = reanchorLadderRungs([rung()], 100, 49);
    expect(down.ok).toBe(false);
    // The boundary itself is allowed (exactly ±50%).
    expect(reanchorLadderRungs([rung()], 100, 150).ok).toBe(true);
  });

  it('is idempotent at factor 1 (re-anchoring an already-fresh draft changes nothing)', () => {
    const out = reanchorLadderRungs([rung({ triggerPx: 113.098, stopPx: 107.4431 })], 117.2, 117.2);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.patches[0].triggerPx).toBe(113.098);
    expect(out.patches[0].stopPx).toBe(107.4431);
  });
});

describe('reanchorThesisNote', () => {
  it('records old → new anchor with a signed % and says the quoted prices are pre-scale', () => {
    const note = reanchorThesisNote(117.2, 121.31, '2026-10-04T12:00:00.000Z');
    expect(note).toContain('117.2');
    expect(note).toContain('121.31');
    expect(note).toContain('+3.51%');
    expect(note).toContain('pre-scale');
  });

  it('stripReanchorNotes removes its own notes (and only them) so re-anchors never stack', () => {
    const original = 'Thesis prose [with brackets] kept.';
    const once = `${original}\n\n${reanchorThesisNote(100, 110, '2026-10-01T00:00:00.000Z')}`;
    expect(stripReanchorNotes(once)).toBe(original);
    expect(stripReanchorNotes(original)).toBe(original);
    expect(stripReanchorNotes('')).toBe('');
  });
});
