import { describe, it, expect } from 'vitest';
import { completedDailySeries, htfDailyRead, htfExitIndicators, DAY_MS, HTF_BARS_REQUIRED, utcDayStart, type DailyCandle } from '@/lib/ladder/ladder-htf-exit-business-logic';
import { HTF_CHANNEL_EXIT_LONG, HTF_CHANNEL_EXIT_SHORT } from '@/lib/ladder/ladder-types';

const NOW = Date.UTC(2026, 10, 14, 12);
function candles(count = 25): DailyCandle[] {
  return Array.from({ length: count }, (_, i) => ({ timestamp: utcDayStart(NOW) - (count - i) * DAY_MS, high: 102 + i, low: 98 + i, close: 100 + i }));
}

describe('completedDailySeries', () => {
  it('drops an in-progress bar by its open timestamp and reports the UTC close', () => {
    const bars = candles();
    bars.push({ timestamp: utcDayStart(NOW), high: 999, low: 1, close: 500 });
    const result = completedDailySeries(bars, NOW)!;
    expect(result.signalCloseMs).toBe(utcDayStart(NOW));
    expect(result.bars.at(-1)?.closePx).toBe(124);
  });
  it('keeps the newest completed bar when the in-progress bar is absent', () => {
    const result = completedDailySeries(candles(), NOW)!;
    expect(result.bars.at(-1)?.closePx).toBe(124);
  });
  it('includes a candle that closes exactly at now and excludes one that closes 1 ms later', () => {
    const now = utcDayStart(NOW);
    const exact = candles();
    exact[exact.length - 1].timestamp = now - DAY_MS;
    expect(completedDailySeries(exact, now)?.bars.at(-1)?.closePx).toBe(exact[exact.length - 1].close);
    const late = candles();
    late[late.length - 1].timestamp = now - DAY_MS + 1;
    expect(completedDailySeries(late, now)).toBeNull();
  });
  it('rejects feed lag, thin, gapped, duplicated, malformed and invalid-time series', () => {
    const base = candles();
    expect(completedDailySeries(base.slice(0, -1), NOW)).toBeNull();
    expect(completedDailySeries(base.slice(4), NOW)).toBeNull();
    const missing = candles(); missing.splice(6, 1);
    expect(completedDailySeries(missing, NOW)).toBeNull();
    const duplicate = candles(); duplicate[8].timestamp = duplicate[7].timestamp;
    expect(completedDailySeries(duplicate, NOW)).toBeNull();
    for (const bad of [{ high: NaN }, { low: Infinity }, { close: 0 }, { high: -1 }, { high: 1, low: 2 }]) {
      const malformed = candles(); Object.assign(malformed.at(-1)!, bad);
      expect(completedDailySeries(malformed, NOW)).toBeNull();
    }
    expect(completedDailySeries(base, NaN)).toBeNull();
    expect(completedDailySeries(base, 0)).toBeNull();
  });
  it('sorts input and returns only the checked tail', () => {
    const sorted = candles(30);
    const shuffled = [...sorted].reverse();
    expect(completedDailySeries(shuffled, NOW)).toEqual(completedDailySeries(sorted, NOW));
    expect(completedDailySeries(sorted, NOW)?.bars).toHaveLength(HTF_BARS_REQUIRED);
  });
});

describe('daily read and exit indicators', () => {
  it('reads long and short breakouts, and returns no breakout for a flat close', () => {
    const long = candles(22); long.at(-1)!.close = 200;
    const short = candles(22); short.at(-1)!.close = 1;
    const flat = candles(22); flat.at(-1)!.close = 110;
    expect(htfDailyRead(long, NOW)?.read.breakout?.side).toBe('long');
    expect(htfDailyRead(short, NOW)?.read.breakout?.side).toBe('short');
    expect(htfDailyRead(flat, NOW)?.read.breakout).toBeNull();
  });
  it('returns the two channel indicators from the latest close', () => {
    const read = { latestClose: 5, don20High: 10, don20Low: 2, don10High: 9, don10Low: 6, atr: 1, breakout: null };
    expect(htfExitIndicators(read)).toEqual({ [HTF_CHANNEL_EXIT_LONG]: 1, [HTF_CHANNEL_EXIT_SHORT]: 0 });
    expect(htfExitIndicators({ ...read, latestClose: 11 })).toEqual({ [HTF_CHANNEL_EXIT_LONG]: 0, [HTF_CHANNEL_EXIT_SHORT]: 1 });
    expect(htfExitIndicators({ ...read, latestClose: 7 })).toEqual({ [HTF_CHANNEL_EXIT_LONG]: 0, [HTF_CHANNEL_EXIT_SHORT]: 0 });
  });
});
