import { describe, it, expect } from 'vitest';
import { parseFredCsv, ratesRead, ratesLine } from '@/lib/skills/macro-rates-business-logic';

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
