import { describe, it, expect } from 'vitest';
import {
  parseCandle,
  parseCandleSnapshot,
  candleCacheKey,
  bucketTime,
  INTERVAL_MS,
  isSupportedInterval,
  SUPPORTED_INTERVALS,
  type RawHlCandle,
} from '@/lib/hyperliquid/candle-service-business-logic';

const row = (over: Partial<RawHlCandle> = {}): RawHlCandle => ({
  t: 1_700_000_000_000,
  T: 1_700_000_059_999,
  s: 'ETH',
  i: '1h',
  o: '2000',
  h: '2010',
  l: '1995',
  c: '2005',
  v: '12.5',
  n: 42,
  ...over,
});

describe('candle-service-business-logic', () => {
  describe('parseCandle', () => {
    it('parses string OHLCV into a typed PriceCandle with hyperliquid source', () => {
      const c = parseCandle(row());
      expect(c).toEqual({
        timestamp: 1_700_000_000_000,
        open: 2000,
        high: 2010,
        low: 1995,
        close: 2005,
        volume: 12.5,
        source: 'hyperliquid',
      });
    });

    it('accepts numeric fields too', () => {
      const c = parseCandle(row({ o: 1, h: 2, l: 0.5, c: 1.5, v: 3, t: 100 }));
      expect(c?.open).toBe(1);
      expect(c?.timestamp).toBe(100);
    });

    it('defaults volume to 0 when missing/invalid', () => {
      expect(parseCandle(row({ v: undefined }))?.volume).toBe(0);
      expect(parseCandle(row({ v: 'NaN' }))?.volume).toBe(0);
    });

    it('returns null when timestamp is missing', () => {
      expect(parseCandle(row({ t: undefined }))).toBeNull();
    });

    it('returns null when an OHLC value is non-finite', () => {
      expect(parseCandle(row({ c: 'abc' }))).toBeNull();
      expect(parseCandle(row({ o: undefined }))).toBeNull();
    });
  });

  describe('parseCandleSnapshot', () => {
    it('returns [] for non-arrays', () => {
      expect(parseCandleSnapshot(null)).toEqual([]);
      expect(parseCandleSnapshot({})).toEqual([]);
    });

    it('drops malformed rows', () => {
      const out = parseCandleSnapshot([row(), { t: undefined }, row({ t: 200 })]);
      expect(out).toHaveLength(2);
    });

    it('sorts ascending by timestamp', () => {
      const out = parseCandleSnapshot([row({ t: 300 }), row({ t: 100 }), row({ t: 200 })]);
      expect(out.map((c) => c.timestamp)).toEqual([100, 200, 300]);
    });

    it('de-duplicates by timestamp keeping the last (still-forming candle)', () => {
      const out = parseCandleSnapshot([
        row({ t: 100, c: '2000' }),
        row({ t: 100, c: '2099' }), // updated last candle
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].close).toBe(2099);
    });
  });

  describe('intervals + cache key', () => {
    it('recognizes the supported intervals', () => {
      for (const i of SUPPORTED_INTERVALS) expect(isSupportedInterval(i)).toBe(true);
      // 5m / 1m / 4h are now supported (the chart timeframe selector). Assert on
      // an interval HL doesn't expose to this app.
      expect(isSupportedInterval('30m')).toBe(false);
      expect(isSupportedInterval('5m')).toBe(true);
    });

    it('builds a stable upper-cased, interval-bucketed cache key', () => {
      // 100/200 ms both floor to the 0 bucket at the 1h period.
      expect(candleCacheKey('eth', '1h', 100, 200)).toBe('ETH:1h:0:0');
    });
  });

  describe('bucketTime + cache-key bucketing (FIX 2)', () => {
    it('floors a timestamp to the start of its interval bucket', () => {
      const h = INTERVAL_MS['1h'];
      expect(bucketTime(0, '1h')).toBe(0);
      expect(bucketTime(h - 1, '1h')).toBe(0);
      expect(bucketTime(h, '1h')).toBe(h);
      expect(bucketTime(h + 123, '1h')).toBe(h);
    });

    it('two near-but-distinct now-derived windows in the same bucket → same key', () => {
      const base = 1_700_000_000_000;
      // Two ticks ~1s apart: distinct raw bounds, identical bucketed key.
      const k1 = candleCacheKey('ETH', '15m', base - 1000, base);
      const k2 = candleCacheKey('ETH', '15m', base - 1000 + 1000, base + 1000);
      expect(k1).toBe(k2);
    });

    it('windows crossing a bucket boundary → different keys', () => {
      const m15 = INTERVAL_MS['15m'];
      const a = candleCacheKey('ETH', '15m', 0, m15 - 1); // end bucket 0
      const b = candleCacheKey('ETH', '15m', 0, m15); // end bucket 1
      expect(a).not.toBe(b);
    });
  });
});
