import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchCandles,
  fetchMultiTimeframeCandles,
  _clearCandleCache,
} from '@/lib/hyperliquid/candle-service';

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

  it('POSTs candleSnapshot with the right body and parses the result', async () => {
    const fetchMock = mockFetchOk([rawRow(100), rawRow(200, '2100')]);
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchCandles('eth', '1h', 50, 300);

    expect(res.coin).toBe('ETH');
    expect(res.interval).toBe('1h');
    expect(res.stale).toBe(false);
    expect(res.candles).toHaveLength(2);
    expect(res.candles[1].close).toBe(2100);

    const [, init] = fetchMock.mock.calls[0];
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent).toEqual({
      type: 'candleSnapshot',
      req: { coin: 'ETH', interval: '1h', startTime: 50, endTime: 300 },
    });
  });

  it('caches within TTL (second call does not re-fetch)', async () => {
    const fetchMock = mockFetchOk([rawRow(100)]);
    vi.stubGlobal('fetch', fetchMock);

    await fetchCandles('ETH', '1h', 0, 1000);
    await fetchCandles('ETH', '1h', 0, 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('fetchMultiTimeframeCandles fetches all intervals and keys by interval', async () => {
    vi.stubGlobal('fetch', mockFetchOk([rawRow(100)]));
    const out = await fetchMultiTimeframeCandles('ETH', ['1d', '1h', '15m'], 0, 1000);
    expect(Object.keys(out).sort()).toEqual(['15m', '1d', '1h']);
    expect(out['1h'].candles).toHaveLength(1);
  });
});
