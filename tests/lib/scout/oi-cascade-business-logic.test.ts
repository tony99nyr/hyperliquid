import { describe, it, expect } from 'vitest';
import { detectOiCascades, DEFAULT_OI_CASCADE_CONFIG, type OiAnchor } from '@/lib/scout/oi-cascade-business-logic';

const NOW = 1_787_400_000_000;
const MIN = 60_000;
const anchor = (oi: number, px: number, ageMin = 10): OiAnchor => ({ oi, px, atMs: NOW - ageMin * MIN });

describe('detectOiCascades — the watchable liquidation signature', () => {
  it('first sight of a coin just anchors (no event)', () => {
    const r = detectOiCascades({}, [{ coin: 'BTC', oi: 10_000, px: 70_000 }], NOW);
    expect(r.events).toEqual([]);
    expect(r.nextAnchors.BTC).toEqual({ oi: 10_000, px: 70_000, atMs: NOW });
  });

  it('SHORT-SQUEEZE: price up ≥1.5% while OI drops ≥3% (the $1.45B-shorts shape)', () => {
    const r = detectOiCascades({ BTC: anchor(10_000, 70_000) }, [{ coin: 'BTC', oi: 9_500, px: 72_000 }], NOW);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].kind).toBe('short-squeeze');
    expect(r.events[0].oiDropFrac).toBeCloseTo(0.05, 5);
    expect(r.events[0].detail).toMatch(/OI −5\.0%/);
    expect(r.nextAnchors.BTC.atMs).toBe(NOW); // re-anchored post-event
  });

  it('LONG-FLUSH: price down hard with OI down hard', () => {
    const r = detectOiCascades({ SOL: anchor(50_000, 90) }, [{ coin: 'SOL', oi: 47_000, px: 87 }], NOW);
    expect(r.events[0]?.kind).toBe('long-flush');
  });

  it('no event when OI drops without a price move (position migration, not a cascade)…', () => {
    const r = detectOiCascades({ BTC: anchor(10_000, 70_000) }, [{ coin: 'BTC', oi: 9_400, px: 70_100 }], NOW);
    expect(r.events).toEqual([]);
    expect(r.nextAnchors.BTC.atMs).toBe(NOW - 10 * MIN); // anchor KEPT (still accumulating)
  });

  it('…or a price move with RISING OI (fresh positioning, not liquidations)', () => {
    const r = detectOiCascades({ BTC: anchor(10_000, 70_000) }, [{ coin: 'BTC', oi: 10_600, px: 72_500 }], NOW);
    expect(r.events).toEqual([]);
  });

  it('re-anchors after the rolling window without an event', () => {
    const stale = { BTC: anchor(10_000, 70_000, 46) }; // > 45min window
    const r = detectOiCascades(stale, [{ coin: 'BTC', oi: 9_500, px: 72_000 }], NOW);
    expect(r.events).toEqual([]); // stale anchor discarded, not fired against
    expect(r.nextAnchors.BTC.atMs).toBe(NOW);
  });

  it('degenerate inputs never fire (zero OI/px)', () => {
    const r = detectOiCascades({ BTC: anchor(10_000, 70_000) }, [{ coin: 'BTC', oi: 0, px: 72_000 }], NOW);
    expect(r.events).toEqual([]);
    expect(r.nextAnchors.BTC).toBeUndefined(); // no false carry
    expect(DEFAULT_OI_CASCADE_CONFIG.minOiDropFrac).toBe(0.03); // the documented bar
  });

  it('a multi-tick cascade ACCUMULATES against the standing anchor', () => {
    // tick 1: −1.6% OI, +0.8% px — below both bars → anchor kept
    const t1 = detectOiCascades({ ETH: anchor(100_000, 2300) }, [{ coin: 'ETH', oi: 98_400, px: 2318 }], NOW);
    expect(t1.events).toEqual([]);
    // tick 2 vs the SAME anchor: cumulative −4% OI, +2% px → fires
    const t2 = detectOiCascades(t1.nextAnchors, [{ coin: 'ETH', oi: 96_000, px: 2346 }], NOW + 2 * MIN);
    expect(t2.events[0]?.kind).toBe('short-squeeze');
  });
});
