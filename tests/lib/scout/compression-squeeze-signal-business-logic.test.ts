import { describe, it, expect } from 'vitest';
import {
  compressionRead,
  compressionExitHit,
  DEFAULT_COMPRESSION_CONFIG,
  type SqueezeBar,
  type CompressionRead,
} from '@/lib/scout/compression-squeeze-signal-business-logic';

/** Bar with a symmetric ±range/2 around the close. */
function bar(close: number, range = 2): SqueezeBar {
  return { highPx: close + range / 2, lowPx: close - range / 2, closePx: close };
}

/**
 * A series that is VOLATILE early (wide BBW history) then COMPRESSES into a tight coil
 * (BBW collapses → bottom percentile), then optionally breaks out on the final close.
 * Volatile: closes oscillate 100±8; coil: 100±0.5.
 */
function volatileThenCoil(volatileLen: number, coilLen: number): SqueezeBar[] {
  const out: SqueezeBar[] = [];
  for (let i = 0; i < volatileLen; i++) out.push(bar(100 + (i % 2 === 0 ? 8 : -8), 4));
  for (let i = 0; i < coilLen; i++) out.push(bar(100 + (i % 2 === 0 ? 0.5 : -0.5), 1));
  return out;
}

describe('compressionRead — the frozen squeeze-breakout rule', () => {
  it('returns null when the series is too thin for the BBW percentile history', () => {
    expect(compressionRead(volatileThenCoil(30, 30))).toBeNull(); // < bbPeriod+bbwLookback
  });

  it('detects a squeeze after volatility collapses (BBW in the bottom percentile)', () => {
    const read = compressionRead(volatileThenCoil(100, 25));
    expect(read).not.toBeNull();
    expect(read!.inSqueeze).toBe(true);
    expect(read!.bbwPctile).toBeLessThanOrEqual(DEFAULT_COMPRESSION_CONFIG.squeezePctile);
  });

  it('does NOT flag a squeeze while volatility is normal', () => {
    // Uniformly volatile the whole way — current BBW sits mid-history, not bottom-20%.
    const read = compressionRead(volatileThenCoil(125, 0));
    expect(read).not.toBeNull();
    expect(read!.inSqueeze).toBe(false);
    expect(read!.breakout).toBeNull();
  });

  it('fires a LONG breakout when a squeezed coil resolves above the prior 20-bar high', () => {
    const bars = volatileThenCoil(100, 25);
    bars.push(bar(103, 2)); // break above the coil's ~100.75 highs (still inside grace)
    const read = compressionRead(bars);
    expect(read).not.toBeNull();
    expect(read!.breakout?.side).toBe('long');
    expect(read!.breakout?.entryPx).toBe(103);
    // Stop = prior-20-bar low (the coil's floor), capped at 4% — naturally tight here.
    expect(read!.breakout!.stopFrac).toBeLessThanOrEqual(DEFAULT_COMPRESSION_CONFIG.maxStopFrac);
    expect(read!.breakout!.stopPx).toBeLessThan(103);
    expect(read!.breakout!.exitBasisPx).toBe(read!.bbMid);
  });

  it('fires a SHORT breakout below the prior 20-bar low out of a squeeze', () => {
    const bars = volatileThenCoil(100, 25);
    bars.push(bar(97, 2));
    const read = compressionRead(bars);
    expect(read!.breakout?.side).toBe('short');
    expect(read!.breakout!.stopPx).toBeGreaterThan(97);
  });

  it('a 20-bar break WITHOUT a squeeze precondition does NOT fire (the whole point)', () => {
    // Volatile throughout (no compression), then a big break — trend-follow redux; must not fire.
    const bars = volatileThenCoil(125, 0);
    bars.push(bar(115, 4)); // above every prior high, but BBW never squeezed
    const read = compressionRead(bars);
    expect(read!.breakout).toBeNull();
  });

  it('caps the stop at maxStopFrac when the pre-break range is wide', () => {
    // Coil, then a break far above → raw range-edge stop would exceed 4% → capped.
    const bars = volatileThenCoil(100, 25);
    bars.push(bar(110, 2));
    const read = compressionRead(bars);
    expect(read!.breakout).not.toBeNull();
    expect(read!.breakout!.stopFrac).toBeCloseTo(DEFAULT_COMPRESSION_CONFIG.maxStopFrac, 10);
  });
});

describe('compressionExitHit — the mechanical mid-band exit', () => {
  const base: CompressionRead = {
    latestClose: 100,
    bbMid: 100,
    bbw: 0.02,
    bbwPctile: 0.5,
    inSqueeze: false,
    barsSinceSqueeze: null,
    don20High: 105,
    don20Low: 95,
    breakout: null,
  };

  it('exits a LONG when the 4h close crosses back below the BB mid', () => {
    expect(compressionExitHit({ ...base, latestClose: 99.5, bbMid: 100 }, 'long')).toBe(true);
    expect(compressionExitHit({ ...base, latestClose: 100.5, bbMid: 100 }, 'long')).toBe(false);
  });

  it('exits a SHORT when the 4h close crosses back above the BB mid', () => {
    expect(compressionExitHit({ ...base, latestClose: 100.5, bbMid: 100 }, 'short')).toBe(true);
    expect(compressionExitHit({ ...base, latestClose: 99.5, bbMid: 100 }, 'short')).toBe(false);
  });
});
