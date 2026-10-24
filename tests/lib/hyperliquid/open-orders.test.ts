import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOpenOrders } from '@/lib/hyperliquid/hyperliquid-info-service';

const address = '0x' + 'a'.repeat(40);

afterEach(() => vi.unstubAllGlobals());

describe('fetchOpenOrders', () => {
  it('throws when HL returns a non-array payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ error: 'unavailable' }),
    } as Response));
    await expect(fetchOpenOrders(address)).rejects.toThrow('frontendOpenOrders');
  });

  it('preserves the position TP/SL flag on a resting stop', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => [{
        coin: 'ETH', oid: 73, side: 'A', sz: '0', triggerPx: '1900',
        isTrigger: true, reduceOnly: true, orderType: 'Stop Market', isPositionTpsl: true,
      }],
    } as Response));
    await expect(fetchOpenOrders(address)).resolves.toEqual([expect.objectContaining({
      sz: 0, isPositionTpsl: true,
    })]);
  });
});
