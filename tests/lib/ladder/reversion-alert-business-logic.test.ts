import { describe, it, expect } from 'vitest';
import { buildReversionLadderPlan, reversionAlertMessage, type ReversionAlertHit } from '@/lib/ladder/reversion-alert-business-logic';

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
  it('short fade: live, low-qty, profit-side (price_below) triggers, stop beyond extreme, TP at mean', () => {
    const p = buildReversionLadderPlan(shortHit, { now: NOW });
    expect(p.mode).toBe('live'); // NEVER paper
    expect(p.author).toBe('operator');
    const open = p.rungs.find((r) => r.action === 'open')!;
    expect(open.side).toBe('short');
    expect(open.triggerKind).toBe('price_below'); // short fades on the down-tick
    expect(open.triggerPx).toBeLessThan(shortHit.mark); // enters just past the mark
    expect(open.triggerMeta?.momentumConfirm).toBe(true); // gated on the roll-over
    expect(open.riskUsd).toBe(2.5); // LOW
    const tp = p.rungs.find((r) => r.action === 'reduce')!;
    expect(tp.triggerPx).toBe(96); // the mean (target)
    expect(tp.triggerKind).toBe('price_below');
    expect(p.expiresAtMs).toBe(NOW + 12 * 60 * 60 * 1000); // short shelf-life
  });

  it('long fade: profit-side is price_above, entry just above the mark, TP at the higher mean', () => {
    const p = buildReversionLadderPlan(longHit, { now: NOW });
    const open = p.rungs.find((r) => r.action === 'open')!;
    expect(open.side).toBe('long');
    expect(open.triggerKind).toBe('price_above');
    expect(open.triggerPx).toBeGreaterThan(longHit.mark);
    const tp = p.rungs.find((r) => r.action === 'reduce')!;
    expect(tp.triggerPx).toBe(2080);
  });

  it('caps risk low + sizes the loss/notional caps off riskUsd (worst case room)', () => {
    const p = buildReversionLadderPlan(shortHit, { now: NOW, riskUsd: 2.5 });
    expect(p.maxTotalLossUsd).toBe(13); // ceil(2.5*5), floored at 6
    expect(p.maxTotalNotionalUsd).toBeGreaterThan(0);
    expect(p.mode).toBe('live');
  });

  it('clamps a garbage stopFrac into a sane band (never 0 / never huge)', () => {
    const p = buildReversionLadderPlan({ ...shortHit, stopFrac: 0 }, { now: NOW });
    const open = p.rungs.find((r) => r.action === 'open')!;
    expect(open.stopFrac).toBe(0.03); // fallback
    const p2 = buildReversionLadderPlan({ ...shortHit, stopFrac: 0.9 }, { now: NOW });
    expect(p2.rungs.find((r) => r.action === 'open')!.stopFrac).toBe(0.12); // capped
  });

  it('every rung carries momentumConfirm on entry + a breakeven and trail on the runner', () => {
    const p = buildReversionLadderPlan(shortHit, { now: NOW });
    const kinds = p.rungs.map((r) => r.action);
    expect(kinds).toEqual(['open', 'stop_move', 'reduce', 'stop_move']);
    expect(p.rungs[1].triggerMeta?.moveTo).toBe('breakeven');
    expect(p.rungs[3].triggerMeta?.moveTo).toBe('trail');
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
