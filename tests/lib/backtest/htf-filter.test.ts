import { describe, it, expect } from 'vitest';
import { htfDirAt, htfVetoes } from '@/lib/backtest/backtest-replay-service';

describe('htfDirAt — point-in-time higher-TF regime (no look-ahead)', () => {
  const series = [
    { closeTime: 1000, dir: 'bullish' },
    { closeTime: 2000, dir: 'neutral' },
    { closeTime: 3000, dir: 'bearish' },
  ];
  it('returns the last CLOSED htf bar at/before t', () => {
    expect(htfDirAt(series, 2500)).toBe('neutral');
    expect(htfDirAt(series, 3000)).toBe('bearish'); // inclusive of the close instant
  });
  it('returns neutral before the first close (nothing known yet)', () => {
    expect(htfDirAt(series, 500)).toBe('neutral');
  });
  it('does NOT peek at a bar that has not closed by t', () => {
    expect(htfDirAt(series, 2999)).toBe('neutral'); // the bearish bar closes at 3000
  });
});

describe('htfVetoes — trend-filter decision', () => {
  it("'agree' mode: blocks unless htf MATCHES (neutral blocks)", () => {
    expect(htfVetoes('bullish', 'bullish', 'agree')).toBe(false);
    expect(htfVetoes('neutral', 'bullish', 'agree')).toBe(true);
    expect(htfVetoes('bearish', 'bullish', 'agree')).toBe(true);
  });
  it("'non-opposing' mode: blocks ONLY a direct opposite (neutral allowed)", () => {
    expect(htfVetoes('bullish', 'bullish', 'non-opposing')).toBe(false);
    expect(htfVetoes('neutral', 'bullish', 'non-opposing')).toBe(false);
    expect(htfVetoes('bearish', 'bullish', 'non-opposing')).toBe(true);
    expect(htfVetoes('bullish', 'bearish', 'non-opposing')).toBe(true);
  });
});
