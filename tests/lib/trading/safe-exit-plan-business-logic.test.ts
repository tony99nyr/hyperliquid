/**
 * Pins the PURE Safe-Exit PLAN selector. The smart plan must:
 *   - choose MARKET when health is adverse/urgent OR the book is thin (out > price),
 *   - choose LIMIT at the favorable side when calm AND the book is deep (min slippage),
 *   - return null when flat,
 *   - ALWAYS be reduce-only + opposite-side + full size (never opens/flips).
 */

import { describe, it, expect } from 'vitest';
import {
  buildBestExitPlan,
  isHealthAdverse,
  favorableLimitPx,
  topLevelDepth,
  type ExitPlanHealthContext,
} from '@/lib/trading/safe-exit-plan-business-logic';
import type { Position } from '@/types/position';
import type { L2Book } from '@/lib/hyperliquid/orderbook-match';

const base = { clientIntentId: 'cid-1', sessionId: 'sess-1', now: 1_000 };

function pos(over: Partial<Position> = {}): Position {
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

/** A deep book: top level absorbs far more than the position size. */
function deepBook(over: Partial<L2Book> = {}): L2Book {
  return {
    coin: 'ETH',
    bids: [
      { px: 1999, sz: 100 },
      { px: 1998, sz: 100 },
    ],
    asks: [
      { px: 2001, sz: 100 },
      { px: 2002, sz: 100 },
    ],
    ...over,
  };
}

/** A thin book: top level can't absorb the position size. */
function thinBook(): L2Book {
  return {
    coin: 'ETH',
    bids: [{ px: 1999, sz: 0.1 }],
    asks: [{ px: 2001, sz: 0.1 }],
  };
}

const calm: ExitPlanHealthContext = { score: 80, pAdverse: 0.1, alerts: [] };
const urgent: ExitPlanHealthContext = { score: 20, pAdverse: 0.8, alerts: ['decline-detected'] };

describe('isHealthAdverse', () => {
  it('low score is adverse', () => {
    expect(isHealthAdverse({ score: 40, pAdverse: 0.1, alerts: [] }, 45, 0.55)).toBe(true);
  });
  it('high P(adverse) is adverse', () => {
    expect(isHealthAdverse({ score: 90, pAdverse: 0.6, alerts: [] }, 45, 0.55)).toBe(true);
  });
  it('an urgent alert is adverse even when score/pAdverse are calm', () => {
    expect(isHealthAdverse({ score: 90, pAdverse: 0.1, alerts: ['stop-within-1-ATR'] }, 45, 0.55)).toBe(true);
  });
  it('calm across the board is not adverse', () => {
    expect(isHealthAdverse(calm, 45, 0.55)).toBe(false);
  });
});

describe('favorableLimitPx / topLevelDepth', () => {
  it('long rests at the best bid; depth is the bid size', () => {
    const p = pos({ side: 'long' });
    expect(favorableLimitPx(p, deepBook())).toBe(1999);
    expect(topLevelDepth(p, deepBook())).toBe(100);
  });
  it('short rests at the best ask; depth is the ask size', () => {
    const p = pos({ side: 'short' });
    expect(favorableLimitPx(p, deepBook())).toBe(2001);
    expect(topLevelDepth(p, deepBook())).toBe(100);
  });
  it('missing side → null limit / 0 depth', () => {
    const p = pos({ side: 'long' });
    expect(favorableLimitPx(p, { coin: 'ETH', bids: [], asks: deepBook().asks })).toBeNull();
    expect(topLevelDepth(p, { coin: 'ETH', bids: [], asks: deepBook().asks })).toBe(0);
  });
});

describe('buildBestExitPlan', () => {
  it('LONG + calm + deep book → LIMIT reduce-only SELL at the best bid', () => {
    const plan = buildBestExitPlan(pos({ side: 'long', sz: 2 }), deepBook(), calm, base);
    expect(plan).not.toBeNull();
    expect(plan!.style).toBe('limit');
    expect(plan!.intent.side).toBe('sell');
    expect(plan!.intent.sz).toBe(2);
    expect(plan!.intent.limitPx).toBe(1999); // best bid
    expect(plan!.intent.reduceOnly).toBe(true);
    expect(plan!.isFallback).toBe(false);
  });

  it('SHORT + calm + deep book → LIMIT reduce-only BUY at the best ask', () => {
    const plan = buildBestExitPlan(pos({ side: 'short', sz: 1.5 }), deepBook(), calm, base);
    expect(plan!.style).toBe('limit');
    expect(plan!.intent.side).toBe('buy');
    expect(plan!.intent.sz).toBe(1.5);
    expect(plan!.intent.limitPx).toBe(2001); // best ask
    expect(plan!.intent.reduceOnly).toBe(true);
  });

  it('urgent health → MARKET reduce-only (no limitPx), even on a deep book', () => {
    const plan = buildBestExitPlan(pos({ side: 'long', sz: 2 }), deepBook(), urgent, base);
    expect(plan!.style).toBe('market');
    expect(plan!.intent.side).toBe('sell');
    expect(plan!.intent.limitPx).toBeUndefined();
    expect(plan!.intent.reduceOnly).toBe(true);
  });

  it('thin book → MARKET reduce-only even when calm (a limit might not fill)', () => {
    const plan = buildBestExitPlan(pos({ side: 'long', sz: 2 }), thinBook(), calm, base);
    expect(plan!.style).toBe('market');
    expect(plan!.intent.limitPx).toBeUndefined();
    expect(plan!.intent.reduceOnly).toBe(true);
  });

  it('flat → null (nothing to exit)', () => {
    expect(buildBestExitPlan(pos({ side: 'flat', sz: 0 }), deepBook(), calm, base)).toBeNull();
  });

  it('zero size → null', () => {
    expect(buildBestExitPlan(pos({ side: 'long', sz: 0 }), deepBook(), calm, base)).toBeNull();
  });

  it('reduceOnly is ALWAYS true and side is ALWAYS opposite (never opens/flips)', () => {
    for (const side of ['long', 'short'] as const) {
      for (const h of [calm, urgent]) {
        const plan = buildBestExitPlan(pos({ side, sz: 2 }), deepBook(), h, base);
        expect(plan!.intent.reduceOnly).toBe(true);
        expect(plan!.intent.side).toBe(side === 'long' ? 'sell' : 'buy');
        expect(plan!.intent.sz).toBe(2);
      }
    }
  });

  it('passes through the idempotency key, session, coin and timestamp', () => {
    const plan = buildBestExitPlan(pos({ coin: 'BTC' }), deepBook({ coin: 'BTC' }), calm, base);
    expect(plan!.intent.clientIntentId).toBe('cid-1');
    expect(plan!.intent.sessionId).toBe('sess-1');
    expect(plan!.intent.coin).toBe('BTC');
    expect(plan!.intent.createdAt).toBe(1_000);
  });
});
