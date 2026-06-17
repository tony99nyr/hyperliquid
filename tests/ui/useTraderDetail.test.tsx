import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useTraderDetail } from '@/hooks/useTraderDetail';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';

function pos(over: Partial<HlPosition> = {}): HlPosition {
  return {
    coin: 'ETH', side: 'long', szi: 1, size: 1, entryPx: 2000, positionValue: 2000,
    unrealizedPnl: 50, returnOnEquity: 0.1, leverage: 5, leverageType: 'cross',
    liquidationPx: 1500, marginUsed: 400, maxLeverage: 25, ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useTraderDetail', () => {
  it('is inert with a null address (no fetch)', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { result } = renderHook(() => useTraderDetail(null));
    expect(result.current.loading).toBe(false);
    expect(result.current.positions).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches positions for a real address and exposes them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, state: { positions: [pos()], accountValueUsd: 12000, stale: false } }),
    })) as unknown as typeof fetch);

    const { result } = renderHook(() => useTraderDetail('0xabc'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.positions).toHaveLength(1);
    expect(result.current.positions[0].coin).toBe('ETH');
    expect(result.current.accountValueUsd).toBe(12000);
    expect(result.current.error).toBeNull();
  });

  it('surfaces an HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Invalid Hyperliquid address' }),
    })) as unknown as typeof fetch);

    const { result } = renderHook(() => useTraderDetail('0xbad'));
    await waitFor(() => expect(result.current.error).toBe('Invalid Hyperliquid address'));
    expect(result.current.loading).toBe(false);
  });

  it('surfaces a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch);

    const { result } = renderHook(() => useTraderDetail('0xabc'));
    await waitFor(() => expect(result.current.error).toMatch(/network error/i));
  });

  it('marks a stale-cache result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, state: { positions: [pos()], accountValueUsd: 1, stale: true } }),
    })) as unknown as typeof fetch);

    const { result } = renderHook(() => useTraderDetail('0xabc'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.stale).toBe(true);
  });
});
