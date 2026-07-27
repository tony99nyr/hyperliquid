import { describe, it, expect } from 'vitest';
import { buildReversionLadderPlan, reversionAlertMessage, reversionEntry, type ReversionAlertHit } from '@/lib/ladder/reversion-alert-business-logic';

const NOW = 1_700_000_000_000;

const shortHit: ReversionAlertHit = {
  coin: 'SOL', side: 'short', z: 2.9, er: 0.2, regime: 'neutral', regimeConf: 0.3,
  mark: 100, stop: 104, target: 96, stopFrac: 0.04,
};
const longHit: ReversionAlertHit = {
  coin: 'ETH', side: 'long', z: -2.8, er: 0.25, regime: 'neutral', regimeConf: 0.2,
  mark: 2000, stop: 1920, target: 2080, stopFrac: 0.04,
};

describe('buildReversionLadderPlan', () => {
  it('short fade: rests an OFFER above the mark (price_above), stop above, WIN-side rungs on price_below, TP at mean', () => {
    const p = buildReversionLadderPlan(shortHit, { now: NOW });
    expect(p.mode).toBe('live'); // NEVER paper
    expect(p.author).toBe('operator');
    const open = p.rungs.find((r) => r.action === 'open')!;
    expect(open.side).toBe('short');
    expect(open.triggerKind).toBe('price_above'); // rest the offer INTO further strength
    expect(open.triggerPx).toBeGreaterThan(shortHit.mark); // sell HIGHER (better fill)
    expect(open.triggerMeta?.momentumConfirm).toBeUndefined(); // a limit-into-strength, not a roll-over chase
    expect(open.riskUsd).toBe(2.5); // LOW
    const tp = p.rungs.find((r) => r.action === 'reduce')!;
    expect(tp.triggerPx).toBe(96); // the mean (target)
    expect(tp.triggerKind).toBe('price_below'); // WIN side for a short
    expect(p.expiresAtMs).toBe(NOW + 12 * 60 * 60 * 1000); // short shelf-life
  });

  it('long fade: rests a BID below the mark (price_below), WIN-side rungs on price_above, TP at the higher mean', () => {
    const p = buildReversionLadderPlan(longHit, { now: NOW });
    const open = p.rungs.find((r) => r.action === 'open')!;
    expect(open.side).toBe('long');
    expect(open.triggerKind).toBe('price_below'); // rest the bid INTO further weakness
    expect(open.triggerPx).toBeLessThan(longHit.mark); // buy LOWER (better fill)
    const tp = p.rungs.find((r) => r.action === 'reduce')!;
    expect(tp.triggerKind).toBe('price_above'); // WIN side for a long
    expect(tp.triggerPx).toBe(2080);
  });

  it('sizes the loss/notional caps off the BOUNDED notional so the arm gate never false-blocks', () => {
    const p = buildReversionLadderPlan(shortHit, { now: NOW, riskUsd: 2.5 }); // stopFrac 0.04 → notional 62.5
    expect(p.maxTotalLossUsd).toBe(15); // max(15, ceil(62.5*0.2)=13)
    expect(p.maxTotalNotionalUsd).toBe(120);
    expect(p.mode).toBe('live');
  });

  it('a TIGHT stop reduces riskUsd to cap the notional (the ETH-fade bug: 0.5% stop must not balloon)', () => {
    const tight = buildReversionLadderPlan({ ...shortHit, stopFrac: 0.006 }, { now: NOW, riskUsd: 2.5 });
    const open = tight.rungs.find((r) => r.action === 'open')!;
    expect(open.riskUsd).toBeCloseTo(0.6, 6); // min(2.5, 100*0.006) — notional stays ≤ $100
    expect(open.riskUsd! / open.stopFrac!).toBeCloseTo(100, 3); // notional ≈ $100, not $500
  });

  it('clamps a garbage stopFrac into a sane band (never 0 / never huge)', () => {
    const p = buildReversionLadderPlan({ ...shortHit, stopFrac: 0 }, { now: NOW });
    const open = p.rungs.find((r) => r.action === 'open')!;
    expect(open.stopFrac).toBe(0.03); // fallback
    const p2 = buildReversionLadderPlan({ ...shortHit, stopFrac: 0.9 }, { now: NOW });
    expect(p2.rungs.find((r) => r.action === 'open')!.stopFrac).toBe(0.12); // capped
  });

  it('open → breakeven → reduce → trail, with breakeven and trail on the runner', () => {
    const p = buildReversionLadderPlan(shortHit, { now: NOW });
    const kinds = p.rungs.map((r) => r.action);
    expect(kinds).toEqual(['open', 'stop_move', 'reduce', 'stop_move']);
    expect(p.rungs[1].triggerMeta?.moveTo).toBe('breakeven');
    expect(p.rungs[3].triggerMeta?.moveTo).toBe('trail');
  });

  it('the resting entry is a genuine limit INTO the dislocation — never already-met at the draft mark', () => {
    // A long bid rests BELOW the mark (price_below), a short offer ABOVE it (price_above) —
    // so at the draft mark the entry gate is NOT satisfied (the arm-route instant-fire guard
    // won't block it), and it fills only on a further-better price. This is the whole fix.
    const longOpen = buildReversionLadderPlan(longHit, { now: NOW }).rungs[0];
    expect(longOpen.triggerKind).toBe('price_below');
    expect(longOpen.triggerPx!).toBeLessThan(longHit.mark); // mark is NOT ≤ trigger → not met
    const shortOpen = buildReversionLadderPlan(shortHit, { now: NOW }).rungs[0];
    expect(shortOpen.triggerKind).toBe('price_above');
    expect(shortOpen.triggerPx!).toBeGreaterThan(shortHit.mark); // mark is NOT ≥ trigger → not met
  });

  it('a tight signal stop (0.47%) is KEPT, not floored to 3% — the alert and the rung agree', () => {
    const tightHit = { ...longHit, stopFrac: 0.0047 };
    const open = buildReversionLadderPlan(tightHit, { now: NOW }).rungs[0];
    expect(open.stopFrac).toBeCloseTo(0.0047, 6); // NOT bumped to 0.03
    // reversionEntry drives both the plan and the message → the quoted stop equals the rung's.
    const geom = reversionEntry(tightHit);
    const msg = reversionAlertMessage(tightHit, 'abcdef12-x');
    expect(msg).toContain(geom.stopPx.toFixed(4));
    expect(msg).toContain(geom.entryPx.toFixed(4));
  });

  it('reversionAlertMessage names the coin, side, mean, stop + the arm gate + a clickable ladders link', () => {
    const m = reversionAlertMessage(shortHit, 'abcdef12-3456', 'https://example.vercel.app');
    expect(m).toContain('SOL SHORT');
    expect(m).toContain('abcdef12');
    expect(m).toContain('review + arm');
    expect(m).toContain('https://example.vercel.app/cockpit?tab=ladders');
  });

  it('omits the link when no base URL is supplied (and strips a trailing slash when it is)', () => {
    expect(reversionAlertMessage(shortHit, 'abcdef12-3456')).not.toContain('/cockpit?tab=ladders');
    expect(reversionAlertMessage(shortHit, 'x', 'https://h.app/')).toContain('https://h.app/cockpit?tab=ladders');
  });
});
