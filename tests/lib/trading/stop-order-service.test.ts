import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  submitBracket: vi.fn(),
  fetchOpenOrders: vi.fn(),
  fetchPerpMeta: vi.fn(),
}));
vi.mock('@/lib/env/mode', () => ({ getTradingMode: () => 'live' }));
vi.mock('@/lib/auto-exit/auto-exit-config', () => ({ getHlAccountAddress: () => '0x1111111111111111111111111111111111111111' }));
vi.mock('@/lib/env/env', () => ({ validateEnv: () => ({ HL_NETWORK: 'mainnet' }) }));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({ fetchOpenOrders: h.fetchOpenOrders, fetchPerpMeta: h.fetchPerpMeta }));
vi.mock('@/lib/hyperliquid/hyperliquid-exchange-service', () => ({ submitBracket: h.submitBracket }));

import { placeBracketOnHl } from '@/lib/trading/stop-order-service';

const restingStop = {
  coin: 'ETH', oid: 73, side: 'A', sz: 1.5, triggerPx: 1900,
  isTrigger: true, reduceOnly: true, orderType: 'Stop Market',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.fetchOpenOrders.mockResolvedValueOnce([]).mockResolvedValueOnce([restingStop]);
  h.fetchPerpMeta.mockResolvedValue([{ name: 'ETH', szDecimals: 4 }]);
});

describe('placeBracketOnHl', () => {
  it('reads back a resting stop when HL accepts grouped legs without order IDs', async () => {
    h.submitBracket.mockResolvedValue({ stopOid: null, tpOid: null });
    await expect(placeBracketOnHl('ETH', 1900, 2200, 1.5, 'long')).resolves.toEqual({
      pushed: true, stopOid: 73, tpOid: null,
    });
    expect(h.fetchOpenOrders).toHaveBeenCalledTimes(2);
  });

  it('uses a returned stop order ID without a second read', async () => {
    h.submitBracket.mockResolvedValue({ stopOid: 71, tpOid: 72 });
    await expect(placeBracketOnHl('ETH', 1900, 2200, 1.5, 'long')).resolves.toEqual({
      pushed: true, stopOid: 71, tpOid: 72,
    });
    expect(h.fetchOpenOrders).toHaveBeenCalledOnce();
  });

  it('keeps an unconfirmed stop unconfirmed', async () => {
    h.submitBracket.mockResolvedValue({ stopOid: null, tpOid: null });
    h.fetchOpenOrders.mockReset().mockResolvedValue([]);
    await expect(placeBracketOnHl('ETH', 1900, 2200, 1.5, 'long')).resolves.toEqual({
      pushed: true, stopOid: null, tpOid: null,
    });
  });

  it('does not confirm a filled stop oid when no new stop rests', async () => {
    h.submitBracket.mockResolvedValue({ stopOid: null, tpOid: 72 });
    h.fetchOpenOrders.mockReset().mockResolvedValue([]);
    await expect(placeBracketOnHl('ETH', 1900, 2200, 1.5, 'long')).resolves.toEqual({
      pushed: true, stopOid: null, tpOid: 72,
    });
  });

  it('does not confirm an old stop that predated the bracket', async () => {
    h.submitBracket.mockResolvedValue({ stopOid: null, tpOid: null });
    h.fetchOpenOrders.mockReset().mockResolvedValue([restingStop]);
    await expect(placeBracketOnHl('ETH', 1900, 2200, 1.5, 'long')).resolves.toEqual({
      pushed: true, stopOid: null, tpOid: null,
    });
  });

  it('finds the new stop when an older stop also remains open', async () => {
    h.submitBracket.mockResolvedValue({ stopOid: null, tpOid: null });
    const older = { ...restingStop, oid: 72 };
    h.fetchOpenOrders.mockReset().mockResolvedValueOnce([older]).mockResolvedValueOnce([older, restingStop]);
    await expect(placeBracketOnHl('ETH', 1900, 2200, 1.5, 'long')).resolves.toEqual({
      pushed: true, stopOid: 73, tpOid: null,
    });
  });

  it('matches the exchange-rounded stop price and size', async () => {
    h.submitBracket.mockResolvedValue({ stopOid: null, tpOid: null });
    h.fetchOpenOrders.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...restingStop, triggerPx: 1900.1 }]);
    await expect(placeBracketOnHl('ETH', 1900.06, 2200, 1.50009, 'long')).resolves.toEqual({
      pushed: true, stopOid: 73, tpOid: null,
    });
  });

  it('does not confirm a new order with the wrong protective side', async () => {
    h.submitBracket.mockResolvedValue({ stopOid: null, tpOid: null });
    h.fetchOpenOrders.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...restingStop, side: 'B' }]);
    await expect(placeBracketOnHl('ETH', 1900, 2200, 1.5, 'long')).resolves.toEqual({
      pushed: true, stopOid: null, tpOid: null,
    });
  });

  it.each([
    { field: 'triggerPx', stop: { triggerPx: 1910 } },
    { field: 'sz', stop: { sz: 1.4 } },
  ])('does not confirm a new order with the wrong $field', async ({ stop }) => {
    h.submitBracket.mockResolvedValue({ stopOid: null, tpOid: null });
    h.fetchOpenOrders.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...restingStop, ...stop }]);
    await expect(placeBracketOnHl('ETH', 1900, 2200, 1.5, 'long')).resolves.toEqual({
      pushed: true, stopOid: null, tpOid: null,
    });
  });

  it('does not submit a bracket when the prior stop snapshot is unreadable', async () => {
    h.fetchOpenOrders.mockReset().mockRejectedValue(new Error('HL read failed'));
    await expect(placeBracketOnHl('ETH', 1900, 2200, 1.5, 'long')).rejects.toThrow('HL read failed');
    expect(h.submitBracket).not.toHaveBeenCalled();
  });
});
