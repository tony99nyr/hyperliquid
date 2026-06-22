/**
 * End-to-end seam test: a paper TradeIntent flows
 *   paperFill → persistFill → applyFillToPosition → DB rows
 * identical to the future live path. We mock the I/O boundaries (the fresh
 * l2Book fetch + the Supabase persistence service) and assert executeIntent
 * persists a fill + applies it to a position, with idempotency on a duplicate
 * client_intent_id.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { L2Book } from '@/lib/hyperliquid/orderbook-match';
import type { CanonicalFill, TradeIntent } from '@/types/fill';

// Mock the fresh-book fetch (paper source I/O boundary).
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({
  fetchL2Book: vi.fn(),
}));

// Mock the Supabase persistence service (the DB I/O boundary). The default
// service-role client requires env that isn't present in tests; mocking the
// service keeps the seam test about the FLOW, not Supabase wiring (covered by
// fill-persistence-service.test.ts).
vi.mock('@/lib/cockpit/fill-persistence-service', () => ({
  persistFillRow: vi.fn(),
  applyFillToPositionRows: vi.fn(),
}));

import { fetchL2Book } from '@/lib/hyperliquid/hyperliquid-info-service';
import { persistFillRow, applyFillToPositionRows } from '@/lib/cockpit/fill-persistence-service';
import { executeIntent } from '@/lib/trading/fill-source';

const mockedFetchL2Book = vi.mocked(fetchL2Book);
const mockedPersist = vi.mocked(persistFillRow);
const mockedApply = vi.mocked(applyFillToPositionRows);

const book: L2Book = {
  coin: 'ETH',
  asks: [
    { px: 2000, sz: 1 },
    { px: 2001, sz: 2 },
  ],
  bids: [{ px: 1999, sz: 5 }],
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

describe('executeIntent (paper end-to-end)', () => {
  beforeEach(() => {
    process.env.TRADING_MODE = 'paper';
    mockedFetchL2Book.mockReset();
    mockedFetchL2Book.mockResolvedValue(book);
    mockedPersist.mockReset();
    mockedPersist.mockResolvedValue(true);
    mockedApply.mockReset();
    mockedApply.mockResolvedValue({
      coin: 'ETH',
      side: 'long',
      sz: 1,
      avgEntryPx: 2000,
      realizedPnlUsd: 0,
      feesPaidUsd: 0.7,
    });
  });

  it('produces a paper CanonicalFill and persists + applies it', async () => {
    const fill = await executeIntent(intent({ sz: 1 }));

    // Paper fill from the fresh book (px carries realism slippage → adverse of best).
    expect(fill.source).toBe('paper');
    expect(fill.px).toBeGreaterThanOrEqual(2000);
    expect(fill.px).toBeLessThan(2000 * 1.01);
    expect(fill.sz).toBe(1);
    expect(fill.hlOrderId).toBeNull();
    expect(fill.clientIntentId).toBe('intent-1');

    // Both downstream steps ran with the SAME canonical fill (mode-unaware).
    expect(mockedPersist).toHaveBeenCalledTimes(1);
    expect(mockedApply).toHaveBeenCalledTimes(1);
    const persistedFill = mockedPersist.mock.calls[0][0] as CanonicalFill;
    const appliedFill = mockedApply.mock.calls[0][0] as CanonicalFill;
    expect(persistedFill).toEqual(fill);
    expect(appliedFill).toEqual(fill);
  });

  it('is idempotent on a duplicate client_intent_id (persist no-op; apply re-folds ledger)', async () => {
    // Second run: the fills row already exists → persist reports no-op (false).
    mockedPersist.mockResolvedValue(false);
    const fill = await executeIntent(intent());
    expect(fill.clientIntentId).toBe('intent-1');
    // executeIntent does not throw on a duplicate. The apply step recomputes the
    // position from the WHOLE ledger (which still contains the fill exactly once),
    // so re-running cannot double-count — this is the C1/C2 fix.
    expect(mockedPersist).toHaveBeenCalledTimes(1);
    expect(mockedApply).toHaveBeenCalledTimes(1);
  });

  it('threads the OPENING intent leverage to applyFillToPosition (drives ROE)', async () => {
    await executeIntent(intent({ sz: 1, leverage: 5 }));
    // 2nd positional arg = leverage metadata (fold stays leverage-agnostic).
    expect(mockedApply.mock.calls[0][1]).toBe(5);
  });

  it('does NOT pass leverage on a reduce-only exit (preserves the entry leverage)', async () => {
    // A reduce-only order needs an existing position to reduce; the book has bids.
    await executeIntent(intent({ sz: 1, side: 'sell', reduceOnly: true, leverage: 5 }));
    expect(mockedApply.mock.calls[0][1]).toBeUndefined();
  });

  it('a fully-unfilled paper order (sz 0) is NOT persisted or applied (retry stays possible)', async () => {
    // Empty book → matchIntentAgainstBook returns nothing filled.
    mockedFetchL2Book.mockResolvedValue({ coin: 'ETH', asks: [], bids: [] });
    const fill = await executeIntent(intent({ sz: 1 }));
    expect(fill.sz).toBe(0);
    expect(fill.px).toBe(0);
    // Neither persist nor apply ran — the client_intent_id is not burned.
    expect(mockedPersist).not.toHaveBeenCalled();
    expect(mockedApply).not.toHaveBeenCalled();
  });
});
