import { describe, it, expect } from 'vitest';
import {
  detectRunaway,
  runawayEntry,
  buildRunawayLadderPlan,
  runawayAlertMessage,
  RUNAWAY_MOVE_THRESHOLD,
} from '@/lib/ladder/runaway-alert-business-logic';
import { validateLadderForArm, resolveArmRung } from '@/lib/ladder/ladder-arm-business-logic';
import type { LadderRung } from '@/lib/ladder/ladder-types';

const NOW = 1_787_000_000_000;

describe('detectRunaway — strong movement IS a catalyst', () => {
  it('fires LONG on an outsized up-move (the HYPE +19% shape)', () => {
    const hit = detectRunaway({ coin: 'HYPE', mark: 70.11, prevDayPx: 58.86 });
    expect(hit?.side).toBe('long');
    expect(hit!.movePct24h).toBeGreaterThan(0.15);
  });

  it('fires SHORT on an outsized down-move', () => {
    const hit = detectRunaway({ coin: 'SOL', mark: 71.25, prevDayPx: 75.0 });
    expect(hit?.side).toBe('short');
  });

  it('is quiet below the threshold and on degenerate inputs', () => {
    expect(detectRunaway({ coin: 'BTC', mark: 104, prevDayPx: 100 })).toBeNull(); // +4% < 5%
    expect(detectRunaway({ coin: 'BTC', mark: 100, prevDayPx: 0 })).toBeNull();
    expect(detectRunaway({ coin: 'BTC', mark: 0, prevDayPx: 100 })).toBeNull();
    expect(detectRunaway({ coin: 'BTC', mark: 105.1, prevDayPx: 100 })?.side).toBe('long'); // just over
    expect(RUNAWAY_MOVE_THRESHOLD).toBe(0.05); // the operator's bar — changing it is a doctrine change
  });
});

describe('runawayEntry — pullback geometry (never chases, never instant-fires)', () => {
  const longHit = detectRunaway({ coin: 'HYPE', mark: 70, prevDayPx: 58 })!;
  const shortHit = detectRunaway({ coin: 'SOL', mark: 70, prevDayPx: 78 })!;

  it('a LONG rests a bid BELOW the mark (arm-safe: cannot be already-met at draft time)', () => {
    const e = runawayEntry(longHit);
    expect(e.entryKind).toBe('price_below');
    expect(e.entryPx).toBeLessThan(longHit.mark);
    expect(e.stopPx).toBeLessThan(e.entryPx); // stop on the loss side
  });

  it('a SHORT rests an offer ABOVE the mark, stop above entry', () => {
    const e = runawayEntry(shortHit);
    expect(e.entryKind).toBe('price_above');
    expect(e.entryPx).toBeGreaterThan(shortHit.mark);
    expect(e.stopPx).toBeGreaterThan(e.entryPx);
  });
});

describe('buildRunawayLadderPlan — the draft is genuinely armable', () => {
  const hit = detectRunaway({ coin: 'HYPE', mark: 70, prevDayPx: 58 })!;
  const plan = buildRunawayLadderPlan(hit, { now: NOW });

  it('is a LIVE low-qty draft with caps, expiry, and the doctrine in the thesis', () => {
    expect(plan.mode).toBe('live');
    expect(plan.author).toBe('operator');
    expect(plan.maxTotalLossUsd).toBeGreaterThan(0);
    expect(plan.maxTotalNotionalUsd).toBeGreaterThan(0);
    expect(plan.expiresAtMs).toBe(NOW + 48 * 3600_000);
    expect(plan.thesis).toMatch(/catalyst/i);
  });

  it('entry + add are momentum-confirmed; the win-side rungs point the right way', () => {
    const [open, add, be, tp, trail] = plan.rungs;
    expect(open.action).toBe('open');
    expect(open.triggerMeta?.momentumConfirm).toBe(true);
    expect(add.action).toBe('add');
    expect(add.triggerMeta?.momentumConfirm).toBe(true);
    expect(be.action).toBe('stop_move');
    expect(be.triggerMeta?.moveTo).toBe('breakeven');
    expect(tp.action).toBe('reduce');
    expect(trail.triggerMeta?.moveTo).toBe('trail');
    // Long: entry rests below the mark; add/banks trigger above it.
    expect(open.triggerKind).toBe('price_below');
    expect(add.triggerKind).toBe('price_above');
    expect(Number(add.triggerPx)).toBeGreaterThan(hit.mark);
    expect(Number(tp.triggerPx)).toBeGreaterThan(Number(add.triggerPx));
  });

  it('PASSES the full arm validation (no warnings) — a draft that cannot arm is noise', () => {
    const armRungs = plan.rungs.map((r, i) =>
      resolveArmRung({
        id: `r${i}`,
        ladderId: 'l1',
        seq: r.seq,
        coin: r.coin,
        side: r.side,
        action: r.action,
        triggerKind: r.triggerKind,
        triggerPx: r.triggerPx ?? null,
        triggerMeta: r.triggerMeta ?? null,
        riskUsd: r.riskUsd ?? null,
        stopFrac: r.stopFrac ?? null,
        leverage: r.leverage ?? null,
        reduceFrac: r.reduceFrac ?? null,
        stopPx: r.stopPx ?? null,
        targetPx: r.targetPx ?? null,
        status: 'pending',
      } as LadderRung),
    );
    const v = validateLadderForArm({
      title: plan.title,
      thesis: plan.thesis,
      expiresAtMs: plan.expiresAtMs ?? null,
      activeFromMs: null,
      caps: { maxTotalNotionalUsd: plan.maxTotalNotionalUsd ?? null, maxTotalLossUsd: plan.maxTotalLossUsd ?? null },
      rungs: armRungs,
      now: NOW,
      coinMaxLeverage: () => 20,
      fundingRateByCoin: {},
    });
    expect(v.warnings).toEqual([]);
  });
});

describe('runawayAlertMessage', () => {
  it('quotes the SAME entry/stop the rungs use (no desync) + the review+arm gate', () => {
    const hit = detectRunaway({ coin: 'HYPE', mark: 70, prevDayPx: 58 })!;
    const msg = runawayAlertMessage(hit, 'abcdef1234567890', 'https://x.example');
    const { entryPx, stopPx } = runawayEntry(hit);
    expect(msg).toContain(entryPx.toFixed(4));
    expect(msg).toContain(stopPx.toFixed(4));
    expect(msg).toMatch(/arm in the cockpit/i);
    expect(msg).toContain('abcdef12');
  });
});
