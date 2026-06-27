/**
 * fetchAccountRisk — maps the operator's HL clearinghouse positions into per-coin
 * real liquidation + effective leverage (reflecting posted margin). Empty without an
 * account address (paper / unset).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';

const getHlAccountAddress = vi.fn();
const fetchClearinghouseState = vi.fn();

vi.mock('@/lib/auto-exit/auto-exit-config', () => ({ getHlAccountAddress: () => getHlAccountAddress() }));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({ fetchClearinghouseState: (...a: unknown[]) => fetchClearinghouseState(...a) }));

import { fetchAccountRisk } from '@/lib/trading/account-risk-service';

function pos(over: Partial<HlPosition>): HlPosition {
  return {
    coin: 'ETH', side: 'short', szi: -0.7577, size: 0.7577, entryPx: 1571.94, positionValue: 1198,
    unrealizedPnl: 0, returnOnEquity: null, leverage: 5, leverageType: 'isolated', liquidationPx: 2658.36,
    marginUsed: 856.83, maxLeverage: 25, ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getHlAccountAddress.mockReturnValue('0x7Ca0E770911DBf68EdC3b8B12829b272A1b4C177');
  fetchClearinghouseState.mockResolvedValue({ positions: [pos({})], accountValueUsd: 900 });
});

describe('fetchAccountRisk', () => {
  it('returns {} when there is no account address (paper / unset)', async () => {
    getHlAccountAddress.mockReturnValue(undefined);
    expect(await fetchAccountRisk()).toEqual({});
    expect(fetchClearinghouseState).not.toHaveBeenCalled();
  });

  it('maps real liq + effective leverage (notional / margin), reflecting posted margin', async () => {
    const r = await fetchAccountRisk();
    expect(r.ETH.liqPx).toBe(2658.36);
    expect(r.ETH.marginUsed).toBeCloseTo(856.83);
    expect(r.ETH.effLeverage).toBeCloseTo(1198 / 856.83, 4); // ≈1.40x — not the 5x setting
  });

  it('skips flat (szi 0) positions and uses an uncached read', async () => {
    fetchClearinghouseState.mockResolvedValue({ positions: [pos({ coin: 'BTC', szi: 0, size: 0 })], accountValueUsd: 900 });
    expect(await fetchAccountRisk()).toEqual({});
    expect(fetchClearinghouseState).toHaveBeenCalledWith(expect.any(String), { uncached: true });
  });

  it('effLeverage is null when margin is zero', async () => {
    fetchClearinghouseState.mockResolvedValue({ positions: [pos({ marginUsed: 0 })], accountValueUsd: 900 });
    expect((await fetchAccountRisk()).ETH.effLeverage).toBeNull();
  });
});
