import { describe, it, expect } from 'vitest';
import {
  projectRung,
  rungProximity,
  buildLadderChartLines,
  buildArmedEntryLines,
  expiryReadout,
} from '@/lib/ladder/ladder-projection-business-logic';
import type { LadderRung } from '@/lib/ladder/ladder-types';

/** A risk-sized long rung like the pilots: ETH long, trigger 1618, risk $5, stop 5%, 3×. */
function longRung(over: Partial<LadderRung> = {}): LadderRung {
  return {
    id: 'r1', ladderId: 'l1', seq: 1, coin: 'ETH', side: 'long', action: 'open',
    triggerKind: 'price_above', triggerPx: 1618, triggerMeta: null,
    sizeCoins: null, reduceFrac: null, riskUsd: 5, stopFrac: 0.05, leverage: 3,
    stopPx: null, targetPx: null, status: 'pending', cloid: null,
    ...over,
  };
}

describe('projectRung', () => {
  it('risk-sizes the size + derives the stop, matching arm/fire parity', () => {
    const p = projectRung(longRung());
    // size = risk / (entry · stopFrac) = 5 / (1618 · 0.05) = 0.061805…
    expect(p.entryPx).toBe(1618);
    expect(p.sizeCoins).toBeCloseTo(5 / (1618 * 0.05), 6);
    // stop = entry · (1 − 0.05) = 1537.10
    expect(p.stopPx).toBeCloseTo(1537.1, 4);
    expect(p.leverage).toBe(3);
  });

  it('computes notional, margin and the clean stop-risk (≈ configured riskUsd)', () => {
    const p = projectRung(longRung());
    expect(p.notionalUsd).toBeCloseTo(1618 * (5 / (1618 * 0.05)), 4); // = $100
    expect(p.marginUsd).toBeCloseTo(100 / 3, 4);
    // clean risk |entry−stop|·size === the configured $5 by construction
    expect(p.riskUsd).toBeCloseTo(5, 6);
    expect(p.stopPct).toBeCloseTo(0.05, 6);
  });

  it('exposes the slipped worst-case risk (≥ clean stop risk)', () => {
    const p = projectRung(longRung());
    // clean = $5; slipped fills the stop 10% worse → loss grows by 0.1·entry·size beyond it.
    expect(p.slippedRiskUsd).not.toBeNull();
    expect(p.slippedRiskUsd!).toBeGreaterThan(p.riskUsd!);
    // long: stop 1537.10 slips to ×0.9 = 1383.39; adverse = 1618−1383.39 = 234.61 × size
    const size = 5 / (1618 * 0.05);
    expect(p.slippedRiskUsd!).toBeCloseTo((1618 - 1537.1 * 0.9) * size, 2);
  });

  it('derives reward + R:R only when a target is present', () => {
    const noTgt = projectRung(longRung());
    expect(noTgt.rewardUsd).toBeNull();
    expect(noTgt.rrRatio).toBeNull();

    // target at +10% → reward 2× the 5% stop risk → R:R 2.0
    const withTgt = projectRung(longRung({ targetPx: 1618 * 1.1 }));
    expect(withTgt.targetPct).toBeCloseTo(0.1, 6);
    expect(withTgt.rewardUsd).toBeCloseTo(10, 4);
    expect(withTgt.rrRatio).toBeCloseTo(2, 4);
  });

  it('short rung derives the stop ABOVE entry', () => {
    const p = projectRung(longRung({ side: 'short', triggerKind: 'price_below', triggerPx: 1602 }));
    expect(p.entryPx).toBe(1602);
    expect(p.stopPx).toBeCloseTo(1602 * 1.05, 4); // above entry for a short
    expect(p.riskUsd).toBeCloseTo(5, 6);
  });
});

describe('rungProximity', () => {
  it('price_above: needs an UP move until the mark crosses, then primes', () => {
    const below = rungProximity({ triggerKind: 'price_above', triggerPx: 1618 }, 1611.65);
    expect(below).toEqual({ primed: false, pct: (1618 - 1611.65) / 1611.65, direction: 'up', toPx: 1618 });
    const through = rungProximity({ triggerKind: 'price_above', triggerPx: 1618 }, 1620);
    expect(through).toEqual({ primed: true, pct: 0, direction: 'up', toPx: 1618 });
  });

  it('price_below: needs a DOWN move until the mark crosses, then primes', () => {
    const above = rungProximity({ triggerKind: 'price_below', triggerPx: 1602 }, 1611.65);
    expect(above).toEqual({ primed: false, pct: (1611.65 - 1602) / 1611.65, direction: 'down', toPx: 1602 });
    const through = rungProximity({ triggerKind: 'price_below', triggerPx: 1602 }, 1600);
    expect(through?.primed).toBe(true);
  });

  it('returns null for a missing mark or a non-price trigger', () => {
    expect(rungProximity({ triggerKind: 'price_above', triggerPx: 1618 }, null)).toBeNull();
    expect(rungProximity({ triggerKind: 'price_above', triggerPx: 1618 }, 0)).toBeNull();
    expect(rungProximity({ triggerKind: 'volume', triggerPx: null }, 1611)).toBeNull();
  });
});

describe('buildLadderChartLines', () => {
  it('a lone rung uses plain ENTRY/STOP/TARGET labels', () => {
    const lines = buildLadderChartLines([longRung({ targetPx: 1780 })], 'ETH');
    expect(lines.map((l) => l.title)).toEqual(['ENTRY', 'STOP', 'TARGET']);
    expect(lines.find((l) => l.role === 'trigger')?.price).toBe(1618);
  });

  it('multiple rungs carry the seq tag so levels are distinguishable', () => {
    const lines = buildLadderChartLines(
      [longRung(), longRung({ id: 'r2', seq: 2, action: 'add', triggerPx: 1700 })],
      'ETH',
    );
    expect(lines.some((l) => l.title === 'R1 ▲')).toBe(true);
    expect(lines.some((l) => l.title === 'R2 ▲')).toBe(true);
    expect(lines.some((l) => l.title === 'R1 stop')).toBe(true);
  });

  it('only overlays rungs for the requested coin', () => {
    const lines = buildLadderChartLines(
      [longRung(), longRung({ id: 'r2', seq: 2, coin: 'BTC', triggerPx: 63000 })],
      'ETH',
    );
    expect(lines.every((l) => l.price < 5000)).toBe(true); // no BTC level leaked in
  });
});

describe('buildArmedEntryLines', () => {
  it('returns one tagged line per armed PENDING open rung on the coin', () => {
    const ladders = [
      { id: '2c0c5028-aaaa', rungs: [longRung({ side: 'short', triggerKind: 'price_below', triggerPx: 1544 })] },
      { id: '1c51446c-bbbb', rungs: [longRung({ triggerKind: 'price_above', triggerPx: 1640 })] },
    ];
    const lines = buildArmedEntryLines(ladders, 'ETH');
    expect(lines.map((l) => ({ px: l.price, side: l.side, dir: l.dir, id: l.ladderId8, title: l.title }))).toEqual([
      { px: 1544, side: 'short', dir: 'down', id: '2c0c5028', title: '⚡2c0c5028 ▼' },
      { px: 1640, side: 'long', dir: 'up', id: '1c51446c', title: '⚡1c51446c ▲' },
    ]);
  });

  it('excludes add/reduce rungs, non-pending rungs, and other coins', () => {
    const ladders = [{ id: 'abcd1234', rungs: [
      longRung({ id: 'a', action: 'open', status: 'fired' }),                       // not pending
      longRung({ id: 'b', action: 'add', triggerPx: 1700 }),                        // not an open
      longRung({ id: 'c', action: 'open', coin: 'BTC', triggerPx: 63000 }),         // other coin
      longRung({ id: 'd', action: 'open', triggerPx: 1620 }),                       // ✓ the only one
    ] }];
    const lines = buildArmedEntryLines(ladders, 'ETH');
    expect(lines).toHaveLength(1);
    expect(lines[0].price).toBe(1620);
  });
});

describe('expiryReadout', () => {
  const NOW = Date.parse('2026-07-01T00:00:00Z');
  const at = (ms: number) => new Date(NOW + ms).toISOString();

  it('compact units: days ≥48h, hours ≥90m, else minutes', () => {
    expect(expiryReadout(at(72 * 3_600_000), NOW)).toEqual({ text: 'expires in 3d', urgency: 'ok' });
    expect(expiryReadout(at(14 * 3_600_000), NOW)).toEqual({ text: 'expires in 14h', urgency: 'ok' });
    expect(expiryReadout(at(45 * 60_000), NOW)).toEqual({ text: 'expires in 45m', urgency: 'warn' });
  });

  it('warns inside the final 6h and flags EXPIRED past due', () => {
    expect(expiryReadout(at(5 * 3_600_000), NOW)?.urgency).toBe('warn');
    expect(expiryReadout(at(-1), NOW)).toEqual({ text: 'EXPIRED', urgency: 'expired' });
  });

  it('null for missing/unparseable expiry', () => {
    expect(expiryReadout(null, NOW)).toBeNull();
    expect(expiryReadout('not-a-date', NOW)).toBeNull();
  });
});
