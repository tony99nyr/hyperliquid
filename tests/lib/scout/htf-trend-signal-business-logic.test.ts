import { describe, it, expect } from 'vitest';
import {
  htfTrendRead,
  htfTrendExitHit,
  DEFAULT_HTF_TREND_CONFIG,
  type HtfBar,
  type HtfTrendRead,
} from '@/lib/scout/htf-trend-signal-business-logic';

/** Build a bar with a symmetric ±`range/2` high/low around each close. */
function bars(closes: number[], range = 2): HtfBar[] {
  return closes.map((c) => ({ highPx: c + range / 2, lowPx: c - range / 2, closePx: c }));
}

/** A flat 100 baseline of `len` bars, then a final `last` close (with a wide bar so ATR>0). */
function baselineThen(len: number, last: number, lastRange = 4): HtfBar[] {
  const b = bars(Array.from({ length: len }, () => 100));
  b.push({ highPx: last + lastRange / 2, lowPx: last - lastRange / 2, closePx: last });
  return b;
}

describe('htfTrendRead — the frozen daily Donchian rule', () => {
  it('returns null when the series is too thin to form every window', () => {
    expect(htfTrendRead(bars([100, 101, 102]))).toBeNull(); // < need (22)
  });

  it('fires a LONG breakout when the daily close prints above the prior 20-day high', () => {
    const read = htfTrendRead(baselineThen(23, 105));
    expect(read).not.toBeNull();
    expect(read!.don20High).toBe(100);
    expect(read!.breakout?.side).toBe('long');
    expect(read!.breakout?.entryPx).toBe(105); // entry = the completed close that broke out
  });

  it('fires a SHORT breakout when the daily close prints below the prior 20-day low', () => {
    const read = htfTrendRead(baselineThen(23, 95));
    expect(read!.don20Low).toBe(100);
    expect(read!.breakout?.side).toBe('short');
    expect(read!.breakout?.entryPx).toBe(95);
  });

  it('does NOT fire inside the channel (no breakout)', () => {
    // priors range 98..102, current 100 → within [don20Low, don20High] → null breakout
    const closes = Array.from({ length: 23 }, (_, i) => 98 + (i % 5)); // 98..102 repeating
    const b = bars(closes);
    b.push({ highPx: 101, lowPx: 99, closePx: 100 });
    const read = htfTrendRead(b);
    expect(read!.breakout).toBeNull();
  });

  it('channels EXCLUDE the current bar (the close genuinely breaks through)', () => {
    const read = htfTrendRead(baselineThen(23, 105));
    // don20High is 100 (the priors), not 105 (the current) — else no close could ever break.
    expect(read!.don20High).toBe(100);
    expect(read!.latestClose).toBe(105);
  });

  it('sizes the stop off 2×ATR and caps it at maxStopFrac (12%)', () => {
    // A monstrous breakout-bar range → 2×ATR/entry would exceed 12% → capped.
    const b = baselineThen(23, 105);
    b[b.length - 1] = { highPx: 260, lowPx: 40, closePx: 105 }; // TR ~220
    const read = htfTrendRead(b);
    expect(read!.breakout!.stopFrac).toBeCloseTo(DEFAULT_HTF_TREND_CONFIG.maxStopFrac, 10);
    expect(read!.breakout!.stopPx).toBeCloseTo(105 * (1 - 0.12), 6); // long stop below entry
  });

  it('sets exitPx to the OPPOSITE 10-day channel (long → 10-day low, short → 10-day high)', () => {
    const longRead = htfTrendRead(baselineThen(23, 105));
    expect(longRead!.breakout!.exitPx).toBe(longRead!.don10Low);
    const shortRead = htfTrendRead(baselineThen(23, 95));
    expect(shortRead!.breakout!.exitPx).toBe(shortRead!.don10High);
  });

  it('no breakout when ATR is zero (a perfectly flat, rangeless series)', () => {
    const flat: HtfBar[] = Array.from({ length: 24 }, () => ({ highPx: 100, lowPx: 100, closePx: 100 }));
    const read = htfTrendRead(flat);
    expect(read!.breakout).toBeNull(); // close == channel, and atr 0 — never fires
  });
});

describe('htfTrendExitHit — the mechanical 10-day-channel exit', () => {
  const base: HtfTrendRead = {
    latestClose: 100,
    don20High: 110,
    don20Low: 90,
    don10High: 105,
    don10Low: 95,
    atr: 3,
    breakout: null,
  };

  it('exits a LONG when the daily close breaks below the 10-day low', () => {
    expect(htfTrendExitHit({ ...base, latestClose: 94 }, 'long')).toBe(true);
    expect(htfTrendExitHit({ ...base, latestClose: 96 }, 'long')).toBe(false);
  });

  it('exits a SHORT when the daily close breaks above the 10-day high', () => {
    expect(htfTrendExitHit({ ...base, latestClose: 106 }, 'short')).toBe(true);
    expect(htfTrendExitHit({ ...base, latestClose: 104 }, 'short')).toBe(false);
  });
});
