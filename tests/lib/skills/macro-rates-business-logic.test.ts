import { describe, it, expect } from 'vitest';
import { parseFredCsv, ratesRead, ratesLine, liquidityDashboard, liquidityLine } from '@/lib/skills/macro-rates-business-logic';

const csv = (rows: Array<[string, string]>): string =>
  'DATE,DGS30\n' + rows.map((r) => r.join(',')).join('\n');

describe('parseFredCsv', () => {
  it('parses points and skips holiday dots + garbage', () => {
    const pts = parseFredCsv(csv([['2026-08-14', '5.25'], ['2026-08-15', '.'], ['2026-08-17', '5.31'], ['', ''], ['2026-08-18', '5.28']]));
    expect(pts.map((p) => p.yieldPct)).toEqual([5.25, 5.31, 5.28]);
  });
});

describe('ratesRead — the fiscal barometer fold', () => {
  const flat = (n: number, y = 5.0) => Array.from({ length: n }, (_, i) => ({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, yieldPct: y }));

  it('null when too thin', () => {
    expect(ratesRead(flat(5))).toBeNull();
  });

  it('quiet/neutral on a flat tape', () => {
    const r = ratesRead(flat(10))!;
    expect(r.magnitude).toBe('quiet');
    expect(r.riskSignal).toBe('neutral');
  });

  it('a ≥15bp 1d SPIKE flags macro-move + risk-off pressure (the Aug-18 shape)', () => {
    const pts = [...flat(8, 5.15), { date: '2026-08-17', yieldPct: 5.34 }];
    const r = ratesRead(pts)!;
    expect(r.d1Bp).toBe(19);
    expect(r.magnitude).toBe('macro-move');
    expect(r.riskSignal).toBe('risk-off-pressure');
    expect(ratesLine(r)).toMatch(/risk-OFF/);
  });

  it('a hard PLUNGE flags macro-move + easing tailwind (the buyback-response shape)', () => {
    const pts = [...flat(8, 5.34), { date: '2026-08-19', yieldPct: 5.12 }];
    const r = ratesRead(pts)!;
    expect(r.d1Bp).toBe(-22);
    expect(r.riskSignal).toBe('easing-tailwind');
    expect(ratesLine(r)).toMatch(/risk-ON/);
  });

  it('a notable DOWN day is never labeled risk-off by an opposing 5d grind (review 08-20 M3)', () => {
    // d1 = −9bp (yields fell today), d5 = +20bp (last week ground up). The old blend
    // (−9 + 10 = +1) flagged risk-off on a down day; direction must follow the
    // horizon that made the move notable — here the 1d print is notable and DOWN.
    const pts = [
      { date: 'd1', yieldPct: 5.0 }, { date: 'd2', yieldPct: 5.1 }, { date: 'd3', yieldPct: 5.15 },
      { date: 'd4', yieldPct: 5.2 }, { date: 'd5', yieldPct: 5.29 }, { date: 'd6', yieldPct: 5.2 },
    ];
    const r = ratesRead(pts)!;
    expect(r.d1Bp).toBe(-9);
    expect(r.d5Bp).toBe(20);
    expect(r.magnitude).toBe('notable');
    expect(r.riskSignal).toBe('easing-tailwind'); // follows the notable 1d DOWN print
  });

  it('a slow 5d grind can reach notable without a big 1d print', () => {
    const pts = [
      { date: 'd1', yieldPct: 5.0 }, { date: 'd2', yieldPct: 5.05 }, { date: 'd3', yieldPct: 5.09 },
      { date: 'd4', yieldPct: 5.13 }, { date: 'd5', yieldPct: 5.16 }, { date: 'd6', yieldPct: 5.2 },
    ];
    const r = ratesRead(pts)!;
    expect(r.d5Bp).toBe(20);
    expect(r.magnitude).toBe('notable');
    expect(r.riskSignal).toBe('risk-off-pressure');
  });
});

describe('liquidityDashboard — yields × dollar × real rates (08-21)', () => {
  const mk = (vals: number[]) => vals.map((v, i) => ({ date: `d${i}`, yieldPct: v }));

  it('RISK-ON when yields, dollar and real rates all ease over 5d (this week´s shape)', () => {
    const y10 = mk([4.74, 4.73, 4.72, 4.72, 4.71, 4.65]); // −9bp 5d
    const dxy = mk([120.1, 120.0, 119.8, 119.4, 119.2, 119.1]); // −1.0 (−0.83%)
    const be = mk([2.3, 2.3, 2.3, 2.3, 2.3, 2.3]); // flat → real follows y10 down
    const d = liquidityDashboard(y10, dxy, be);
    expect(d.lean).toBe('risk-on');
    expect(d.realYieldPct).toBeCloseTo(2.35, 2);
    expect(liquidityLine(d)).toMatch(/RISK-ON/);
  });

  it('RISK-OFF on the opposite shape; MIXED on disagreement; NEUTRAL inside noise floors', () => {
    const up = mk([4.6, 4.62, 4.64, 4.68, 4.7, 4.74]);
    const dxyUp = mk([118, 118.2, 118.5, 118.8, 119.2, 119.5]);
    const beFlat = mk([2.3, 2.3, 2.3, 2.3, 2.3, 2.3]);
    expect(liquidityDashboard(up, dxyUp, beFlat).lean).toBe('risk-off');
    const down = mk([4.74, 4.72, 4.7, 4.68, 4.64, 4.6]);
    expect(liquidityDashboard(down, dxyUp, beFlat).lean).toBe('mixed');
    const flat = mk([4.7, 4.7, 4.7, 4.7, 4.7, 4.7]);
    const dxyFlat = mk([119, 119, 119, 119, 119, 119.1]);
    expect(liquidityDashboard(flat, dxyFlat, beFlat).lean).toBe('neutral');
  });

  it('degrades per-series: missing DXY still yields a partial read, all-missing is neutral+unavailable', () => {
    const y10 = mk([4.74, 4.73, 4.72, 4.72, 4.71, 4.65]);
    const d = liquidityDashboard(y10, [], mk([2.3, 2.3, 2.3, 2.3, 2.3, 2.3]));
    expect(d.dxy).toBeNull();
    expect(d.lean).toBe('risk-on'); // y10 + real both voted (2 components — enough for the full label)
    const empty = liquidityDashboard([], [], []);
    expect(empty.lean).toBe('neutral');
    expect(liquidityLine(empty)).toMatch(/unavailable/);
  });
});

describe('liquidityDashboard — partial-read honesty (review 08-21)', () => {
  const mk = (vals: number[]) => vals.map((v, i) => ({ date: `2026-08-${10 + i}`, yieldPct: v }));

  it('a SINGLE voting component is mixed, never a full risk-on/off call', () => {
    const y10 = mk([4.74, 4.73, 4.72, 4.72, 4.71, 4.65]); // only voter (be missing → no real vote)
    const d = liquidityDashboard(y10, [], []);
    expect(d.votesCast).toBe(1);
    expect(d.lean).toBe('mixed');
    expect(liquidityLine(d)).toMatch(/mixed \[\+1\/1 components\]/);
  });

  it('the line carries per-series as-of dates (mixed FRED lags must be visible)', () => {
    const y10 = mk([4.74, 4.73, 4.72, 4.72, 4.71, 4.65]);
    const dxy = mk([120.1, 120.0, 119.8, 119.4, 119.2, 119.1]);
    const be = mk([2.3, 2.3, 2.3, 2.3, 2.3, 2.3]);
    expect(liquidityLine(liquidityDashboard(y10, dxy, be))).toMatch(/10Y .*08-15.*DXY .*08-15/);
  });
});
