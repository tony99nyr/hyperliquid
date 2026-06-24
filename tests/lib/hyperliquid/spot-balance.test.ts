/**
 * fetchSpotUsdcBalance — reads the SPOT side so account equity reflects USDC
 * parked in spot between trades (perp clearinghouseState reads $0 then). Mocked
 * Data Cache + fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const dataCacheStore = new Map<string, { value: unknown; expiresAt: number }>();
vi.mock('next/cache', () => ({
  unstable_cache: (fn: () => Promise<unknown>, keyParts: string[], opts: { revalidate: number }) => {
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

import { fetchSpotUsdcBalance } from '@/lib/hyperliquid/hyperliquid-info-service';

const ADDR = '0x7Ca0E770911DBf68EdC3b8B12829b272A1b4C177';

function mockFetch(body: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body } as Response);
}

beforeEach(() => dataCacheStore.clear());
afterEach(() => vi.restoreAllMocks());

describe('fetchSpotUsdcBalance', () => {
  it('sums the USDC spot balance (the real-world flat-in-spot case)', async () => {
    vi.stubGlobal('fetch', mockFetch({ balances: [{ coin: 'USDC', total: '141.223385' }, { coin: 'USDE', total: '0.0' }] }));
    expect(await fetchSpotUsdcBalance(ADDR)).toBeCloseTo(141.223385, 6);
  });

  it('returns 0 for a reachable but empty spot wallet (not null)', async () => {
    vi.stubGlobal('fetch', mockFetch({ balances: [] }));
    expect(await fetchSpotUsdcBalance(ADDR)).toBe(0);
  });

  it('ignores non-USDC stablecoins', async () => {
    vi.stubGlobal('fetch', mockFetch({ balances: [{ coin: 'USDT0', total: '50' }, { coin: 'USDC', total: '10' }] }));
    expect(await fetchSpotUsdcBalance(ADDR)).toBe(10);
  });

  it('returns null for an invalid address (no fetch)', async () => {
    const f = mockFetch({ balances: [] });
    vi.stubGlobal('fetch', f);
    expect(await fetchSpotUsdcBalance('not-an-address')).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('returns null on a garbage 200 body (soft failure, no balances array)', async () => {
    vi.stubGlobal('fetch', mockFetch({}));
    expect(await fetchSpotUsdcBalance(ADDR)).toBeNull();
  });

  it('returns null on a transport error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    expect(await fetchSpotUsdcBalance(ADDR)).toBeNull();
  });
});
