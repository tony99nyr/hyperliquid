import { describe, it, expect } from 'vitest';
import {
  detectScoutTriggers,
  emptyScoutState,
  hasActTrigger,
  DEFAULT_SCOUT_TRIGGER_CONFIG,
  type ScoutState,
  type DetectScoutTriggersInput,
} from '@/lib/scout/scout-trigger-business-logic';

const NOW = 1_700_000_000_000;

function input(over: Partial<DetectScoutTriggersInput> = {}): DetectScoutTriggersInput {
  return { rubric: [], marks: [], positions: [], now: NOW, ...over };
}

describe('detectScoutTriggers — rubric', () => {
  it('fires rubric-go on the NO-EDGE/WATCH → GO crossing, not while it stays GO', () => {
    const first = detectScoutTriggers(
      input({ rubric: [{ coin: 'ETH', side: 'short', opportunity: 72, badge: 'GO' }] }),
      emptyScoutState(),
    );
    expect(first.triggers.map((t) => t.kind)).toEqual(['rubric-go']);
    expect(first.triggers[0].urgency).toBe('info');

    // Stays GO next cycle → no re-fire (transition, not level).
    const second = detectScoutTriggers(
      input({ rubric: [{ coin: 'ETH', side: 'short', opportunity: 73, badge: 'GO' }] }),
      first.state,
    );
    expect(second.triggers).toEqual([]);
  });

  it('fires rubric-jump when opportunity moves ≥ threshold (and not on small drift)', () => {
    const prev: ScoutState = { ...emptyScoutState(), lastOpportunity: { 'ETH:long': 40 }, lastBadge: { 'ETH:long': 'NO-EDGE' } };
    const jump = detectScoutTriggers(
      input({ rubric: [{ coin: 'ETH', side: 'long', opportunity: 58, badge: 'WATCH' }] }),
      prev,
    );
    expect(jump.triggers.map((t) => t.kind)).toEqual(['rubric-jump']);

    const drift = detectScoutTriggers(
      input({ rubric: [{ coin: 'ETH', side: 'long', opportunity: 45, badge: 'NO-EDGE' }] }),
      prev,
    );
    expect(drift.triggers).toEqual([]);
  });

  it('does not jump-fire on the first sighting (no prior opportunity)', () => {
    const r = detectScoutTriggers(
      input({ rubric: [{ coin: 'BTC', side: 'long', opportunity: 60, badge: 'WATCH' }] }),
      emptyScoutState(),
    );
    expect(r.triggers).toEqual([]);
    expect(r.state.lastOpportunity['BTC:long']).toBe(60);
  });
});

describe('detectScoutTriggers — price', () => {
  it('fires price-move on a fast move and updates the baseline each cycle', () => {
    const prev: ScoutState = { ...emptyScoutState(), lastMark: { ETH: 1700 } };
    const r = detectScoutTriggers(input({ marks: [{ coin: 'ETH', markPx: 1685 }] }), prev);
    expect(r.triggers.map((t) => t.kind)).toEqual(['price-move']); // -0.88% > 0.6%
    expect(r.state.lastMark.ETH).toBe(1685);
  });

  it('does not fire below the move threshold', () => {
    const prev: ScoutState = { ...emptyScoutState(), lastMark: { ETH: 1700 } };
    const r = detectScoutTriggers(input({ marks: [{ coin: 'ETH', markPx: 1701 }] }), prev);
    expect(r.triggers).toEqual([]);
  });
});

describe('detectScoutTriggers — cumulative drift (slow trend, either direction)', () => {
  it('fires price-drift on a slow grind that NEVER trips the per-cycle move threshold', () => {
    // anchor 64000; mark 65000 = +1.56% drift, but per-cycle delta (vs lastMark
    // 64980) is only ~0.03% → no price-move, but price-DRIFT fires.
    const prev: ScoutState = { ...emptyScoutState(), lastMark: { BTC: 64980 }, driftAnchorPx: { BTC: 64000 }, driftAnchorAt: { BTC: NOW - 3_600_000 } };
    const r = detectScoutTriggers(input({ marks: [{ coin: 'BTC', markPx: 65000 }] }), prev);
    const kinds = r.triggers.map((t) => t.kind);
    expect(kinds).toContain('price-drift');
    expect(kinds).not.toContain('price-move'); // the slow grind didn't trip the fast detector
    expect(r.state.driftAnchorPx.BTC).toBe(65000); // re-anchored at the trigger
  });

  it('fires on a slow SELLOFF too (drift is direction-agnostic — wins on either side)', () => {
    const prev: ScoutState = { ...emptyScoutState(), lastMark: { ETH: 1701 }, driftAnchorPx: { ETH: 1720 }, driftAnchorAt: { ETH: NOW - 3_600_000 } };
    const r = detectScoutTriggers(input({ marks: [{ coin: 'ETH', markPx: 1700 }] }), prev);
    expect(r.triggers.map((t) => t.kind)).toContain('price-drift');
  });

  it('sets an anchor on first sighting; no drift trigger without one', () => {
    const r = detectScoutTriggers(input({ marks: [{ coin: 'SOL', markPx: 74 }] }), emptyScoutState());
    expect(r.triggers).toEqual([]);
    expect(r.state.driftAnchorPx.SOL).toBe(74);
  });

  it('holds the anchor below threshold (drift accumulates across cycles)', () => {
    const prev: ScoutState = { ...emptyScoutState(), lastMark: { BTC: 64200 }, driftAnchorPx: { BTC: 64000 }, driftAnchorAt: { BTC: NOW } };
    const r = detectScoutTriggers(input({ marks: [{ coin: 'BTC', markPx: 64300 }] }), prev); // +0.47% < 1%
    expect(r.triggers.map((t) => t.kind)).not.toContain('price-drift');
    expect(r.state.driftAnchorPx.BTC).toBe(64000); // anchor unchanged → keeps accumulating
  });
});

describe('detectScoutTriggers — open positions (risk / act)', () => {
  it('fires position-health-drop on the floor crossing', () => {
    const prev: ScoutState = { ...emptyScoutState(), lastHealth: { 'ETH:long': 50 } };
    const r = detectScoutTriggers(
      input({ positions: [{ coin: 'ETH', side: 'long', healthScore: 30, unrealizedPnlUsd: -12, markPx: 1700 }] }),
      prev,
    );
    expect(r.triggers.map((t) => t.kind)).toEqual(['position-health-drop']);
    expect(hasActTrigger(r.triggers)).toBe(true);
  });

  it('fires position-health-drop on a sharp single-cycle drop above the floor', () => {
    const prev: ScoutState = { ...emptyScoutState(), lastHealth: { 'ETH:long': 80 } };
    const r = detectScoutTriggers(
      input({ positions: [{ coin: 'ETH', side: 'long', healthScore: 60, unrealizedPnlUsd: 0, markPx: 1700 }] }),
      prev,
    );
    expect(r.triggers.map((t) => t.kind)).toEqual(['position-health-drop']);
  });

  it('fires position-near-stop only when the mark is adverse + within the band', () => {
    // long with stop at 1700, mark 1702 → within 0.4% AND on the losing side.
    const near = detectScoutTriggers(
      input({ positions: [{ coin: 'ETH', side: 'long', healthScore: 60, unrealizedPnlUsd: -5, stopPx: 1700, markPx: 1702 }] }),
      { ...emptyScoutState(), lastHealth: { 'ETH:long': 60 } },
    );
    expect(near.triggers.map((t) => t.kind)).toContain('position-near-stop');

    // long with mark well above stop → no fire.
    const far = detectScoutTriggers(
      input({ positions: [{ coin: 'ETH', side: 'long', healthScore: 60, unrealizedPnlUsd: 20, stopPx: 1700, markPx: 1740 }] }),
      { ...emptyScoutState(), lastHealth: { 'ETH:long': 60 } },
    );
    expect(far.triggers.map((t) => t.kind)).not.toContain('position-near-stop');
  });
});

describe('detectScoutTriggers — determinism', () => {
  it('same inputs → identical triggers', () => {
    const inp = input({
      rubric: [{ coin: 'ETH', side: 'short', opportunity: 72, badge: 'GO' }],
      marks: [{ coin: 'ETH', markPx: 1690 }],
    });
    const prev: ScoutState = { ...emptyScoutState(), lastMark: { ETH: 1700 }, lastBadge: { 'ETH:short': 'WATCH' } };
    const a = detectScoutTriggers(inp, prev, DEFAULT_SCOUT_TRIGGER_CONFIG);
    const b = detectScoutTriggers(inp, prev, DEFAULT_SCOUT_TRIGGER_CONFIG);
    expect(a.triggers).toEqual(b.triggers);
  });
});
