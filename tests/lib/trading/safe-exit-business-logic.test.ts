/**
 * Pins the PURE Safe-Exit math: the dead-man's-switch fallback intent must
 * always be a reduce-only, opposite-side, MARKET full close — long→sell,
 * short→buy, flat→null — and the freshness check must gate fresh vs stale plans.
 */

import { describe, it, expect } from 'vitest';
import {
  buildMarketReduceOnlyClose,
  isPlanFresh,
  DEFAULT_SAFE_EXIT_STALENESS_MS,
} from '@/lib/trading/safe-exit-business-logic';
import type { Position } from '@/types/position';

const base = { clientIntentId: 'cid-1', sessionId: 'sess-1', now: 1_000 };

function pos(over: Partial<Position>): Position {
  return {
    coin: 'ETH',
    side: 'long',
    sz: 2,
    avgEntryPx: 2000,
    realizedPnlUsd: 0,
    feesPaidUsd: 0,
    ...over,
  };
}

describe('buildMarketReduceOnlyClose', () => {
  it('long → reduce-only SELL of the full size, MARKET (no limitPx)', () => {
    const intent = buildMarketReduceOnlyClose(pos({ side: 'long', sz: 2.5 }), base);
    expect(intent).not.toBeNull();
    expect(intent!.side).toBe('sell');
    expect(intent!.sz).toBe(2.5);
    expect(intent!.reduceOnly).toBe(true);
    expect(intent!.limitPx).toBeUndefined(); // market
    expect(intent!.coin).toBe('ETH');
    expect(intent!.clientIntentId).toBe('cid-1');
    expect(intent!.sessionId).toBe('sess-1');
    expect(intent!.createdAt).toBe(1_000);
  });

  it('short → reduce-only BUY of the full size, MARKET', () => {
    const intent = buildMarketReduceOnlyClose(pos({ side: 'short', sz: 1.25 }), base);
    expect(intent!.side).toBe('buy');
    expect(intent!.sz).toBe(1.25);
    expect(intent!.reduceOnly).toBe(true);
    expect(intent!.limitPx).toBeUndefined();
  });

  it('flat → null (nothing to close)', () => {
    expect(buildMarketReduceOnlyClose(pos({ side: 'flat', sz: 0 }), base)).toBeNull();
  });

  it('zero size (even if side is set) → null', () => {
    expect(buildMarketReduceOnlyClose(pos({ side: 'long', sz: 0 }), base)).toBeNull();
  });
});

describe('isPlanFresh', () => {
  const now = 100_000;
  it('a plan updated within the window is fresh', () => {
    expect(isPlanFresh(now - 30_000, now)).toBe(true);
  });
  it('a plan exactly at the window edge is fresh (<=)', () => {
    expect(isPlanFresh(now - DEFAULT_SAFE_EXIT_STALENESS_MS, now)).toBe(true);
  });
  it('a plan older than the window is stale', () => {
    expect(isPlanFresh(now - DEFAULT_SAFE_EXIT_STALENESS_MS - 1, now)).toBe(false);
  });
  it('null / undefined / non-finite is stale', () => {
    expect(isPlanFresh(null, now)).toBe(false);
    expect(isPlanFresh(undefined, now)).toBe(false);
    expect(isPlanFresh(NaN, now)).toBe(false);
  });
  it('respects a custom staleness window', () => {
    expect(isPlanFresh(now - 5_000, now, 4_000)).toBe(false);
    expect(isPlanFresh(now - 3_000, now, 4_000)).toBe(true);
  });
});
