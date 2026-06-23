/**
 * liveFill mapping (Phase 3b): a mocked HL confirmation → the canonical fill.
 * Verifies the live source produces the SAME CanonicalFill shape as paper (only
 * source + HL metadata differ) and folds to the SAME position — the seam
 * guarantee, pinned at the liveFill boundary. The signing/submission itself
 * (submitOrder) is mocked here; it's exercised separately in Phase 3a.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TradeIntent } from '@/types/fill';

// Mock the isolated exchange service so liveFill is tested without any key/network.
const submitOrder = vi.fn();
const submitUpdateLeverage = vi.fn();
vi.mock('@/lib/hyperliquid/hyperliquid-exchange-service', () => ({
  submitOrder: (...args: unknown[]) => submitOrder(...args),
  submitUpdateLeverage: (...args: unknown[]) => submitUpdateLeverage(...args),
}));

import { liveFill } from '@/lib/trading/fill-source-live';
import { nextPosition } from '@/lib/trading/position-tracker';

const intent: TradeIntent = {
  clientIntentId: 'i1',
  sessionId: 's1',
  coin: 'ETH',
  side: 'buy',
  sz: 1.5,
  reduceOnly: false,
  leverage: 5,
  createdAt: 0,
};

beforeEach(() => {
  submitOrder.mockReset();
  submitUpdateLeverage.mockReset();
  submitUpdateLeverage.mockResolvedValue(undefined);
});

describe('liveFill — maps an HL confirmation → CanonicalFill', () => {
  it('full fill: carries intent fields + maps px/sz/notional/fee/oid/raw, source=live', async () => {
    submitOrder.mockResolvedValue({
      avgPx: 2000,
      filledSz: 1.5,
      partial: false,
      feeUsd: 0.75,
      hlOrderId: 'oid-123',
      raw: { oid: 123, status: 'filled' },
    });
    const f = await liveFill(intent);
    expect(f).toMatchObject({
      clientIntentId: 'i1',
      sessionId: 's1',
      coin: 'ETH',
      side: 'buy',
      px: 2000,
      sz: 1.5,
      notionalUsd: 3000,
      feeUsd: 0.75,
      reduceOnly: false,
      partial: false,
      source: 'live',
      hlOrderId: 'oid-123',
    });
    expect(f.hlRaw).toEqual({ oid: 123, status: 'filled' });
    expect(typeof f.filledAt).toBe('number');
  });

  it('partial fill is flagged and uses the filled size', async () => {
    submitOrder.mockResolvedValue({ avgPx: 2001, filledSz: 0.9, partial: true, feeUsd: 0.4, hlOrderId: 'oid-9', raw: {} });
    const f = await liveFill(intent);
    expect(f.partial).toBe(true);
    expect(f.sz).toBe(0.9);
    expect(f.notionalUsd).toBeCloseTo(2001 * 0.9, 6);
  });

  it('zero fill (IOC did not cross / rejected) → sz 0, notional 0', async () => {
    submitOrder.mockResolvedValue({ avgPx: 0, filledSz: 0, partial: true, feeUsd: 0, hlOrderId: 'oid-r', raw: { resting: { oid: 1 } } });
    const f = await liveFill(intent);
    expect(f.sz).toBe(0);
    expect(f.notionalUsd).toBe(0);
    expect(f.source).toBe('live');
  });
});

describe('liveFill — sets leverage on HL for OPENS (the silent-20x fix)', () => {
  it('an OPEN sets the per-coin leverage BEFORE placing the order', async () => {
    submitOrder.mockResolvedValue({ avgPx: 2000, filledSz: 1.5, partial: false, feeUsd: 0.75, hlOrderId: 'oid-1', raw: {} });
    await liveFill(intent); // reduceOnly:false, leverage:5
    expect(submitUpdateLeverage).toHaveBeenCalledWith('ETH', 5, false); // isolated margin
    expect(submitUpdateLeverage).toHaveBeenCalledTimes(1);
  });

  it('a REDUCE-ONLY exit never touches leverage', async () => {
    submitOrder.mockResolvedValue({ avgPx: 2000, filledSz: 1.5, partial: false, feeUsd: 0.75, hlOrderId: 'oid-x', raw: {} });
    await liveFill({ ...intent, reduceOnly: true });
    expect(submitUpdateLeverage).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED: a rejected leverage update aborts the open (order never placed)', async () => {
    submitUpdateLeverage.mockRejectedValue(new Error('updateLeverage rejected'));
    await expect(liveFill(intent)).rejects.toThrow('updateLeverage rejected');
    expect(submitOrder).not.toHaveBeenCalled();
  });
});

describe('liveFill ↔ paper parity (the seam guarantee at the fill boundary)', () => {
  it('a live fill folds to the SAME position as an identical-economics paper fill', async () => {
    submitOrder.mockResolvedValue({ avgPx: 2000, filledSz: 1.5, partial: false, feeUsd: 0.75, hlOrderId: 'oid-1', raw: {} });
    const live = await liveFill(intent);
    // The same economics as a paper fill (only source + HL metadata differ).
    const paperEquivalent = { ...live, source: 'paper' as const, hlOrderId: null, hlRaw: null };
    expect(nextPosition(undefined, live)).toEqual(nextPosition(undefined, paperEquivalent));
  });
});
