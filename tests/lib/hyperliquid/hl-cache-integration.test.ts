/**
 * End-to-end cache-collapse verification across the HL read services, with a
 * MOCKED Data Cache (mimicking Vercel's cross-instance unstable_cache) and a
 * mocked HL transport (`fetch`). Proves:
 *   - candles / regime / allMids / clearinghouseState collapse repeated reads to
 *     ≤1 upstream HL fetch per (key, TTL).
 *   - l2Book is NEVER cached (paper-fill execution path needs a fresh book).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the Data Cache (see hl-cached-transport.test.ts for rationale).
const dataCacheStore = new Map<string, { value: unknown; expiresAt: number }>();
vi.mock('next/cache', () => ({
  unstable_cache: (
    fn: () => Promise<unknown>,
    keyParts: string[],
    opts: { revalidate: number },
  ) => {
    const key = keyParts.join(' ');
    return async () => {
      const hit = dataCacheStore.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.value;
      const value = await fn();
      dataCacheStore.set(key, { value, expiresAt: Date.now() + opts.revalidate * 1000 });
      return value;
    };
  },
}));

import {
  fetchCandles,
  fetchRegimeCandleSet,
  _clearCandleCache,
  _clearCandleCacheMapOnly,
} from '@/lib/hyperliquid/candle-service';
import {
  fetchAllMids,
  fetchClearinghouseState,
  fetchL2Book,
} from '@/lib/hyperliquid/hyperliquid-info-service';

const candleRow = (t: number) => ({
  t,
  T: t + 59_999,
  s: 'ETH',
  i: '1h',
  o: '1990',
  h: '2010',
  l: '1980',
  c: '2000',
  v: '5',
  n: 10,
});

function mockFetch(body: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body } as Response);
}

beforeEach(() => {
  dataCacheStore.clear();
  _clearCandleCache();
});
afterEach(() => vi.restoreAllMocks());

describe('cross-instance cache collapse (mocked Data Cache + fetch)', () => {
  it('candles: 20 concurrent + 20 sequential same-window reads → 1 upstream fetch', async () => {
    const f = mockFetch([candleRow(100)]);
    vi.stubGlobal('fetch', f);

    // The per-instance Map collapses sequential calls; the Data Cache+coalesce
    // collapses concurrent calls. To isolate the cross-instance layer we clear the
    // per-instance Map between each call but keep the Data Cache warm.
    const concurrent = await Promise.all(
      Array.from({ length: 20 }, () => fetchCandles('ETH', '1h', 0, 1000)),
    );
    expect(concurrent.every((r) => r.candles.length === 1)).toBe(true);

    for (let i = 0; i < 20; i++) {
      _clearCandleCacheMapOnly();
      await fetchCandles('ETH', '1h', 0, 1000);
    }
    // Even after wiping the per-instance Map 20× (simulating fresh serverless
    // instances), the shared Data Cache served them → 1 upstream HL call total.
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('regime set: repeated coin reads → 4 upstream fetches (one per TF), cached after', async () => {
    const f = mockFetch([candleRow(100)]);
    vi.stubGlobal('fetch', f);

    await fetchRegimeCandleSet('ETH', 1_700_000_000_000);
    const callsAfterFirst = f.mock.calls.length; // 4 timeframes
    await fetchRegimeCandleSet('ETH', 1_700_000_000_000);
    await fetchRegimeCandleSet('ETH', 1_700_000_000_000);
    expect(callsAfterFirst).toBe(4);
    // Subsequent identical-coin sets served from the Data Cache: no new fetches.
    expect(f.mock.calls.length).toBe(4);
  });

  it('allMids: repeated reads → 1 upstream fetch', async () => {
    const f = mockFetch({ ETH: '2000', BTC: '60000' });
    vi.stubGlobal('fetch', f);
    for (let i = 0; i < 10; i++) await fetchAllMids();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('clearinghouseState: repeated same-address reads → 1 upstream fetch', async () => {
    const f = mockFetch({ assetPositions: [], marginSummary: { accountValue: '100' }, withdrawable: '50' });
    vi.stubGlobal('fetch', f);
    const addr = '0x' + 'a'.repeat(40);
    for (let i = 0; i < 10; i++) await fetchClearinghouseState(addr);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('l2Book is NEVER cached — every call hits upstream (fresh book guarantee)', async () => {
    const book = { coin: 'ETH', levels: [[{ px: '1999', sz: '2' }], [{ px: '2001', sz: '1' }]] };
    const f = mockFetch(book);
    vi.stubGlobal('fetch', f);
    await fetchL2Book('ETH');
    await fetchL2Book('ETH');
    await fetchL2Book('ETH');
    expect(f).toHaveBeenCalledTimes(3);
  });
});
