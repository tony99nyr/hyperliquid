import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _clearHlMemo, _clearInFlight } from '@/lib/hyperliquid/hl-cached-transport';
import { fetchClearinghouseState } from '@/lib/hyperliquid/hyperliquid-info-service';

const ADDRESS = '0x7Ca0E770911DBf68EdC3b8B12829b272A1b4C177';

beforeEach(() => {
  _clearHlMemo();
  _clearInFlight();
});
afterEach(() => vi.unstubAllGlobals());

describe('clearinghouse unrealised P&L', () => {
  it('preserves malformed P&L as null instead of converting it to zero', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        marginSummary: { accountValue: '1000' },
        assetPositions: [
          { position: { coin: 'ETH', szi: '1', unrealizedPnl: 'bad' } },
          { position: { coin: 'BTC', szi: '-1', unrealizedPnl: '-12.5' } },
          { position: { coin: 'SOL', szi: '1', unrealizedPnl: '100junk' } },
          { position: { coin: 'DOGE', szi: '1', unrealizedPnl: '0' } },
        ],
      }),
    } as Response));

    const state = await fetchClearinghouseState(ADDRESS, { uncached: true });
    expect(state.positions.map((position) => position.unrealizedPnl)).toEqual([0, -12.5, 0, 0]);
    expect(state.positions.map((position) => position.unrealizedPnlValid)).toEqual([false, true, false, true]);
  });
});
