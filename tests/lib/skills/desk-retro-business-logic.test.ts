/**
 * Pins the discard-vet replay: a wrong verdict here feeds a false "missed
 * opportunity" (or false comfort) into the weekly retro. The conservatisms are
 * load-bearing — stop-first on a both-in-one-bar span, completed-close trigger,
 * expiry-window clamp — so each is pinned explicitly.
 */

import { describe, it, expect } from 'vitest';
import {
  replayDiscardedEntry,
  summarizeDiscardVet,
  type DiscardedPlan,
  type RetroCandle,
} from '@/lib/skills/desk-retro-business-logic';

const H4 = 4 * 3_600_000;
const T0 = Date.UTC(2026, 9, 1); // 2026-10-01

function bar(i: number, closePx: number, highPx = closePx * 1.01, lowPx = closePx * 0.99): RetroCandle {
  return { timeMs: T0 + i * H4, closePx, highPx, lowPx };
}

const longPlan = (over: Partial<DiscardedPlan> = {}): DiscardedPlan => ({
  coin: 'ETH',
  side: 'long',
  triggerKind: 'price_above',
  triggerPx: 100,
  stopPx: 95,
  stopFrac: null,
  targetPx: 110,
  windowStartMs: T0,
  expiresAtMs: null,
  ...over,
});

describe('replayDiscardedEntry', () => {
  it('never-triggered when no completed close crosses the trigger', () => {
    const v = replayDiscardedEntry(longPlan(), [bar(0, 98), bar(1, 99.5), bar(2, 97)]);
    expect(v).toMatchObject({ outcome: 'never-triggered', rMultiple: null, entryPx: null });
  });

  it('missed-target: fires at the trigger-bar CLOSE (overshoot) and pays the target R', () => {
    // Close 101 (not the 100 trigger) → risk 6, target 110 → +1.5R.
    const v = replayDiscardedEntry(longPlan(), [bar(0, 98), bar(1, 101), bar(2, 104), bar(3, 109, 111)]);
    expect(v.outcome).toBe('missed-target');
    expect(v.entryPx).toBe(101);
    expect(v.exitPx).toBe(110);
    expect(v.rMultiple).toBeCloseTo(9 / 6, 6);
    expect(v.triggeredAtMs).toBe(T0 + H4);
    expect(v.resolvedAtMs).toBe(T0 + 3 * H4);
  });

  it('dodged-stop: a low through the stop after the fill is −1R', () => {
    const v = replayDiscardedEntry(longPlan(), [bar(0, 101), bar(1, 97, 98, 94)]);
    expect(v).toMatchObject({ outcome: 'dodged-stop', exitPx: 95, rMultiple: -1 });
  });

  it('a bar spanning BOTH stop and target counts the stop (conservative)', () => {
    const v = replayDiscardedEntry(longPlan(), [bar(0, 101), bar(1, 100, 115, 94)]);
    expect(v.outcome).toBe('dodged-stop');
    expect(v.rMultiple).toBe(-1);
  });

  it('stop/target never evaluate on the fill bar itself (fill is AT the close)', () => {
    // The fill bar's own low breaches the stop — but the fill happened at its close.
    const v = replayDiscardedEntry(longPlan(), [bar(0, 101, 102, 90), bar(1, 103)]);
    expect(v.outcome).toBe('would-be-open');
  });

  it('would-be-open marks to the last completed close, signed', () => {
    const v = replayDiscardedEntry(longPlan(), [bar(0, 101), bar(1, 98)]);
    expect(v.outcome).toBe('would-be-open');
    expect(v.rMultiple).toBeCloseTo(-3 / 6, 6);
    expect(v.resolvedAtMs).toBeNull();
  });

  it('short side mirrors: price_below trigger, stop above, target below', () => {
    const plan = longPlan({ side: 'short', triggerKind: 'price_below', triggerPx: 100, stopPx: 105, targetPx: 90 });
    const v = replayDiscardedEntry(plan, [bar(0, 99), bar(1, 95), bar(2, 91, 92, 89)]);
    // Entry 99, risk 6, target 90 → +1.5R.
    expect(v.outcome).toBe('missed-target');
    expect(v.rMultiple).toBeCloseTo(9 / 6, 6);
  });

  it('a trigger AFTER the draft expiry never fires (the watch would have cancelled)', () => {
    const plan = longPlan({ expiresAtMs: T0 + H4 });
    const v = replayDiscardedEntry(plan, [bar(0, 98), bar(1, 98), bar(2, 105)]);
    expect(v.outcome).toBe('never-triggered');
    // The boundary is INCLUSIVE on the bar's open time: a bar opening exactly at
    // expiry still evaluates (documented one-bar-late approximation).
    const atBoundary = replayDiscardedEntry(plan, [bar(0, 98), bar(1, 105)]);
    expect(atBoundary.outcome).toBe('would-be-open');
  });

  it('IGNORES a target on the wrong side of the fill (never mints a fake win)', () => {
    // Fill overshoots to 112, "target" 110 sits BELOW it — must not count as a miss.
    const v = replayDiscardedEntry(longPlan(), [bar(0, 112), bar(1, 111, 113, 109)]);
    expect(v.outcome).toBe('would-be-open');
    expect(v.hadTarget).toBe(false);
  });

  it('short fractional stop resolves ABOVE the fill and dodges on a high through it', () => {
    // Entry close 99 → stop 99 * 1.05 = 103.95; a high of 104 stops it.
    const plan = longPlan({ side: 'short', triggerKind: 'price_below', triggerPx: 100, stopPx: null, stopFrac: 0.05, targetPx: 90 });
    const v = replayDiscardedEntry(plan, [bar(0, 99), bar(1, 103, 104, 101)]);
    expect(v).toMatchObject({ outcome: 'dodged-stop', exitPx: 103.95, rMultiple: -1 });
  });

  it('bars before the window start never evaluate', () => {
    const plan = longPlan({ windowStartMs: T0 + 2 * H4 });
    const v = replayDiscardedEntry(plan, [bar(0, 105), bar(1, 104), bar(2, 98), bar(3, 97)]);
    expect(v.outcome).toBe('never-triggered');
  });

  it('resolves a FRACTIONAL stop off the entry close (the drafter-rung shape)', () => {
    // Entry close 101, stopFrac 5% → stop 95.95, risk 5.05; a low of 95 stops it.
    const plan = longPlan({ stopPx: null, stopFrac: 0.05 });
    const v = replayDiscardedEntry(plan, [bar(0, 101), bar(1, 97, 98, 95)]);
    expect(v).toMatchObject({ outcome: 'dodged-stop', exitPx: 95.95, rMultiple: -1 });
  });

  it('not-evaluable when the rung carries NO stop at all', () => {
    const plan = longPlan({ stopPx: null, stopFrac: null });
    const v = replayDiscardedEntry(plan, [bar(0, 101), bar(1, 90, 91, 89)]);
    expect(v).toMatchObject({ outcome: 'not-evaluable', rMultiple: null });
  });

  it('not-evaluable when the stop sits on the wrong side of the would-be fill', () => {
    const plan = longPlan({ stopPx: 120 });
    const v = replayDiscardedEntry(plan, [bar(0, 101), bar(1, 130)]);
    expect(v).toMatchObject({ outcome: 'not-evaluable', rMultiple: null, entryPx: 101 });
  });

  it('no target: only stop or mark-to-market can resolve it, and hadTarget says so', () => {
    const plan = longPlan({ targetPx: null });
    const v = replayDiscardedEntry(plan, [bar(0, 101), bar(1, 150, 160, 148)]);
    expect(v.outcome).toBe('would-be-open');
    expect(v.rMultiple).toBeCloseTo(49 / 6, 6);
    expect(v.hadTarget).toBe(false);
  });
});

describe('summarizeDiscardVet', () => {
  it('counts outcomes, nets the fired R, and flags fires with no measurable miss', () => {
    const verdicts = [
      replayDiscardedEntry(longPlan(), [bar(0, 98)]), // never
      replayDiscardedEntry(longPlan(), [bar(0, 101), bar(1, 97, 98, 94)]), // dodge −1
      replayDiscardedEntry(longPlan(), [bar(0, 101), bar(1, 109, 111)]), // miss +1.5
      replayDiscardedEntry(longPlan({ targetPx: null }), [bar(0, 101), bar(1, 97, 98, 94)]), // dodge, no target
    ];
    const s = summarizeDiscardVet(verdicts);
    expect(s).toMatchObject({ total: 4, neverTriggered: 1, dodgedStops: 2, missedTargets: 1, firedWithoutTarget: 1 });
    expect(s.netHindsightR).toBeCloseTo(-0.5, 6);
  });
});
