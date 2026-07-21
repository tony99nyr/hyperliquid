import { describe, it, expect } from 'vitest';
import { reversionSignal, DEFAULT_REVERSION_CONFIG, type RevBar, type ReversionConfig } from '@/lib/scout/reversion-signal-business-logic';

const cfg: ReversionConfig = { ...DEFAULT_REVERSION_CONFIG, volLookback: 40, moveBars: 8, regimeBars: 48 };

/** Build a flat-ish base (small alternating wiggles = range) then an optional stretch. */
function series(baseN: number, wiggle: number, stretchFrac: number, stretchBars: number): RevBar[] {
  const bars: RevBar[] = [];
  let p = 100;
  for (let i = 0; i < baseN; i++) {
    p = 100 + (i % 2 === 0 ? wiggle : -wiggle); // oscillate = choppy/range
    bars.push({ highPx: p + 0.05, lowPx: p - 0.05, closePx: p });
  }
  // A clean directional stretch over the last stretchBars.
  const start = bars[bars.length - 1].closePx;
  for (let i = 1; i <= stretchBars; i++) {
    const c = start * (1 + (stretchFrac * i) / stretchBars);
    bars.push({ highPx: c + 0.05, lowPx: c - 0.05, closePx: c });
  }
  return bars;
}

describe('reversionSignal', () => {
  it('returns null on insufficient data', () => {
    expect(reversionSignal([{ highPx: 1, lowPx: 1, closePx: 1 }], cfg)).toBeNull();
  });

  it('a big up-stretch in a range regime fires a SHORT fade with stop above the extreme', () => {
    const bars = series(60, 0.3, 0.06, cfg.moveBars); // ~6% pop after choppy range
    const sig = reversionSignal(bars, cfg);
    expect(sig).not.toBeNull();
    expect(sig!.side).toBe('short');
    expect(sig!.zScore).toBeGreaterThan(cfg.minZ);
    expect(sig!.stopPx).toBeGreaterThan(sig!.markPx); // stop above for a short
    expect(sig!.targetPx).toBeLessThan(sig!.markPx); // target below (reversion)
    expect(sig!.efficiency).toBeLessThanOrEqual(cfg.maxEfficiency);
    expect(sig!.stopFrac).toBeGreaterThan(0);
  });

  it('a down-stretch fires a LONG fade (mirror)', () => {
    const bars = series(60, 0.3, -0.06, cfg.moveBars);
    const sig = reversionSignal(bars, cfg);
    expect(sig!.side).toBe('long');
    expect(sig!.stopPx).toBeLessThan(sig!.markPx);
    expect(sig!.targetPx).toBeGreaterThan(sig!.markPx);
  });

  it('a normal-sized move (below the z threshold) does NOT fire', () => {
    const bars = series(60, 0.3, 0.005, cfg.moveBars); // tiny drift, below z threshold
    expect(reversionSignal(bars, cfg)).toBeNull();
  });

  it('an extreme move in a TRENDING regime is skipped (efficiency gate)', () => {
    // A persistent one-directional grind = high efficiency ratio = trend, not range.
    const bars: RevBar[] = [];
    let p = 100;
    for (let i = 0; i < 70; i++) {
      p *= 1.004; // steady climb every bar → efficiency ≈ 1
      bars.push({ highPx: p + 0.05, lowPx: p - 0.05, closePx: p });
    }
    const sig = reversionSignal(bars, cfg);
    expect(sig).toBeNull(); // stretched, but trending → fading would lose → skip
  });

  it('flat data (zero vol) returns null, never divides by zero', () => {
    const flat = Array.from({ length: 70 }, () => ({ highPx: 100, lowPx: 100, closePx: 100 }));
    expect(reversionSignal(flat, cfg)).toBeNull();
  });

  it('a confident higher-TF TREND rejects the fade even when local structure is rangey', () => {
    const bars = series(60, 0.3, 0.06, cfg.moveBars); // fires without a regime
    expect(reversionSignal(bars, cfg)).not.toBeNull();
    // same bars, but the 4h background is a confident bull trend → do not fade
    expect(reversionSignal(bars, cfg, { regime: 'bullish', confidence: 0.9 })).toBeNull();
    expect(reversionSignal(bars, cfg, { regime: 'bearish', confidence: 0.7 })).toBeNull();
  });

  it('a NEUTRAL or LOW-confidence regime still allows the fade, and is echoed on the signal', () => {
    const bars = series(60, 0.3, 0.06, cfg.moveBars);
    const neutral = reversionSignal(bars, cfg, { regime: 'neutral', confidence: 0.9 });
    expect(neutral).not.toBeNull();
    expect(neutral!.regimeLabel).toBe('neutral');
    const weakTrend = reversionSignal(bars, cfg, { regime: 'bullish', confidence: 0.3 });
    expect(weakTrend).not.toBeNull(); // below maxTrendConfidence → not a gate
    expect(weakTrend!.regimeConfidence).toBe(0.3);
    // Boundary: confidence EXACTLY at maxTrendConfidence rejects (>=, not >).
    expect(reversionSignal(bars, cfg, { regime: 'bullish', confidence: cfg.maxTrendConfidence })).toBeNull();
  });

  it('omitting the regime falls back to efficiency-only and marks regimeLabel unknown', () => {
    const bars = series(60, 0.3, 0.06, cfg.moveBars);
    const sig = reversionSignal(bars, cfg);
    expect(sig!.regimeLabel).toBe('unknown');
    expect(sig!.regimeConfidence).toBe(0);
  });

});
