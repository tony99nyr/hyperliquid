/**
 * fetchSpotUsdcBalance — reads the SPOT side so account equity reflects USDC
 * parked in spot between trades (perp clearinghouseState reads $0 then). Real
 * transport memo (cleared per test) + mocked fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { _clearHlMemo, _clearInFlight } from '@/lib/hyperliquid/hl-cached-transport';
import { fetchSpotUsdcBalance } from '@/lib/hyperliquid/hyperliquid-info-service';

const ADDR = '0x7Ca0E770911DBf68EdC3b8B12829b272A1b4C177';

function mockFetch(body: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body } as Response);
}

beforeEach(() => {
  _clearHlMemo();
  _clearInFlight();
});
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
