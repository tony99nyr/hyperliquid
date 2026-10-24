import { beforeEach, describe, expect, it, vi } from 'vitest';

const getServiceRoleClient = vi.fn();
const getHlAccountAddress = vi.fn();
const fetchSpotUsdcBalance = vi.fn();
const fetchClearinghouseState = vi.fn();

vi.mock('@/lib/cockpit/supabase-server', () => ({ getServiceRoleClient: (...args: unknown[]) => getServiceRoleClient(...args) }));
vi.mock('@/lib/auto-exit/auto-exit-config', () => ({ getHlAccountAddress: (...args: unknown[]) => getHlAccountAddress(...args) }));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({
  fetchSpotUsdcBalance: (...args: unknown[]) => fetchSpotUsdcBalance(...args),
  fetchClearinghouseState: (...args: unknown[]) => fetchClearinghouseState(...args),
}));

import { checkCircuitBreaker, computeLiveEquityBreakdown } from '@/lib/risk/circuit-breaker-service';

beforeEach(() => {
  vi.clearAllMocks();
  getServiceRoleClient.mockReturnValue({});
  getHlAccountAddress.mockReturnValue('0xabc');
  fetchSpotUsdcBalance.mockResolvedValue(1000);
});

describe('live equity validation', () => {
  it('rejects a null P&L before a live entry can pass the breaker', async () => {
    fetchClearinghouseState.mockResolvedValue({ stale: false, positions: [{ coin: 'ETH', unrealizedPnl: null }] });
    await expect(computeLiveEquityBreakdown()).rejects.toThrow('invalid unrealised P&L for ETH');
    await expect(checkCircuitBreaker('live')).rejects.toThrow('invalid unrealised P&L for ETH');
  });

  it('computeLiveEquityBreakdown_rejectsInvalidUpnl', async () => {
    fetchClearinghouseState.mockResolvedValueOnce({ stale: false, positions: [
      { coin: 'ETH', size: 0.4, unrealizedPnl: -120.5 },
      { coin: 'BTC', size: 0.1, unrealizedPnl: 20.25 },
    ] });
    await expect(computeLiveEquityBreakdown()).resolves.toEqual({ spotUsd: 1000, upnlUsd: -100.25, totalUsd: 899.75 });
    fetchClearinghouseState.mockResolvedValue({ stale: false, positions: [{ coin: 'ETH', size: '0.4', unrealizedPnl: 'NaN' }] });
    await expect(computeLiveEquityBreakdown()).rejects.toThrow('invalid');
    await expect(checkCircuitBreaker('live')).rejects.toThrow('invalid');
  });
});
