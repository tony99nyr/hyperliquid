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

  it('candles: DRIFTING now-windows within one 30s grid across fresh instances → 1 upstream fetch (FIX 1)', async () => {
    const f = mockFetch([candleRow(100)]);
    vi.stubGlobal('fetch', f);

    // Real cross-instance polling: each poll uses Date.now()-derived bounds a few
    // seconds apart, AND we wipe the per-instance Map before each (simulating a
    // fresh serverless instance) so ONLY the shared Data Cache can collapse them.
    // Pre-FIX the raw start/end minted a new Data-Cache key per poll → every call
    // missed the cross-instance cache and hit HL. Post-FIX they share ONE key.
    const grid = 30_000;
    const base = Math.floor(1_700_000_000_000 / grid) * grid + 1_000;
    const lookback = 4 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 12; i++) {
      _clearCandleCacheMapOnly();
      const now = base + i * 2_000; // 0..22s — all inside the SAME 30s grid
      await fetchCandles('ETH', '1h', now - lookback, now);
    }
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

  it('regime set: ALL intervals fail → NOT cached (next call retries) — FIX 2', async () => {
    // Every candleSnapshot call returns a non-ok response → all 4 TFs fail → the
    // cached fn throws → unstable_cache does NOT memoize. The next call retries.
    const f = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as Response);
    vi.stubGlobal('fetch', f);

    const first = await fetchRegimeCandleSet('ETH', 1_700_000_000_000);
    expect(Object.values(first).every((r) => r.candles.length === 0)).toBe(true);
    const callsAfterFirst = f.mock.calls.length; // 4 failed attempts

    // Now HL recovers — because the empty set was NOT cached, this call re-fetches.
    f.mockResolvedValue({ ok: true, status: 200, json: async () => [candleRow(100)] } as Response);
    const second = await fetchRegimeCandleSet('ETH', 1_700_000_000_000);
    expect(f.mock.calls.length).toBeGreaterThan(callsAfterFirst); // retried, not served-from-cache
    expect(Object.values(second).some((r) => r.candles.length > 0)).toBe(true);
  });

  it('regime set: PARTIAL success (some intervals good) → cached — FIX 2', async () => {
    // 1d/8h ok, 1h/15m fail. The set has usable candles → it IS cacheable.
    // REGIME_TIMEFRAMES order is 1d, 8h, 1h, 15m.
    const ok = { ok: true, status: 200, json: async () => [candleRow(100)] } as Response;
    const bad = { ok: false, status: 500, json: async () => ({}) } as Response;
    const f = vi
      .fn()
      .mockResolvedValueOnce(ok) // 1d
      .mockResolvedValueOnce(ok) // 8h
      .mockResolvedValueOnce(bad) // 1h
      .mockResolvedValueOnce(bad) // 15m
      .mockResolvedValue(ok); // any later (should not happen if cached)
    vi.stubGlobal('fetch', f);

    const first = await fetchRegimeCandleSet('ETH', 1_700_000_000_000);
    expect(first['1d'].candles.length).toBe(1);
    expect(first['1h'].candles.length).toBe(0);
    const callsAfterFirst = f.mock.calls.length; // 4

    // Identical call: the partial set was cached → no new upstream fetches.
    await fetchRegimeCandleSet('ETH', 1_700_000_000_000);
    expect(f.mock.calls.length).toBe(callsAfterFirst);
  });

  it('allMids: empty `{}` soft-fail → THROWS (not cached); next call retries — FIX 3', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) } as Response)
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ ETH: '2000' }) } as Response);
    vi.stubGlobal('fetch', f);

    // fetchAllMids throws on failure by contract (caller fail-soft handles it).
    // The soft-empty result must THROW so unstable_cache never memoizes it.
    await expect(fetchAllMids()).rejects.toThrow(/soft failure/);
    // Because the throw was NOT cached, the next call retries and gets real data.
    const real = await fetchAllMids();
    expect(real.ETH).toBe(2000);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('clearinghouse: garbage `{}` (no marginSummary) soft-fail → NOT cached — FIX 3', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) } as Response)
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ assetPositions: [], marginSummary: { accountValue: '100' }, withdrawable: '50' }),
      } as Response);
    vi.stubGlobal('fetch', f);
    const addr = '0x' + 'b'.repeat(40);

    const soft = await fetchClearinghouseState(addr);
    expect(soft.error).toBeDefined(); // soft-fail surfaced to caller
    // Not memoized → retry gets the real account.
    const real = await fetchClearinghouseState(addr);
    expect(real.accountValueUsd).toBe(100);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('clearinghouse: legitimately-FLAT account (marginSummary present, zero value) IS cached — FIX 3', async () => {
    // A real but empty account: marginSummary present with accountValue '0', no
    // positions. This must NOT be treated as a soft-fail — it caches normally.
    const f = mockFetch({ assetPositions: [], marginSummary: { accountValue: '0' }, withdrawable: '0' });
    vi.stubGlobal('fetch', f);
    const addr = '0x' + 'c'.repeat(40);
    for (let i = 0; i < 5; i++) {
      const r = await fetchClearinghouseState(addr);
      expect(r.error).toBeUndefined();
      expect(r.accountValueUsd).toBe(0);
    }
    expect(f).toHaveBeenCalledTimes(1); // legit-empty cached → 1 fetch
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
