import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { L2Book } from '@/lib/hyperliquid/orderbook-match';
import type { TradeIntent } from '@/types/fill';

// Mock the fresh-book fetch the paper source depends on (I/O boundary).
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({
  fetchL2Book: vi.fn(),
}));

import { fetchL2Book } from '@/lib/hyperliquid/hyperliquid-info-service';
import { paperFill } from '@/lib/trading/fill-source-paper';
import { HL_TAKER_FEE_BPS } from '@/lib/trading/paper-fee-model';
import { nextPosition } from '@/lib/trading/position-tracker';

const mockedFetchL2Book = vi.mocked(fetchL2Book);

const book: L2Book = {
  coin: 'ETH',
  asks: [
    { px: 2000, sz: 1 },
    { px: 2001, sz: 2 },
    { px: 2005, sz: 5 },
  ],
  bids: [
    { px: 1999, sz: 1 },
    { px: 1998, sz: 2 },
    { px: 1990, sz: 5 },
  ],
};

const intent = (over: Partial<TradeIntent> = {}): TradeIntent => ({
  clientIntentId: 'intent-1',
  sessionId: 'session-1',
  coin: 'ETH',
  side: 'buy',
  sz: 1,
  reduceOnly: false,
  createdAt: 1_700_000_000_000,
  ...over,
});

describe('paperFill (book-matched paper fill)', () => {
  beforeEach(() => {
    mockedFetchL2Book.mockReset();
    mockedFetchL2Book.mockResolvedValue(book);
  });

  it('market buy fills at the book price with source paper + null HL metadata', async () => {
    const fill = await paperFill(intent({ sz: 1 }));
    expect(fill.px).toBe(2000);
    expect(fill.sz).toBe(1);
    expect(fill.notionalUsd).toBe(2000);
    expect(fill.partial).toBe(false);
    expect(fill.source).toBe('paper');
    expect(fill.hlOrderId).toBeNull();
    expect(fill.hlRaw).toBeNull();
    expect(fill.clientIntentId).toBe('intent-1');
  });

  it('volume-weights across levels and charges the taker fee on filled notional', async () => {
    const fill = await paperFill(intent({ sz: 2 }));
    // 1@2000 + 1@2001 = 4001 notional, avg 2000.5
    expect(fill.sz).toBe(2);
    expect(fill.px).toBe(2000.5);
    expect(fill.notionalUsd).toBe(4001);
    expect(fill.feeUsd).toBeCloseTo(4001 * (HL_TAKER_FEE_BPS / 10_000), 9);
  });

  it('flags partial fills on a thin book', async () => {
    mockedFetchL2Book.mockResolvedValue({ coin: 'ETH', asks: [{ px: 2000, sz: 1 }], bids: [] });
    const fill = await paperFill(intent({ sz: 5 }));
    expect(fill.sz).toBe(1);
    expect(fill.partial).toBe(true);
    expect(fill.notionalUsd).toBe(2000);
  });

  it('respects the limit price (no fill above it)', async () => {
    const fill = await paperFill(intent({ sz: 5, limitPx: 2000 }));
    expect(fill.sz).toBe(1); // only the 2000 ask qualifies
    expect(fill.px).toBe(2000);
    expect(fill.partial).toBe(true);
  });

  it('a sell walks bids', async () => {
    const fill = await paperFill(intent({ side: 'sell', sz: 2 }));
    // 1@1999 + 1@1998 → avg 1998.5
    expect(fill.px).toBe(1998.5);
    expect(fill.sz).toBe(2);
  });

  it('fetches a FRESH book on every call (ADR-0001)', async () => {
    await paperFill(intent());
    await paperFill(intent());
    expect(mockedFetchL2Book).toHaveBeenCalledTimes(2);
  });

  it('flows through the identical downstream path (nextPosition) as any fill', async () => {
    const fill = await paperFill(intent({ sz: 2 }));
    const pos = nextPosition(undefined, fill);
    expect(pos.coin).toBe('ETH');
    expect(pos.side).toBe('long');
    expect(pos.sz).toBe(2);
    expect(pos.avgEntryPx).toBe(2000.5);
    expect(pos.feesPaidUsd).toBeCloseTo(fill.feeUsd, 9);
  });
});
