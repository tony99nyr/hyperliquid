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

  // NOTE: fills now carry realism (adverse slippage on the matched VWAP), so the
  // recorded px is WORSE than the raw book VWAP — buys fill higher, sells lower.
  // The exact slippage math is pinned in paper-fill-realism.test.ts; here we
  // verify the matching mechanics + the adverse DIRECTION + internal consistency.
  it('market buy fills at-or-above the book best (adverse), source paper + null HL metadata', async () => {
    const fill = await paperFill(intent({ sz: 1 }));
    expect(fill.px).toBeGreaterThanOrEqual(2000); // buy fills adverse (≥ best ask)
    expect(fill.px).toBeLessThan(2000 * 1.01); // but only by slippage
    expect(fill.sz).toBe(1);
    expect(fill.notionalUsd).toBeCloseTo(fill.px * fill.sz, 6);
    expect(fill.partial).toBe(false);
    expect(fill.source).toBe('paper');
    expect(fill.hlOrderId).toBeNull();
    expect(fill.hlRaw).toBeNull();
    expect(fill.clientIntentId).toBe('intent-1');
  });

  it('volume-weights across levels (adverse of the 2000.5 VWAP) and fees on filled notional', async () => {
    const fill = await paperFill(intent({ sz: 2 }));
    expect(fill.sz).toBe(2);
    expect(fill.px).toBeGreaterThan(2000.5); // adverse of the 2000.5 matched VWAP
    expect(fill.notionalUsd).toBeCloseTo(fill.px * fill.sz, 6);
    expect(fill.feeUsd).toBeCloseTo(fill.notionalUsd * (HL_TAKER_FEE_BPS / 10_000), 9);
  });

  it('flags partial fills on a thin book', async () => {
    mockedFetchL2Book.mockResolvedValue({ coin: 'ETH', asks: [{ px: 2000, sz: 1 }], bids: [] });
    const fill = await paperFill(intent({ sz: 5 }));
    expect(fill.sz).toBe(1);
    expect(fill.partial).toBe(true);
    expect(fill.notionalUsd).toBeCloseTo(fill.px * 1, 6);
  });

  it('respects the limit price (only the qualifying level matches)', async () => {
    const fill = await paperFill(intent({ sz: 5, limitPx: 2000 }));
    expect(fill.sz).toBe(1); // only the 2000 ask qualifies the match
    expect(fill.partial).toBe(true);
  });

  it('a sell walks bids (adverse of the 1998.5 VWAP)', async () => {
    const fill = await paperFill(intent({ side: 'sell', sz: 2 }));
    expect(fill.px).toBeLessThan(1998.5); // sell fills adverse (lower)
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
    expect(pos.avgEntryPx).toBeCloseTo(fill.px, 6); // position carries the realized fill px
    expect(pos.feesPaidUsd).toBeCloseTo(fill.feeUsd, 9);
  });
});
