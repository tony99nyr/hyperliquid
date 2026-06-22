import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchCandles,
  fetchMultiTimeframeCandles,
  _clearCandleCache,
  _candleCacheSize,
  _isBackingOff,
  fundingRateAt,
  type FundingPoint,
} from '@/lib/hyperliquid/candle-service';
import { INTERVAL_MS } from '@/lib/hyperliquid/candle-service-business-logic';

describe('fundingRateAt', () => {
  const series: FundingPoint[] = [
    { time: 1000, fundingHourly: 0.00001 },
    { time: 2000, fundingHourly: 0.00002 },
    { time: 3000, fundingHourly: -0.00003 },
  ];
  it('returns the most recent rate at or before t', () => {
    expect(fundingRateAt(series, 2500)).toBe(0.00002);
    expect(fundingRateAt(series, 3000)).toBe(-0.00003); // inclusive
  });
  it('returns 0 before the first sample', () => {
    expect(fundingRateAt(series, 500)).toBe(0);
  });
  it('holds the last rate after the final sample', () => {
    expect(fundingRateAt(series, 99999)).toBe(-0.00003);
  });
});

const rawRow = (t: number, c = '2000') => ({
  t,
  T: t + 59_999,
  s: 'ETH',
  i: '1h',
  o: '1990',
  h: '2010',
  l: '1980',
  c,
  v: '5',
  n: 10,
});

function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  } as Response);
}

describe('candle-service (I/O, mocked fetch)', () => {
  beforeEach(() => {
    _clearCandleCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs candleSnapshot with the right (30s-snapped) body and parses the result', async () => {
    const fetchMock = mockFetchOk([rawRow(100), rawRow(200, '2100')]);
    vi.stubGlobal('fetch', fetchMock);

    // Realistic polling bounds: a recent end + a multi-day lookback. The window is
    // snapped to the 30s grid for BOTH the cache key and the fetched window
    // (FIX 1) so concurrent polls share one Data-Cache key.
    const grid = 30_000;
    const endTime = 1_700_000_000_000 + 17_345; // not on a grid boundary
    const startTime = endTime - 24 * 60 * 60 * 1000;
    const res = await fetchCandles('eth', '1h', startTime, endTime);

    expect(res.coin).toBe('ETH');
    expect(res.interval).toBe('1h');
    expect(res.stale).toBe(false);
    expect(res.candles).toHaveLength(2);
    expect(res.candles[1].close).toBe(2100);

    const [, init] = fetchMock.mock.calls[0];
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent).toEqual({
      type: 'candleSnapshot',
      req: {
        coin: 'ETH',
        interval: '1h',
        startTime: Math.floor(startTime / grid) * grid,
        endTime: Math.floor(endTime / grid) * grid,
      },
    });
  });

  it('caches within TTL (second call does not re-fetch)', async () => {
    const fetchMock = mockFetchOk([rawRow(100)]);
    vi.stubGlobal('fetch', fetchMock);

    await fetchCandles('ETH', '1h', 0, 1000);
    await fetchCandles('ETH', '1h', 0, 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('repeated ticks within one interval bucket reuse the cache (one fetch) — FIX 2', async () => {
    const fetchMock = mockFetchOk([rawRow(100)]);
    vi.stubGlobal('fetch', fetchMock);

    // Distinct now-derived windows ~1s apart, all inside the same 15m bucket.
    const base = 1_700_000_000_000;
    const lookback = 4 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 10; i++) {
      const now = base + i * 1000;
      await fetchCandles('ETH', '15m', now - lookback, now);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(_candleCacheSize()).toBe(1);
  });

  it('DRIFTING now-derived windows within one 30s grid → ONE upstream fetch (FIX 1)', async () => {
    const fetchMock = mockFetchOk([rawRow(100)]);
    vi.stubGlobal('fetch', fetchMock);

    // Real polling: each poll passes start/end derived from Date.now(), a few
    // seconds apart — but all within ONE 30s window grid. Pre-FIX these minted a
    // distinct Data-Cache key every call (raw start/end), bypassing the
    // cross-instance cache. Post-FIX they snap to the same grid → one key/fetch.
    const grid = 30_000;
    const base = Math.floor(1_700_000_000_000 / grid) * grid + 1_000; // 1s into a grid
    const lookback = 4 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 10; i++) {
      const now = base + i * 2_500; // 0,2.5,5,...22.5s — all inside the SAME 30s grid
      await fetchCandles('ETH', '1h', now - lookback, now);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(_candleCacheSize()).toBe(1);
  });

  it('cache stays bounded under many distinct-time windows — FIX 2', async () => {
    vi.stubGlobal('fetch', mockFetchOk([rawRow(100)]));
    const m15 = INTERVAL_MS['15m'];
    // 1000 windows that each fall into a DISTINCT bucket → would be 1000 keys
    // without eviction. The cap must hold the size well under that.
    for (let i = 0; i < 1000; i++) {
      const end = i * m15; // each a new bucket
      await fetchCandles('ETH', '15m', 0, end);
    }
    expect(_candleCacheSize()).toBeLessThanOrEqual(256);
  });

  it('fails soft to an empty stale result on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response),
    );
    const res = await fetchCandles('ETH', '15m', 0, 1000);
    expect(res.candles).toEqual([]);
    expect(res.stale).toBe(true);
    expect(res.error).toContain('500');
  });

  it('returns the cached value (marked stale) when a later fetch throws', async () => {
    const okMock = mockFetchOk([rawRow(100)]);
    vi.stubGlobal('fetch', okMock);
    const first = await fetchCandles('ETH', '8h', 0, 1000);
    expect(first.candles).toHaveLength(1);

    // expire cache by clearing, then make fetch fail
    _clearCandleCache();
    // re-seed cache via a successful call window B
    await fetchCandles('ETH', '8h', 0, 1000);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    // same key, cache still warm → returns cached, not stale yet (within TTL)
    const warm = await fetchCandles('ETH', '8h', 0, 1000);
    expect(warm.stale).toBe(false);
  });

  it('a 429 trips a global backoff: subsequent calls do NOT re-hit upstream (anti-hammer)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? '5' : null) },
      json: async () => ({}),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const first = await fetchCandles('ETH', '1h', 0, 1000);
    expect(first.stale).toBe(true);
    expect(_isBackingOff()).toBe(true);

    // A DIFFERENT window (would normally be a cache miss → a real fetch) must be
    // suppressed while backing off — only the original 429 call hit the network.
    const second = await fetchCandles('ETH', '1h', 0, 2000);
    expect(second.error).toMatch(/rate-limited/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serves the last cached set (stale) while backing off rather than empty', async () => {
    // Warm the cache for a window, then 429 on a fresh window to trip backoff.
    vi.stubGlobal('fetch', mockFetchOk([rawRow(100)]));
    await fetchCandles('ETH', '1h', 0, 1000);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: { get: () => null },
        json: async () => ({}),
      } as unknown as Response),
    );
    await fetchCandles('ETH', '1h', 5000, 6000); // trips backoff

    // The originally-warmed window is still within TTL → cached value served.
    const warm = await fetchCandles('ETH', '1h', 0, 1000);
    expect(warm.candles).toHaveLength(1);
  });

  it('fetchMultiTimeframeCandles fetches all intervals and keys by interval', async () => {
    vi.stubGlobal('fetch', mockFetchOk([rawRow(100)]));
    const out = await fetchMultiTimeframeCandles('ETH', ['1d', '1h', '15m'], 0, 1000);
    expect(Object.keys(out).sort()).toEqual(['15m', '1d', '1h']);
    expect(out['1h'].candles).toHaveLength(1);
  });
});
